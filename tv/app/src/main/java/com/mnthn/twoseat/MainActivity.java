package com.mnthn.twoseat;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

/**
 * Two-Seat Cinema for Android TV: a full-screen WebView on movies.mnthn.com.
 * The site switches into TV mode when it sees "TwoSeatTV" in the user agent
 * (arrow-key focus, big focus rings, window.tvBack()).
 * Sign-in is Cloudflare Access email code; its cookie is kept between launches.
 */
public class MainActivity extends Activity {
    private WebView web;

    // Pages the app keeps inside itself. Everything else (Netflix, YouTube, JustWatch) goes to the TV's own apps.
    private static boolean ours(Uri u) {
        String h = u.getHost();
        if (h == null) return false;
        return h.equals("movies.mnthn.com") || h.endsWith(".cloudflareaccess.com");
    }

    // On Cloudflare's sign-in page there's no TV mode, so give the remote something to hold:
    // focus the email/code field and let Up/Down walk the fields and buttons in page order.
    private static final String ACCESS_HELPER =
        "(function(){if(window.__tsTv)return;window.__tsTv=1;" +
        "var q='input:not([type=hidden]),button,a[href],[tabindex]:not([tabindex=\"-1\"])';" +
        "function list(){return [].slice.call(document.querySelectorAll(q)).filter(function(e){var r=e.getBoundingClientRect();return r.width&&r.height&&!e.disabled})}" +
        "var f=document.querySelector('input:not([type=hidden])');if(f)f.focus();" +
        "document.addEventListener('keydown',function(e){var d=e.key==='ArrowDown'?1:e.key==='ArrowUp'?-1:0;if(!d)return;" +
        "var l=list(),i=l.indexOf(document.activeElement),n=l[Math.max(0,Math.min(l.length-1,i+d))];" +
        "if(n){e.preventDefault();n.focus();n.scrollIntoView({block:'center'})}},true);})();";

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportMultipleWindows(false); // target=_blank links come through shouldOverrideUrlLoading
        s.setUserAgentString(s.getUserAgentString() + " TwoSeatTV/" + BuildConfig.VERSION_NAME);

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(web, true); // Access sets cookies on both its own domain and ours

        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (ours(u)) return false;
                openOutside(u);
                return true;
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                Uri u = Uri.parse(url);
                if (u.getHost() != null && u.getHost().endsWith(".cloudflareaccess.com")) v.evaluateJavascript(ACCESS_HELPER, null);
                CookieManager.getInstance().flush();
                v.requestFocus(View.FOCUS_DOWN);
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
                if (!req.isForMainFrame()) return;
                String html = "<html><body style='background:#000;color:#f5f5f7;font:22px system-ui;display:grid;place-items:center;height:100vh;margin:0;text-align:center'>"
                    + "<div><p style='font-size:30px;font-weight:700'>Can't reach Two-Seat Cinema</p>"
                    + "<p style='color:#98989d'>Check the TV's Wi-Fi, then press OK to try again.</p>"
                    + "<button autofocus onclick=\"location.href='" + BuildConfig.APP_URL + "'\" "
                    + "style='font:inherit;padding:14px 32px;border-radius:999px;border:0;background:#f5f5f7;color:#000'>Try again</button></div></body></html>";
                v.loadDataWithBaseURL(BuildConfig.APP_URL, html, "text/html", "utf-8", BuildConfig.APP_URL);
            }
        });

        if (state != null) web.restoreState(state);
        else web.loadUrl(BuildConfig.APP_URL);
        web.requestFocus();
    }

    private void openOutside(Uri u) {
        Intent i;
        try {
            i = "intent".equals(u.getScheme()) ? Intent.parseUri(u.toString(), Intent.URI_INTENT_SCHEME) : new Intent(Intent.ACTION_VIEW, u);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (ActivityNotFoundException | java.net.URISyntaxException e) {
            Toast.makeText(this, "No app on this TV can open that link", Toast.LENGTH_LONG).show();
        }
    }

    // Remote Back: let the page close a sheet or step back first; leave the app only when it says so.
    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        if (e.getKeyCode() == KeyEvent.KEYCODE_BACK) {
            if (e.getAction() == KeyEvent.ACTION_UP) {
                web.evaluateJavascript("(window.tvBack && window.tvBack()) ? 1 : 0", r -> {
                    if ("1".equals(r)) return;
                    if (web.canGoBack() && !String.valueOf(web.getUrl()).startsWith(BuildConfig.APP_URL)) web.goBack();
                    else moveTaskToBack(true);
                });
            }
            return true;
        }
        return super.dispatchKeyEvent(e);
    }

    @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); web.saveState(out); }
    @Override protected void onPause() { super.onPause(); CookieManager.getInstance().flush(); web.onPause(); }
    @Override protected void onResume() { super.onResume(); web.onResume(); }
    @Override protected void onDestroy() { if (web != null) web.destroy(); super.onDestroy(); }
}
