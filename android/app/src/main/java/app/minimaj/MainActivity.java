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
    private final Runnable stoppedListener = () -> main.post(this::onServerStopped);

    private final Runnable poll = new Runnable() {
        @Override
        public void run() {
            int p = ServerService.port;
            if (p > 0) {
                load(p);
            } else if (ServerService.error != null) {
                status.setText(ServerService.error);
            } else if (System.currentTimeMillis() - waitStart > START_TIMEOUT_MS) {
                status.setText("The game server did not start.");
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
                // our own table and friends' tables on the local network stay in the app
                if (isLocalHost(u.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u)); // other links: real browser
                } catch (Exception ignored) {
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
        root.addView(status, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);

        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
        ServerService.onStopped = stoppedListener;
        startServer();
    }

    private void startServer() {
        ServerService.error = null;
        startForegroundService(new Intent(this, ServerService.class));
        waitStart = System.currentTimeMillis();
        main.removeCallbacks(poll);
        main.post(poll);
    }

    private void load(int port) {
        if (loaded) return;
        loaded = true;
        web.loadUrl("http://127.0.0.1:" + port + "/");
        web.setVisibility(View.VISIBLE);
        status.setVisibility(View.GONE);
    }

    static boolean isLocalHost(String h) {
        if (h == null) return false;
        if (h.equals("127.0.0.1") || h.equals("localhost")) return true;
        if (h.startsWith("10.") || h.startsWith("192.168.")) return true;
        if (h.startsWith("172.")) {
            String[] p = h.split("\\.");
            try {
                int b = Integer.parseInt(p[1]);
                return b >= 16 && b <= 31;
            } catch (Exception e) {
                return false;
            }
        }
        return false;
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
            web.setVisibility(View.INVISIBLE);
            status.setText("Starting a new table…");
            status.setVisibility(View.VISIBLE);
            main.postDelayed(this::startServer, 300);
        } else if (ServerService.error != null) {
            status.setText(ServerService.error);
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
        if (!loaded) { super.onBackPressed(); return; }
        if (!onOwnTable()) {
            // at a friend's table: back to our own main menu
            new AlertDialog.Builder(this)
                    .setTitle("Leave this table?")
                    .setMessage("A computer player takes your seat. You can rejoin from the main menu.")
                    .setPositiveButton("Leave", (d, w) -> goHome())
                    .setNegativeButton("Cancel", null)
                    .show();
            return;
        }
        web.evaluateJavascript("(window.minimajNav && minimajNav.screen()) || ''", (v) -> {
            String screen = v == null ? "" : v.replace("\"", "");
            if (screen.equals("home") || screen.isEmpty()) {
                new AlertDialog.Builder(this)
                        .setTitle("Exit minimaj?")
                        .setPositiveButton("Exit", (d, w) -> {
                            ServerService.quitApp = true;
                            stopService(new Intent(this, ServerService.class));
                        })
                        .setNegativeButton("Cancel", null)
                        .show();
                return;
            }
            new AlertDialog.Builder(this)
                    .setTitle("Leave the table?")
                    .setMessage("Keep it running so friends can play on (a computer takes your seat), or stop it and disconnect everyone.")
                    .setPositiveButton("Keep running", (d, w) -> web.evaluateJavascript("minimajNav.leave()", null))
                    .setNeutralButton("Stop table", (d, w) -> {
                        web.evaluateJavascript("minimajNav.leave()", null);
                        stopService(new Intent(this, ServerService.class)); // restarts, then main menu
                    })
                    .setNegativeButton("Cancel", null)
                    .show();
        });
    }

    @Override
    protected void onDestroy() {
        main.removeCallbacks(poll);
        if (ServerService.onStopped == stoppedListener) ServerService.onStopped = null;
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
