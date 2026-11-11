package app.minimaj;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

/** Starts the server service, waits for its port and shows the game in a WebView. */
public class MainActivity extends Activity {
    private static final long START_TIMEOUT_MS = 15000;

    private final Handler main = new Handler(Looper.getMainLooper());
    private WebView web;
    private TextView status;
    private long waitStart;
    private boolean loaded = false;
    /** The service could not be started from the background: start it on the next onResume. */
    private boolean startOnResume = false;
    private final Runnable stoppedListener = () -> main.post(this::onServerStopped);

    private final Runnable poll = new Runnable() {
        @Override
        public void run() {
            int p = ServerService.port;
            if (p > 0) {
                load(p);
            } else if (ServerService.error != null) {
                showError(ServerService.error);
            } else if (System.currentTimeMillis() - waitStart > START_TIMEOUT_MS) {
                showError("The game server did not start.");
            } else {
                main.postDelayed(this, 100);
            }
        }
    };

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#1B1726"));

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#1B1726"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(java.util.Locale.ROOT);
                boolean isWeb = scheme.equals("http") || scheme.equals("https");
                // our own table and friends' tables on the local network stay in the app
                if (isWeb && isLocalHost(u.getHost())) return false;
                // Other web links open in the real browser, but only when the player tapped
                // one: a page can't send them to other apps, the store, the dialer or
                // anywhere else on its own, and non-web schemes are never handed out.
                if (isWeb && req.hasGesture()) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, u));
                    } catch (Exception ignored) {
                    }
                }
                return true;
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // The page's renderer crashed or was killed to free memory. Without
                // this the whole app is killed; instead build a fresh activity (the
                // server keeps running, so the table is still there).
                if (view == web) {
                    web = null;
                    view.destroy();
                    if (!isFinishing()) recreate();
                }
                return true;
            }
        });
        web.setVisibility(View.INVISIBLE);
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));

        status = new TextView(this);
        status.setText("Starting the game server…");
        status.setTextColor(Color.parseColor("#EFEAF7"));
        status.setTextSize(16);
        status.setGravity(Gravity.CENTER);
        status.setPadding(48, 48, 48, 48);
        status.setOnClickListener((v) -> {
            if (!loaded && retryable) { // "Tap to try again"
                status.setText("Starting the game server…");
                startServer();
            }
        });
        root.addView(status, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);

        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
        ServerService.onStopped = stoppedListener;
        startServer();
    }

    private boolean retryable = false;

    private void showError(String msg) {
        retryable = true;
        status.setText(msg + "\n\nTap to try again.");
    }

    private void startServer() {
        ServerService.error = null;
        ServerService.quitApp = false; // a stale notification Stop must not close this new table
        retryable = false;
        try {
            startForegroundService(new Intent(this, ServerService.class));
        } catch (RuntimeException e) {
            // Android 12+: ForegroundServiceStartNotAllowedException while in the
            // background (e.g. the server exited while the app was not shown)
            startOnResume = true;
            return;
        }
        startOnResume = false;
        waitStart = System.currentTimeMillis();
        main.removeCallbacks(poll);
        main.post(poll);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
        if (startOnResume) startServer();
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        super.onPause();
    }

    private void load(int port) {
        if (loaded) return;
        loaded = true;
        web.loadUrl("http://127.0.0.1:" + port + "/");
        web.setVisibility(View.VISIBLE);
        status.setVisibility(View.GONE);
    }

    /**
     * This device or a private LAN address (a friend's minimaj table): such pages
     * stay in the app. Only IPv4 literals count, so a host name like
     * "192.168.example.com" still opens in the real browser.
     */
    static boolean isLocalHost(String h) {
        if (h == null) return false;
        if (h.equals("localhost")) return true;
        String[] p = h.split("\\.", -1);
        if (p.length != 4) return false;
        int[] o = new int[4];
        for (int i = 0; i < 4; i++) {
            if (p[i].isEmpty() || p[i].length() > 3) return false;
            for (int j = 0; j < p[i].length(); j++) {
                char c = p[i].charAt(j);
                if (c < '0' || c > '9') return false;
            }
            o[i] = Integer.parseInt(p[i]);
            if (o[i] > 255) return false;
        }
        return o[0] == 127 || o[0] == 10 || (o[0] == 192 && o[1] == 168) || (o[0] == 172 && o[1] >= 16 && o[1] <= 31);
    }

    private void onServerStopped() {
        if (isFinishing() || isDestroyed()) return;
        if (ServerService.quitApp) { // the notification's Stop action
            ServerService.quitApp = false;
            finish();
            return;
        }
        if (loaded) {
            // "Stop server" in the lobby or "Stop table" on back: start a fresh
            // table and go back to the main menu instead of leaving the app.
            loaded = false;
            if (web != null) web.setVisibility(View.INVISIBLE);
            status.setText("Starting a new table…");
            status.setVisibility(View.VISIBLE);
            main.postDelayed(this::startServer, 300);
        } else if (ServerService.error != null) {
            showError(ServerService.error);
        }
    }

    private boolean onOwnTable() {
        Uri u = Uri.parse(web.getUrl() == null ? "" : web.getUrl());
        String h = u.getHost();
        return "127.0.0.1".equals(h) || "localhost".equals(h);
    }

    private void goHome() {
        int p = ServerService.port;
        if (p > 0) web.loadUrl("http://127.0.0.1:" + p + "/");
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (!loaded || web == null) { super.onBackPressed(); return; }
        if (!onOwnTable()) {
            // at a friend's table: back to our own main menu
            new AlertDialog.Builder(this)
                    .setTitle("Leave this table?")
                    .setMessage("The table keeps your seat for you (the others can vote to let a computer play it). You can rejoin from the main menu.")
                    .setPositiveButton("Leave", (d, w) -> goHome())
                    .setNegativeButton("Cancel", null)
                    .show();
            return;
        }
        web.evaluateJavascript("(window.minimajNav && minimajNav.screen()) || ''", (v) -> {
            if (isFinishing() || isDestroyed() || web == null) return; // the answer came too late
            String screen = v == null || v.equals("null") ? "" : v.replace("\"", "");
            if (screen.equals("home") || screen.isEmpty()) {
                new AlertDialog.Builder(this)
                        .setTitle("Exit minimaj?")
                        .setPositiveButton("Exit", (d, w) -> {
                            ServerService.quitApp = true;
                            // not running (it failed or already stopped): nothing will call back
                            if (!stopService(new Intent(this, ServerService.class))) {
                                ServerService.quitApp = false;
                                finish();
                            }
                        })
                        .setNegativeButton("Cancel", null)
                        .show();
                return;
            }
            new AlertDialog.Builder(this)
                    .setTitle("Leave the table?")
                    .setMessage("Keep it running so friends can play on (your seat waits for you, or they vote to let a computer play it), or stop it and disconnect everyone.")
                    .setPositiveButton("Keep running", (d, w) -> leaveTable())
                    .setNeutralButton("Stop table", (d, w) -> {
                        leaveTable();
                        stopService(new Intent(this, ServerService.class)); // restarts, then main menu
                    })
                    .setNegativeButton("Cancel", null)
                    .show();
        });
    }

    private void leaveTable() {
        if (web != null) web.evaluateJavascript("window.minimajNav && minimajNav.leave()", null);
    }

    @Override
    protected void onDestroy() {
        main.removeCallbacksAndMessages(null); // the poll and a pending restart (onServerStopped)
        if (ServerService.onStopped == stoppedListener) ServerService.onStopped = null;
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
