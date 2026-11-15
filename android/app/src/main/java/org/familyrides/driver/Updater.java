package org.familyrides.driver;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.provider.Settings;
import android.widget.Toast;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

// Updating the app from inside it: the newest APK is downloaded and handed to Android's installer, which asks the driver
// "Do you want to update this app?". The first time, Android asks him to allow this app to install updates.
final class Updater {
    static final String ACTION_DONE = "org.familyrides.driver.UPDATE_DONE";
    private static boolean running = false;

    private Updater() { }

    static void start(Activity a, String url) {
        if (!url.startsWith("https://")) return;
        if (!a.getPackageManager().canRequestPackageInstalls()) {
            new AlertDialog.Builder(a)
                .setTitle("Allow updates")
                .setMessage("On the next screen, turn on \"Allow from this source\". Then come back and press Update again.")
                .setPositiveButton("OK", (d, w) -> a.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + a.getPackageName()))))
                .setNegativeButton("Not now", null)
                .show();
            return;
        }
        synchronized (Updater.class) {
            if (running) return;
            running = true;
        }
        Toast.makeText(a, "Downloading the update…", Toast.LENGTH_LONG).show();
        new Thread(() -> {
            try {
                install(a, url);
            } catch (Exception e) {
                a.runOnUiThread(() -> problem(a, "The update didn't download. Check the signal and try again."));
            } finally {
                synchronized (Updater.class) { running = false; }
            }
        }).start();
    }

    private static void install(Activity a, String url) throws Exception {
        PackageInstaller pi = a.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(a.getPackageName());
        int id = pi.createSession(params);
        try (PackageInstaller.Session session = pi.openSession(id)) {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setInstanceFollowRedirects(true);
            c.setConnectTimeout(20000);
            c.setReadTimeout(60000);
            if (c.getResponseCode() != 200) throw new Exception("download " + c.getResponseCode());
            try (InputStream in = c.getInputStream(); OutputStream out = session.openWrite("driver-app.apk", 0, -1)) {
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                session.fsync(out);
            }
            Intent done = new Intent(a, MainActivity.class).setAction(ACTION_DONE);
            PendingIntent pending = PendingIntent.getActivity(a, 7, done, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
            session.commit(pending.getIntentSender());
        } catch (Exception e) {
            pi.abandonSession(id);
            throw e;
        }
    }

    // Android's answer, sent back to MainActivity.
    @SuppressWarnings("deprecation")
    static void onResult(Activity a, Intent intent) {
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirm = (Intent) intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm != null) a.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } else if (status == PackageInstaller.STATUS_FAILURE_CONFLICT || status == PackageInstaller.STATUS_FAILURE_INCOMPATIBLE) {
            problem(a, "This update can't go over the app you have. Call the office: the old app has to be removed and the new one put on once.");
        } else if (status != PackageInstaller.STATUS_SUCCESS && status != PackageInstaller.STATUS_FAILURE_ABORTED) {
            problem(a, "The update didn't install. Try again later.");
        }
    }

    private static void problem(Activity a, String text) {
        new AlertDialog.Builder(a).setTitle("Update").setMessage(text).setPositiveButton("OK", null).show();
    }
}
