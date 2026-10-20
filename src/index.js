// Two-Seat Cinema — Worker: static assets + /api/* backed by D1, Workers AI and RapidAPI.
// Identity comes from Cloudflare Access (email one-time code). Nothing here stores email addresses
// beyond what Access tells us about the signed-in viewer.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS people (uid TEXT PRIMARY KEY, name TEXT, updated INTEGER)`,
  `CREATE TABLE IF NOT EXISTS marks (uid TEXT, mid INTEGER, s TEXT, st INTEGER, at INTEGER, PRIMARY KEY (uid, mid))`,
  `CREATE TABLE IF NOT EXISTS nights (id INTEGER PRIMARY KEY AUTOINCREMENT, mid INTEGER, at INTEGER, by TEXT, vetoes INTEGER, done INTEGER DEFAULT 0, watched INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS duel (id INTEGER PRIMARY KEY CHECK (id = 1), cards TEXT, at INTEGER, by TEXT)`,
  `CREATE TABLE IF NOT EXISTS duel_votes (uid TEXT, mid INTEGER, yes INTEGER, PRIMARY KEY (uid, mid))`,
  `CREATE TABLE IF NOT EXISTS inbox (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, link TEXT, by TEXT, at INTEGER, details TEXT, status TEXT)`,
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER)`,
];
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((q) => db.prepare(q)));
  schemaReady = true;
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const bad = (msg, status = 400) => json({ error: msg }, status);

// ---------- identity ----------
let jwksCache = null;
function b64url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
async function verifyAccessJwt(token, env) {
  const [h, p, sig] = token.split(".");
  if (!sig) return null;
  const header = JSON.parse(new TextDecoder().decode(b64url(h)));
  const payload = JSON.parse(new TextDecoder().decode(b64url(p)));
  if (!jwksCache || jwksCache.at < Date.now() - 3600e3) {
    const r = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
    jwksCache = { at: Date.now(), keys: (await r.json()).keys };
  }
  const jwk = jwksCache.keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(sig), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) return null;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (env.ACCESS_AUD && !aud.includes(env.ACCESS_AUD)) return null;
  if (payload.exp && payload.exp * 1000 < Date.now()) return null;
  return payload.email ? String(payload.email).toLowerCase() : null;
}
async function whoAmI(req, env) {
  // Local development: `wrangler dev` with DEV_USER set in .dev.vars.
  if (env.DEV_USER) return req.headers.get("x-dev-user") || env.DEV_USER;
  const token = req.headers.get("cf-access-jwt-assertion");
  if (!token || !env.ACCESS_TEAM_DOMAIN) return null;
  try { return await verifyAccessJwt(token, env); } catch { return null; }
}

// ---------- helpers ----------
async function bump(db) {
  await db.prepare(`INSERT INTO meta (k, v) VALUES ('version', 1) ON CONFLICT(k) DO UPDATE SET v = v + 1`).run();
}
async function version(db) {
  const r = await db.prepare(`SELECT v FROM meta WHERE k = 'version'`).first();
  return r ? r.v : 0;
}
async function body(req) {
  try { return await req.json(); } catch { return {}; }
}
const clip = (s, n) => String(s ?? "").slice(0, n);

// ---------- RapidAPI lookup (Streaming Availability, India) ----------
const norm = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "");
async function lookup(title, env) {
  if (!env.RAPIDAPI_KEY) return null;
  const host = "streaming-availability.p.rapidapi.com";
  const q = new URLSearchParams({ title, country: "in", show_type: "movie", output_language: "en" });
  const r = await fetch(`https://${host}/shows/search/title?${q}`, { headers: { "x-rapidapi-key": env.RAPIDAPI_KEY, "x-rapidapi-host": host } });
  if (!r.ok) return null;
  const list = await r.json();
  if (!Array.isArray(list) || !list.length) return null;
  const n = norm(title);
  const score = (x) => (norm(x.title) === n || norm(x.originalTitle) === n ? 100 : 0) + (x.rating || 0) / 10 + (x.streamingOptions?.in?.length ? 5 : 0);
  const b = list.reduce((a, x) => (score(x) > score(a) ? x : a), list[0]);
  const svc = {};
  for (const o of b.streamingOptions?.in || []) {
    const rank = { subscription: 0, free: 0, addon: 1, rent: 2, buy: 3 }[o.type] ?? 4;
    const k = o.service.id;
    if (!svc[k] || rank < svc[k]._r) svc[k] = { id: k, name: o.service.name, type: o.type, link: o.link, color: o.service.themeColorCode, _r: rank };
  }
  return {
    matched: true, title: b.title, orig: b.originalTitle !== b.title ? b.originalTitle : null, year: b.releaseYear, runtime: b.runtime || null,
    rating: b.rating || null, genres: (b.genres || []).map((g) => g.name), directors: (b.directors || []).slice(0, 2), cast: (b.cast || []).slice(0, 5),
    overview: b.overview || "", imdb: b.imdbId || null, poster: b.imageSet?.verticalPoster?.w360 || null, lang: [],
    stream: Object.values(svc).map(({ _r, ...v }) => v),
  };
}

