package org.familyrides.driver;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;

import java.util.ArrayList;
import java.util.List;

// The driver app: the server's /driver/ page in a WebView, plus what a page can't do by itself: GPS while the screen
// is off (TrackingService), notifications for new requests, and opening Maps or the phone dialer.
public class MainActivity extends Activity {
    static final String PREFS = "driver";
    private static final int PERMISSIONS = 1;
    private WebView web;
    private String pendingBase;
    private String pendingToken;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        web.addJavascriptInterface(new Bridge(), "DriverNative");
        web.setWebViewClient(new Client());
        String base = serverUrl(this);
        if (base.isEmpty()) askForServer();
        else web.loadUrl(base + "/driver/");
    }

    static String serverUrl(Context c) {
        String saved = c.getSharedPreferences(PREFS, MODE_PRIVATE).getString("server", "");
        String url = !saved.isEmpty() ? saved : BuildConfig.SERVER_URL;
        return url.replaceAll("/+$", "");
    }

    private void askForServer() {
        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setHint("https://...");
        input.setText(serverUrl(this));
        new AlertDialog.Builder(this)
            .setTitle("Server address")
            .setMessage("The address the office gave you.")
            .setView(input)
            .setCancelable(false)
            .setPositiveButton("OK", (d, w) -> {
                String url = input.getText().toString().trim().replaceAll("/+$", "");
                if (!url.startsWith("https://")) url = "https://" + url.replaceFirst("^https?://", "");
                getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("server", url).apply();
                web.loadUrl(url + "/driver/");
            })
            .show();
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            Uri uri = req.getUrl();
            Uri base = Uri.parse(serverUrl(MainActivity.this));
            if ("https".equals(uri.getScheme()) && uri.getHost() != null && uri.getHost().equals(base.getHost())) return false;
            // tel:, google.navigation:, Google Maps links: the phone's own apps.
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (ActivityNotFoundException e) {
                if ("google.navigation".equals(uri.getScheme())) {
                    String q = uri.getSchemeSpecificPart().replaceFirst("^q=", "");
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=" + q)));
                }
            }
            return true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
            // The page itself didn't load and isn't kept yet (first start without signal, or a wrong address).
            if (req.isForMainFrame()) {
                new AlertDialog.Builder(MainActivity.this)
                    .setTitle("Can't reach the server")
                    .setMessage("Check the signal, then try again.")
                    .setPositiveButton("Try again", (d, w) -> view.reload())
                    .setNegativeButton("Change address", (d, w) -> askForServer())
                    .show();
            }
        }
    }

    // What the page can ask of the phone (window.DriverNative).
    private class Bridge {
        @JavascriptInterface
        public void startTracking(String base, String token) {
            runOnUiThread(() -> {
                pendingBase = base;
                pendingToken = token;
                if (needPermissions()) return; // started once the driver allows it
                TrackingService.start(MainActivity.this, base, token);
            });
        }

        @JavascriptInterface
        public void stopTracking() {
            runOnUiThread(() -> TrackingService.stop(MainActivity.this));
        }

        @JavascriptInterface
        public void notify(String title, String text) {
            TrackingService.notifyRequest(MainActivity.this, title, text);
        }
    }

    private boolean needPermissions() {
        List<String> want = new ArrayList<>();
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            want.add(Manifest.permission.ACCESS_FINE_LOCATION);
            want.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            want.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (want.isEmpty()) return false;
        requestPermissions(want.toArray(new String[0]), PERMISSIONS);
        return true;
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        if (code != PERMISSIONS || pendingBase == null) return;
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
            TrackingService.start(this, pendingBase, pendingToken);
        } else {
            new AlertDialog.Builder(this)
                .setTitle("Location is off")
                .setMessage("Without location the office and the riders can't see where you are, and arrival times are guesses. You can allow it in the phone's settings.")
                .setPositiveButton("OK", null)
                .show();
        }
    }

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, MODE_PRIVATE);
    }
}
