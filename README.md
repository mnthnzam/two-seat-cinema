# Two-Seat Cinema

A movie-night app for two people, built from the films we kept talking about on WhatsApp and Instagram. It runs on one Cloudflare Worker at **movies.mnthn.com**:

- **Static app:** everything in `public/` is the app: `index.html`, `data.json` and the posters.
- **API:** `src/index.js` serves `/api/*` and stores state in D1.
- **Inbox lookups:** new films are looked up through RapidAPI's Streaming Availability API.
- **Ask Claude:** the "Ask Claude" box in Tonight uses Workers AI.
- **Sign-in:** Cloudflare Access with an email one-time code. Only the two allowed emails get in.

## One-time setup (Cloudflare dashboard, about 10 minutes)

1. **Create the database.** Go to Storage & Databases → D1 → Create, and name it `two-seat`.
   - Copy its **Database ID** into `wrangler.jsonc` (`database_id`) and push.
   - Tables are created automatically on the first request, so there are no migrations to run.
2. **Connect the repo.** Go to Workers & Pages → Create → Import a repository, and pick `mnthnzam/two-seat-cinema`.
   - Build command: none.
   - Deploy command: `npx wrangler deploy`. This is the same Workers Builds setup as portfolio-site.
   - The custom domain `movies.mnthn.com` comes from `wrangler.jsonc`, so no separate DNS record is needed.
3. **Add the RapidAPI key.** Go to the `two-seat-cinema` Worker → Settings → Variables and Secrets → Add.
   - Type: **Secret**. Name: `RAPIDAPI_KEY`.
   - Use a Secret, not a plain variable: plain vars are overwritten by `wrangler.jsonc` on every deploy.
4. **Set up Access.** Go to Zero Trust → Access → Applications → Add → Self-hosted.
   - Domain: `movies.mnthn.com`. Session: 1 month.
   - Policy: Allow → Emails → your two addresses.
   - Login method: One-time PIN. It's on by default.
   - After saving, copy the app's **Application Audience (AUD) Tag**.
   - Copy your team domain from Zero Trust → Settings → Custom pages; it looks like `something.cloudflareaccess.com`.
5. **Put the Access values in the config.** Paste both into `wrangler.jsonc` → `vars` (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`) and push.
   - These are not secrets.
   - Without them, every `/api` call answers 401 and the app falls back to "offline mode".

## How it works

- **Identity:** the Worker verifies the `Cf-Access-Jwt-Assertion` token on every `/api` call and uses the email inside as the user id.
  - `workers_dev` and preview URLs are off, so the Access-protected domain is the only way in.
- **Sync:** the app polls `/api/state` every 10 seconds while the tab is visible.
  - It sends the last version number. Unchanged state comes back as `{same: true}`, which costs almost nothing.
- **Marks:** one row per person per film (`marks`). Nights, the current duel, duel votes and the inbox each have their own table.
- **Inbox lookups:** a pasted title triggers one RapidAPI call. The free plan allows 1,000 calls a month.
  - A pasted link is saved without a lookup until someone types the film's title on it.
- **Inbox posters:** they come through `/img`, which only proxies `cdn.movieofthenight.com` and caches for 30 days.
- **Ask Claude:** runs on Workers AI (`llama-3.3-70b-instruct-fp8-fast`, falling back to `llama-3.1-8b-instruct`). It stays inside the free daily allowance at this usage.

## Local development

```
npm install
printf 'DEV_USER=you@example.com\nRAPIDAPI_KEY=...\n' > .dev.vars   # gitignored
npx wrangler dev -c wrangler.test.json --local
```

- `DEV_USER` skips Access in local dev only. Send an `x-dev-user` header to act as a second person.
- **Never set `DEV_USER` on the deployed Worker.** It would let anyone act as anyone.
- `wrangler.test.json` is the same config without the custom domain or the AI binding.

## Refreshing the original 208 films

The base pile (`public/data.json`, `public/posters/`) is a snapshot from 20 Oct 2026. It was built with the scripts in the Claude session that made this app. Ask Claude to "refresh the pile" to re-check streaming availability; that uses about 210 RapidAPI calls.