// ---------- Workers AI pick ----------
async function ask(env, q, candidates) {
  const lines = candidates.slice(0, 150).map((m) => `${m.id}|${clip(m.title, 80)}|${m.year || ""}|${(m.genres || []).join("/")}|${m.runtime || "?"}m|${clip(m.overview, 90)}`).join("\n");
  const prompt = `Two friends want to pick a film tonight. Their request: "${clip(q, 200)}"
Choose exactly one film from this list (id|title|year|genres|runtime|synopsis). Only pick from the list.
${lines}
Reply with JSON only, no other text: {"id": <number from the list>, "why": "<one short, warm sentence to them, max 20 words>"}`;
  const models = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct"];
  for (const model of models) {
    try {
      const out = await env.AI.run(model, { messages: [{ role: "user", content: prompt }], max_tokens: 120 });
      const text = typeof out === "string" ? out : out.response ?? JSON.stringify(out);
      const m = String(text).match(/\{[\s\S]*\}/);
      if (!m) continue;
      const pick = JSON.parse(m[0]);
      if (candidates.some((c) => c.id === Number(pick.id))) return { id: Number(pick.id), why: clip(pick.why, 160) };
    } catch {}
  }
  return null;
}

// ---------- state ----------
async function state(db, me) {
  const [people, marks, nights, duel, votes, inbox] = await db.batch([
    db.prepare(`SELECT uid, name FROM people`),
    db.prepare(`SELECT uid, mid, s, st, at FROM marks`),
    db.prepare(`SELECT * FROM nights ORDER BY at DESC LIMIT 200`),
    db.prepare(`SELECT cards, at, by FROM duel WHERE id = 1`),
    db.prepare(`SELECT uid, mid, yes FROM duel_votes`),
    db.prepare(`SELECT * FROM inbox ORDER BY at DESC LIMIT 200`),
  ]);
  const P = {};
  for (const p of people.results) P[p.uid] = { name: p.name || "", marks: {} };
  for (const m of marks.results) (P[m.uid] ||= { name: "", marks: {} }).marks[m.mid] = { s: m.s || null, st: m.st || 0, at: m.at };
  const d = duel.results[0];
  const duelOut = d ? { cards: JSON.parse(d.cards), at: d.at, by: d.by, votes: {} } : null;
  if (duelOut) for (const v of votes.results) (duelOut.votes[v.uid] ||= {})[v.mid] = !!v.yes;
  return {
    me: { id: me, name: P[me]?.name || "" },
    people: P,
    nights: nights.results.map((n) => ({ ...n, done: !!n.done, watched: !!n.watched })),
    duel: duelOut,
    inbox: inbox.results.map((i) => ({ ...i, details: i.details ? JSON.parse(i.details) : null })),
  };
}

