package org.familyrides.driver;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.TimeZone;

// While the driver is online or paused: a check every 30 seconds for new ride requests (so the phone rings even with
// the screen off) and for his status. GPS only while he is online (at work): every few seconds, sent to
// /api/driver/location in batches (kept while there's no signal). On a break GPS is off; after Stop work the service ends.
public class TrackingService extends Service implements LocationListener {
    private static final String CH_TRACK = "tracking";
    private static final String CH_REQUEST = "requests";
    private static final int ID_TRACK = 1;
    private static final long GPS_MS = 5000;
    private static final long SEND_MS = 15000;
    private static final long CHECK_MS = 30000;
    private static final int MAX_KEPT = 5000;

    private HandlerThread thread;
    private Handler handler;
    private String base;
    private String token;
    private JSONArray points = new JSONArray();
    private final Set<String> seen = new HashSet<>();
    private boolean firstCheck = true;
    private boolean gps = false;

    static void start(Context c, String base, String token) {
        Intent i = new Intent(c, TrackingService.class).putExtra("base", base).putExtra("token", token);
        c.startForegroundService(i);
    }

    static void stop(Context c) {
        c.stopService(new Intent(c, TrackingService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        channels(this);
        thread = new HandlerThread("tracking");
        thread.start();
        handler = new Handler(thread.getLooper());
        try {
            points = new JSONArray(MainActivity.prefs(this).getString("points", "[]"));
        } catch (Exception e) {
            points = new JSONArray();
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && intent.getStringExtra("token") != null) {
            base = intent.getStringExtra("base");
            token = intent.getStringExtra("token");
            MainActivity.prefs(this).edit().putString("trackBase", base).putString("trackToken", token).apply();
        } else {
            base = MainActivity.prefs(this).getString("trackBase", null);
            token = MainActivity.prefs(this).getString("trackToken", null);
        }
        Notification n = new Notification.Builder(this, CH_TRACK)
            .setContentTitle("Driver app is on")
            .setContentText("Ready for rides")
            .setSmallIcon(R.drawable.ic_notify)
            .setOngoing(true)
            .setContentIntent(openApp(this))
            .build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(ID_TRACK, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        else startForeground(ID_TRACK, n);
        if (base == null || token == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        // GPS is turned on by check() once the server says he is online.
        ((LocationManager) getSystemService(LOCATION_SERVICE)).removeUpdates(this);
        gps = false;
        handler.removeCallbacksAndMessages(null);
        handler.postDelayed(this::send, SEND_MS);
        handler.post(this::check);
        return START_STICKY;
    }

    // GPS on only while the driver is online; off on a break.
    private void setGps(boolean on) {
        if (on == gps) return;
        LocationManager lm = (LocationManager) getSystemService(LOCATION_SERVICE);
        lm.removeUpdates(this);
        gps = false;
        if (on) {
            try {
                lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, GPS_MS, 10f, this, thread.getLooper());
                if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                    lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, GPS_MS * 6, 50f, this, thread.getLooper());
                }
                gps = true;
            } catch (SecurityException e) {
                // no location permission: nothing is shared
            }
        }
        Notification n = new Notification.Builder(this, CH_TRACK)
            .setContentTitle("Driver app is on")
            .setContentText(gps ? "Sharing your location with the office" : "On a break: location not shared")
            .setSmallIcon(R.drawable.ic_notify)
            .setOngoing(true)
            .setContentIntent(openApp(this))
            .build();
        ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(ID_TRACK, n);
    }

    @Override
    public void onDestroy() {
        ((LocationManager) getSystemService(LOCATION_SERVICE)).removeUpdates(this);
        handler.removeCallbacksAndMessages(null);
        handler.post(() -> {
            send();
            thread.quitSafely();
        });
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // --- GPS ---
    @Override
    public void onLocationChanged(Location loc) {
        if (!gps) return;
        try {
            JSONObject p = new JSONObject();
            p.put("lat", loc.getLatitude());
            p.put("lng", loc.getLongitude());
            p.put("accuracy", loc.hasAccuracy() ? loc.getAccuracy() : JSONObject.NULL);
            p.put("speed", loc.hasSpeed() ? loc.getSpeed() : JSONObject.NULL);
            p.put("at", iso(loc.getTime()));
            points.put(p);
            while (points.length() > MAX_KEPT) points.remove(0);
            MainActivity.prefs(this).edit().putString("points", points.toString()).apply();
        } catch (Exception ignored) {
            // a bad point is skipped
        }
    }

    @Override public void onProviderEnabled(String p) { }
    @Override public void onProviderDisabled(String p) { }
    @Override public void onStatusChanged(String p, int s, Bundle b) { }

    private void send() {
        try {
            if (points.length() > 0) {
                int n = Math.min(points.length(), 500);
                JSONArray batch = new JSONArray();
                for (int i = 0; i < n; i++) batch.put(points.get(i));
                JSONObject body = new JSONObject().put("points", batch);
                int status = http("POST", "/api/driver/location", body.toString(), null);
                if (status == 200 || status == 400) {
                    JSONArray rest = new JSONArray();
                    for (int i = n; i < points.length(); i++) rest.put(points.get(i));
                    points = rest;
                    MainActivity.prefs(this).edit().putString("points", points.toString()).apply();
                } else if (status == 401) {
                    stopSelf();
                    return;
                }
            }
        } catch (Exception ignored) {
            // no signal: kept for next time
        }
        if (handler != null && thread.isAlive()) handler.postDelayed(this::send, SEND_MS);
    }

    // --- new requests ---
    private void check() {
        try {
            StringBuilder out = new StringBuilder();
            int status = http("GET", "/api/driver/today", null, out);
            if (status == 200) {
                JSONObject today = new JSONObject(out.toString());
                String driverStatus = today.getJSONObject("driver").getString("status");
                JSONArray reqs = today.getJSONArray("requests");
                StringBuilder fresh = new StringBuilder();
                for (int i = 0; i < reqs.length(); i++) {
                    JSONObject r = reqs.getJSONObject(i);
                    if (seen.add(r.getString("id")) && !firstCheck) {
                        if (fresh.length() > 0) fresh.append(", ");
                        fresh.append(r.optString("rider_name", "Ride"));
                    }
                }
                firstCheck = false;
                if (fresh.length() > 0 && "online".equals(driverStatus)) notifyRequest(this, "New ride request", fresh.toString());
                if ("offline".equals(driverStatus)) {
                    setGps(false);
                    stopSelf();
                    return;
                }
                setGps("online".equals(driverStatus));
            } else if (status == 401) {
                stopSelf();
                return;
            }
        } catch (Exception ignored) {
            // no signal
        }
        if (handler != null && thread.isAlive()) handler.postDelayed(this::check, CHECK_MS);
    }

    private int http(String method, String path, String body, StringBuilder out) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(base + path).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(10000);
        c.setReadTimeout(15000);
        c.setRequestProperty("Authorization", "Bearer " + token);
        if (body != null) {
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            try (OutputStream os = c.getOutputStream()) {
                os.write(body.getBytes(StandardCharsets.UTF_8));
            }
        }
        int status = c.getResponseCode();
        if (out != null && status == 200) {
            try (InputStream in = c.getInputStream()) {
                ByteArrayOutputStream buf = new ByteArrayOutputStream();
                byte[] b = new byte[8192];
                int k;
                while ((k = in.read(b)) > 0) buf.write(b, 0, k);
                out.append(buf.toString("UTF-8"));
            }
        }
        c.disconnect();
        return status;
    }

    // --- notifications ---
    static void channels(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CH_TRACK, "Location sharing", NotificationManager.IMPORTANCE_LOW));
        NotificationChannel req = new NotificationChannel(CH_REQUEST, "New ride requests", NotificationManager.IMPORTANCE_HIGH);
        req.enableVibration(true);
        req.setVibrationPattern(new long[] { 0, 400, 200, 400 });
        nm.createNotificationChannel(req);
    }

    static void notifyRequest(Context c, String title, String text) {
        channels(c);
        Notification n = new Notification.Builder(c, CH_REQUEST)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_notify)
            .setAutoCancel(true)
            .setContentIntent(openApp(c))
            .build();
        c.getSystemService(NotificationManager.class).notify((int) (System.currentTimeMillis() % 100000) + 10, n);
    }

    static PendingIntent openApp(Context c) {
        Intent i = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(c, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static String iso(long ms) {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date(ms));
    }
}
