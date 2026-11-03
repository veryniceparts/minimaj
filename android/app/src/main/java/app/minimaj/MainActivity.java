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
                if ("127.0.0.1".equals(u.getHost()) || "localhost".equals(u.getHost())) return false;
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

    private void onServerStopped() {
        if (isFinishing() || isDestroyed()) return;
        if (loaded) {
            finish(); // e.g. "Stop server" in the game or the notification's Stop action
        } else if (ServerService.error != null) {
            status.setText(ServerService.error);
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (web.canGoBack()) {
            web.goBack();
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle("Leave minimaj?")
                .setMessage("Stop the game server? Other players will be disconnected.")
                .setPositiveButton("Stop server", (d, w) -> {
                    stopService(new Intent(this, ServerService.class));
                    finish();
                })
                .setNeutralButton("Keep running", (d, w) -> moveTaskToBack(true))
                .setNegativeButton("Cancel", null)
                .show();
    }

    @Override
    protected void onDestroy() {
        main.removeCallbacks(poll);
        if (ServerService.onStopped == stoppedListener) ServerService.onStopped = null;
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