// ---------- router ----------
async function api(req, env, url) {
  const me = await whoAmI(req, env);
  if (!me) return bad("Not signed in", 401);
  const db = env.DB;
  await ensureSchema(db);
  await db.prepare(`INSERT INTO people (uid, name, updated) VALUES (?, '', ?) ON CONFLICT(uid) DO NOTHING`).bind(me, Date.now()).run();
  const path = url.pathname.replace(/^\/api/, "");
  const M = req.method;

  if (path === "/state" && M === "GET") {
    const v = await version(db);
    if (url.searchParams.get("v") === String(v)) return json({ v, same: true });
    return json({ v, ...(await state(db, me)) });
  }
  if (path === "/name" && M === "POST") {
    const { name } = await body(req);
    await db.prepare(`UPDATE people SET name = ?, updated = ? WHERE uid = ?`).bind(clip(name, 40).trim(), Date.now(), me).run();
    await bump(db); return json({ ok: true });
  }
  if (path === "/marks" && M === "POST") {
    const { mid, s, st } = await body(req);
    if (!Number.isInteger(mid)) return bad("mid");
    const sv = ["watched", "want", "nah"].includes(s) ? s : null, stv = Math.max(0, Math.min(5, Number(st) || 0));
    if (!sv && !stv) await db.prepare(`DELETE FROM marks WHERE uid = ? AND mid = ?`).bind(me, mid).run();
    else await db.prepare(`INSERT INTO marks (uid, mid, s, st, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(uid, mid) DO UPDATE SET s = excluded.s, st = excluded.st, at = excluded.at`).bind(me, mid, sv, stv, Date.now()).run();
    await bump(db); return json({ ok: true });
  }
  if (path === "/nights" && M === "POST") {
    const { mid, vetoes } = await body(req);
    if (!Number.isInteger(mid)) return bad("mid");
    const r = await db.prepare(`INSERT INTO nights (mid, at, by, vetoes) VALUES (?, ?, ?, ?)`).bind(mid, Date.now(), me, Math.max(0, Math.min(3, Number(vetoes) || 0))).run();
    await bump(db); return json({ ok: true, id: r.meta.last_row_id });
  }
  const nightMatch = path.match(/^\/nights\/(\d+)$/);
  if (nightMatch && M === "PATCH") {
    const { watched } = await body(req);
    await db.prepare(`UPDATE nights SET done = 1, watched = ? WHERE id = ?`).bind(watched ? 1 : 0, Number(nightMatch[1])).run();
    await bump(db); return json({ ok: true });
  }
  if (path === "/duel" && M === "POST") {
    const { cards } = await body(req);
    if (!Array.isArray(cards) || !cards.length || cards.length > 20 || !cards.every(Number.isInteger)) return bad("cards");
    await db.batch([
      db.prepare(`DELETE FROM duel_votes`),
      db.prepare(`INSERT INTO duel (id, cards, at, by) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET cards = excluded.cards, at = excluded.at, by = excluded.by`).bind(JSON.stringify(cards), Date.now(), me),
    ]);
    await bump(db); return json({ ok: true });
  }
  if (path === "/duel/vote" && M === "POST") {
    const { mid, yes } = await body(req);
    if (!Number.isInteger(mid)) return bad("mid");
    await db.prepare(`INSERT INTO duel_votes (uid, mid, yes) VALUES (?, ?, ?) ON CONFLICT(uid, mid) DO UPDATE SET yes = excluded.yes`).bind(me, mid, yes ? 1 : 0).run();
    await bump(db); return json({ ok: true });
  }
  if (path === "/inbox" && M === "POST") {
    const b = await body(req);
    const title = clip(b.title, 120).trim(), link = /^https?:\/\//i.test(b.link || "") ? clip(b.link, 500) : "";
    if (!title && !link) return bad("Give a title or a link");
    let details = null;
    if (title) { try { details = await lookup(title, env); } catch {} }
    const r = await db.prepare(`INSERT INTO inbox (title, link, by, at, details, status) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(title, link, me, Date.now(), details ? JSON.stringify(details) : null, details ? "found" : "pending").run();
    await bump(db); return json({ ok: true, id: r.meta.last_row_id, found: !!details });
  }
  const inboxMatch = path.match(/^\/inbox\/(\d+)$/);
  if (inboxMatch && M === "PATCH") {
    const { title } = await body(req);
    const t = clip(title, 120).trim(); if (!t) return bad("title");
    let details = null; try { details = await lookup(t, env); } catch {}
    await db.prepare(`UPDATE inbox SET title = ?, details = ?, status = ? WHERE id = ?`).bind(t, details ? JSON.stringify(details) : null, details ? "found" : "pending", Number(inboxMatch[1])).run();
    await bump(db); return json({ ok: true, found: !!details });
  }
  if (inboxMatch && M === "DELETE") {
    await db.prepare(`DELETE FROM inbox WHERE id = ? AND by = ?`).bind(Number(inboxMatch[1]), me).run();
    await bump(db); return json({ ok: true });
  }
  if (path === "/ask" && M === "POST") {
    if (!env.AI) return bad("AI not configured", 503);
    const { q, candidates } = await body(req);
    if (!q || !Array.isArray(candidates) || !candidates.length) return bad("q");
    const pick = await ask(env, q, candidates);
    return pick ? json(pick) : bad("No pick", 502);
  }
  return bad("Not found", 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/img") {
      // Posters for films added through the inbox live on the API's CDN; proxy and cache them here.
      const u = url.searchParams.get("u") || "";
      let target; try { target = new URL(u); } catch { return bad("bad url"); }
      if (target.hostname !== "cdn.movieofthenight.com") return bad("host not allowed", 403);
      const cache = caches.default, key = new Request(target.toString());
      let r = await cache.match(key);
      if (!r) {
        let up;
        try { up = await fetch(target.toString(), { headers: { "user-agent": "Mozilla/5.0 (TwoSeatCinema poster proxy)", accept: "image/*" } }); }
        catch (e) { return bad("upstream fetch failed: " + (e && e.message), 502); }
        if (!up.ok) return bad("upstream " + up.status, 502);
        r = new Response(up.body, { headers: { "content-type": up.headers.get("content-type") || "image/jpeg", "cache-control": "public, max-age=2592000" } });
        await cache.put(key, r.clone());
      }
      return r;
    }
    if (url.pathname.startsWith("/api/")) {
      try { return await api(req, env, url); } catch (e) { return bad("Server error", 500); }
    }
    return env.ASSETS.fetch(req);
  },
};
