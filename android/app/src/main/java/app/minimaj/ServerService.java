package app.minimaj;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Foreground service that runs the Go game server (lib/arm64-v8a/libminimaj.so,
 * extracted to nativeLibraryDir) as a child process and keeps it alive while
 * the app is in the background.
 */
public class ServerService extends Service {
    static final String TAG = "minimaj";
    static final String ACTION_STOP = "app.minimaj.STOP";
    private static final String CHANNEL = "server";
    private static final int NOTIFICATION_ID = 1;

    /** Port the server listens on, 0 while starting or stopped. Read by MainActivity. */
    static volatile int port = 0;
    /** Last error message (e.g. the server failed to start), or null. */
    static volatile String error = null;
    /** Called on the main thread when the server stops. */
    static volatile Runnable onStopped = null;

    private Process process;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private final Handler main = new Handler(Looper.getMainLooper());
    private boolean stopping = false;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf(); // from the notification's Stop action
            return START_NOT_STICKY;
        }
        goForeground(port > 0 ? "Running on port " + port : "Starting…");
        if (process == null) startServer();
        return START_NOT_STICKY;
    }

    private void goForeground(String text) {
        Notification n = buildNotification(text);
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, n);
        }
    }

    private Notification buildNotification(String text) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Game server", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Shown while the minimaj game server is running");
            ch.setShowBadge(false);
            ch.enableVibration(false); // the app never vibrates
            ch.setSound(null, null);
            nm.createNotificationChannel(ch);
        }
        PendingIntent open = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent stop = PendingIntent.getService(this, 1,
                new Intent(this, ServerService.class).setAction(ACTION_STOP),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Action stopAction = new Notification.Action.Builder(null, "Stop", stop).build();
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_tile)
                .setContentTitle("minimaj server")
                .setContentText(text)
                .setContentIntent(open)
                .setOngoing(true)
                .setShowWhen(false)
                .addAction(stopAction)
                .build();
    }

    private void updateNotification(String text) {
        getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, buildNotification(text));
    }

    private void startServer() {
        port = 0;
        error = null;
        File exe = new File(getApplicationInfo().nativeLibraryDir, "libminimaj.so");
        List<String> cmd = new ArrayList<>();
        cmd.add(exe.getAbsolutePath());
        cmd.add("-no-browser");
        cmd.add("-exit-on-eof"); // the server exits if this app process dies
        String ips = lanAddresses();
        if (!ips.isEmpty()) {
            cmd.add("-lan-ip");
            cmd.add(ips);
        }
        try {
            ProcessBuilder pb = new ProcessBuilder(cmd);
            pb.redirectErrorStream(true);
            pb.directory(getFilesDir());
            pb.environment().put("HOME", getFilesDir().getAbsolutePath());
            pb.environment().put("TMPDIR", getCacheDir().getAbsolutePath());
            process = pb.start();
        } catch (Exception e) {
            Log.e(TAG, "cannot start server", e);
            fail("Cannot start the server: " + e.getMessage());
            return;
        }
        acquireLocks();
        final Process p = process;
        Thread reader = new Thread(() -> {
            try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()))) {
                String line;
                // Keep reading until EOF so the pipe never fills up.
                while ((line = r.readLine()) != null) {
                    Log.i(TAG, line);
                    if (port == 0 && line.startsWith("LISTEN ")) {
                        try {
                            final int pt = Integer.parseInt(line.substring(7).trim());
                            port = pt;
                            main.post(() -> updateNotification("Running on port " + pt + " · tap to open"));
                        } catch (NumberFormatException ignored) {
                        }
                    }
                }
            } catch (Exception ignored) {
            }
            int code = -1;
            try {
                code = p.waitFor();
            } catch (InterruptedException ignored) {
            }
            final int exit = code;
            main.post(() -> {
                if (process != p) return;
                process = null;
                if (!stopping && port == 0) error = "The server stopped (exit code " + exit + ").";
                stopSelf();
            });
        }, "minimaj-server-out");
        reader.setDaemon(true);
        reader.start();
    }

    private void fail(String msg) {
        error = msg;
        stopSelf();
    }

    /** Private IPv4 addresses of this device (Wi-Fi, hotspot, Ethernet), comma-separated. */
    static String lanAddresses() {
        StringBuilder sb = new StringBuilder();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                String name = ni.getName();
                if (!ni.isUp() || ni.isLoopback() || ni.isVirtual() || name.startsWith("rmnet")
                        || name.startsWith("ccmni") || name.startsWith("tun") || name.startsWith("dummy")) {
                    continue;
                }
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (a instanceof Inet4Address && a.isSiteLocalAddress()) {
                        if (sb.length() > 0) sb.append(',');
                        sb.append(a.getHostAddress());
                    }
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "listing interfaces", e);
        }
        return sb.toString();
    }

    @SuppressWarnings("deprecation")
    private void acquireLocks() {
        try {
            PowerManager pm = getSystemService(PowerManager.class);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "minimaj:server");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire(6 * 60 * 60 * 1000L); // a long game session at most
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "minimaj:server");
                wifiLock.setReferenceCounted(false);
                wifiLock.acquire();
            }
        } catch (Exception e) {
            Log.w(TAG, "locks", e);
        }
    }

    @Override
    public void onDestroy() {
        stopping = true;
        if (process != null) {
            try {
                process.getOutputStream().close(); // -exit-on-eof: lets it shut down cleanly
            } catch (Exception ignored) {
            }
            process.destroy();
            process = null;
        }
        port = 0;
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        if (Build.VERSION.SDK_INT >= 33) {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } else {
            stopForegroundCompat();
        }
        Runnable r = onStopped;
        if (r != null) r.run();
        super.onDestroy();
    }

    @SuppressWarnings("deprecation")
    private void stopForegroundCompat() {
        stopForeground(true);
    }
}
