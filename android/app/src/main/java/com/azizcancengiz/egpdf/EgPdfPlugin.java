package com.azizcancengiz.egpdf;

import android.Manifest;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.pdf.PdfRenderer;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintJob;
import android.print.PrintManager;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.util.Base64;

import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.core.content.IntentCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Native side of the Android window.native bridge (src/native-android.js).
 *
 * Everything here is local: listing and reading PDFs on the phone, the system
 * pickers, writing saves back, share and print. The one exception is the
 * self-updater (updateCheck / updateDownload), which only ever talks to GitHub
 * for the latest release and its egPDF.apk asset — never with document data.
 */
@CapacitorPlugin(
    name = "EgPdf",
    permissions = {
        @Permission(
            alias = "storage",
            strings = { Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE }
        )
    }
)
public class EgPdfPlugin extends Plugin {

    private static final String UPDATE_REPO = "acc-studio/egpdf";
    private static final String UPDATE_ASSET = "egPDF.apk";
    private static final String UPDATE_UA = "egPDF-updater";

    private final ExecutorService io = Executors.newFixedThreadPool(3);
    private final Handler main = new Handler(Looper.getMainLooper());
    private final List<JSObject> pendingFiles = new ArrayList<>();

    @Override
    public void load() {
        // Back goes to the web layer, which decides: close a panel, go home,
        // or leave the app (exitApp).
        getActivity().getOnBackPressedDispatcher().addCallback(getActivity(), new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                notifyListeners("backButton", new JSObject(), true);
            }
        });
        Intent launch = getActivity().getIntent();
        if (launch != null) {
            pendingFiles.addAll(filesFromIntent(launch));
            // consumed: a recreated activity must not reopen the same files
            getActivity().setIntent(new Intent(Intent.ACTION_MAIN));
        }
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        List<JSObject> files = filesFromIntent(intent);
        if (files.isEmpty()) return;
        JSObject ev = new JSObject();
        ev.put("files", toArray(files));
        notifyListeners("openFiles", ev, true);
    }

    // ------------------------------------------------------------------ intents

    private List<JSObject> filesFromIntent(Intent intent) {
        List<Uri> uris = new ArrayList<>();
        String action = intent.getAction();
        if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
            uris.add(intent.getData());
        } else if (Intent.ACTION_SEND.equals(action)) {
            Uri u = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri.class);
            if (u != null) uris.add(u);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> list = IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri.class);
            if (list != null) uris.addAll(list);
        }
        List<JSObject> out = new ArrayList<>();
        for (Uri u : uris) out.add(describe(u));
        return out;
    }

    @PluginMethod
    public void getIntentFiles(PluginCall call) {
        JSObject res = new JSObject();
        res.put("files", toArray(pendingFiles));
        pendingFiles.clear();
        call.resolve(res);
    }

    // { uri, name } for the JS side. "uri" is a plain file path whenever the
    // document can be reached as one (then saving writes straight back to it),
    // otherwise the content:// URI.
    private JSObject describe(Uri uri) {
        JSObject o = new JSObject();
        String path = pathFor(uri);
        o.put("uri", path != null ? path : uri.toString());
        o.put("name", displayName(uri, path));
        return o;
    }

    private String displayName(Uri uri, String path) {
        if (path != null) return new File(path).getName();
        if ("content".equals(uri.getScheme())) {
            try (Cursor c = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
                if (c != null && c.moveToFirst()) {
                    String n = c.getString(0);
                    if (n != null && !n.isEmpty()) return n;
                }
            } catch (Exception ignored) {}
        }
        String last = uri.getLastPathSegment();
        if (last == null || last.isEmpty()) last = "document.pdf";
        last = last.substring(last.lastIndexOf('/') + 1);
        String lower = last.toLowerCase();
        return lower.endsWith(".pdf") || lower.endsWith(".udf") ? last : last + ".pdf";
    }

    // Map a URI onto a readable+writable file path, when we have storage access.
    private String pathFor(Uri uri) {
        try {
            if ("file".equals(uri.getScheme())) return uri.getPath();
            if (!hasAllFilesAccess() || !"content".equals(uri.getScheme())) return null;
            String candidate = null;
            if (DocumentsContract.isDocumentUri(getContext(), uri)) {
                String docId = DocumentsContract.getDocumentId(uri);
                if ("com.android.externalstorage.documents".equals(uri.getAuthority())) {
                    String[] parts = docId.split(":", 2);
                    if (parts.length == 2 && "primary".equalsIgnoreCase(parts[0])) {
                        candidate = Environment.getExternalStorageDirectory() + "/" + parts[1];
                    }
                } else if (docId.startsWith("raw:")) {
                    candidate = docId.substring(4);
                }
            }
            if (candidate == null) {
                try (Cursor c = getContext().getContentResolver().query(uri, new String[] { MediaStore.MediaColumns.DATA }, null, null, null)) {
                    if (c != null && c.moveToFirst()) candidate = c.getString(0);
                } catch (Exception ignored) {}
            }
            if (candidate == null) return null;
            File f = new File(candidate);
            return f.isFile() && f.canRead() ? f.getAbsolutePath() : null;
        } catch (Exception e) {
            return null;
        }
    }

    // ------------------------------------------------------------------ storage access

    private boolean hasAllFilesAccess() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) return Environment.isExternalStorageManager();
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
    }

    @PluginMethod
    public void requestAllFilesAccess(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Intent i = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + getContext().getPackageName()));
            try {
                getActivity().startActivity(i);
            } catch (Exception e) {
                getActivity().startActivity(new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION));
            }
            call.resolve(); // the home screen re-checks when the app comes back
        } else {
            requestPermissionForAlias("storage", call, "storageGranted");
        }
    }

    @PermissionCallback
    private void storageGranted(PluginCall call) {
        call.resolve();
        notifyListeners("storageChanged", new JSObject(), true);
    }

    // Every PDF (and .udf) MediaStore knows about, newest arrival first.
    @PluginMethod
    public void listPdfs(PluginCall call) {
        int limit = call.getInt("limit", 600);
        io.execute(() -> {
            JSObject res = new JSObject();
            JSArray files = new JSArray();
            boolean granted = hasAllFilesAccess();
            res.put("granted", granted);
            if (granted) {
                String[] proj = {
                    MediaStore.MediaColumns.DATA, MediaStore.MediaColumns.SIZE,
                    MediaStore.MediaColumns.DATE_ADDED, MediaStore.MediaColumns.DATE_MODIFIED,
                };
                // PDFs, plus UYAP documents (.udf — no registered MIME type)
                String sel = MediaStore.MediaColumns.MIME_TYPE + "=? OR " + MediaStore.MediaColumns.DATA + " LIKE ? OR "
                    + MediaStore.MediaColumns.DATA + " LIKE ?";
                String[] args = { "application/pdf", "%.pdf", "%.udf" };
                try (Cursor c = getContext().getContentResolver().query(
                        MediaStore.Files.getContentUri("external"), proj, sel, args,
                        MediaStore.MediaColumns.DATE_ADDED + " DESC")) {
                    while (c != null && c.moveToNext() && files.length() < limit) {
                        String path = c.getString(0);
                        if (path == null) continue;
                        File f = new File(path);
                        if (!f.isFile()) continue;
                        JSObject o = new JSObject();
                        o.put("path", path);
                        o.put("name", f.getName());
                        o.put("size", f.length());
                        long added = c.getLong(2) * 1000L;
                        o.put("added", added > 0 ? added : f.lastModified());
                        o.put("modified", f.lastModified());
                        files.put(o);
                    }
                } catch (Exception e) {
                    res.put("error", String.valueOf(e.getMessage()));
                }
            }
            res.put("files", files);
            call.resolve(res);
        });
    }

    // First page, rendered small, as base64 JPEG. Cached on disk per file version.
    @PluginMethod
    public void thumbnail(PluginCall call) {
        String path = call.getString("path");
        int width = call.getInt("width", 120);
        io.execute(() -> {
            JSObject res = new JSObject();
            try {
                File f = new File(path);
                File dir = new File(getContext().getCacheDir(), "thumbs");
                dir.mkdirs();
                File cached = new File(dir, sha1(path + "|" + f.lastModified() + "|" + width) + ".jpg");
                byte[] jpg;
                if (cached.isFile()) {
                    jpg = readAll(new FileInputStream(cached));
                } else {
                    try (ParcelFileDescriptor pfd = ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
                         PdfRenderer r = new PdfRenderer(pfd);
                         PdfRenderer.Page page = r.openPage(0)) {
                        int h = Math.max(1, Math.round(width * (float) page.getHeight() / page.getWidth()));
                        Bitmap bmp = Bitmap.createBitmap(width, Math.min(h, width * 3), Bitmap.Config.ARGB_8888);
                        bmp.eraseColor(Color.WHITE);
                        page.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
                        ByteArrayOutputStream bos = new ByteArrayOutputStream();
                        bmp.compress(Bitmap.CompressFormat.JPEG, 82, bos);
                        bmp.recycle();
                        jpg = bos.toByteArray();
                    }
                    try (FileOutputStream fos = new FileOutputStream(cached)) { fos.write(jpg); }
                }
                res.put("data", Base64.encodeToString(jpg, Base64.NO_WRAP));
            } catch (Throwable ignored) {
                // encrypted / broken / huge: the list keeps its generic icon
            }
            call.resolve(res);
        });
    }

    // ------------------------------------------------------------------ pickers

    @PluginMethod
    public void openDocuments(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        // .udf files have no MIME type of their own; they show up as binary/zip
        i.setType("*/*");
        i.putExtra(Intent.EXTRA_MIME_TYPES, new String[] { "application/pdf", "application/octet-stream", "application/zip" });
        i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        startActivityForResult(call, i, "openDocumentsResult");
    }

    @ActivityCallback
    private void openDocumentsResult(PluginCall call, ActivityResult result) {
        List<JSObject> out = new ArrayList<>();
        Intent data = result.getData();
        if (result.getResultCode() == Activity.RESULT_OK && data != null) {
            List<Uri> uris = new ArrayList<>();
            if (data.getClipData() != null) {
                for (int k = 0; k < data.getClipData().getItemCount(); k++) uris.add(data.getClipData().getItemAt(k).getUri());
            } else if (data.getData() != null) {
                uris.add(data.getData());
            }
            for (Uri u : uris) {
                keepAccess(u, data.getFlags());
                out.add(describe(u));
            }
        }
        JSObject res = new JSObject();
        res.put("files", toArray(out));
        call.resolve(res);
    }

    @PluginMethod
    public void createDocument(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("application/pdf");
        i.putExtra(Intent.EXTRA_TITLE, call.getString("name", "document.pdf"));
        startActivityForResult(call, i, "createDocumentResult");
    }

    @ActivityCallback
    private void createDocumentResult(PluginCall call, ActivityResult result) {
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            call.resolve(new JSObject());
            return;
        }
        Uri u = data.getData();
        keepAccess(u, data.getFlags());
        // the new file is still empty, so describe() can't vouch for a path yet;
        // the URI is always writable
        JSObject o = new JSObject();
        o.put("uri", u.toString());
        o.put("name", displayName(u, null));
        call.resolve(o);
    }

    private void keepAccess(Uri u, int flags) {
        try {
            getContext().getContentResolver().takePersistableUriPermission(u,
                flags & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION));
        } catch (Exception ignored) {}
    }

    // ------------------------------------------------------------------ file IO

    @PluginMethod
    public void readFile(PluginCall call) {
        String target = call.getString("target");
        io.execute(() -> {
            try {
                byte[] bytes = readAll(openIn(target));
                JSObject res = new JSObject();
                res.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
                call.resolve(res);
            } catch (Exception e) {
                call.reject("Could not read the file: " + e.getMessage());
            }
        });
    }

    // Saves arrive in base64 chunks. They are staged in a temp file and only
    // copied over the destination once complete, so a failed save never leaves
    // a truncated PDF behind.
    @PluginMethod
    public void writeFile(PluginCall call) {
        String target = call.getString("target");
        String data = call.getString("data", "");
        boolean append = call.getBoolean("append", false);
        boolean done = call.getBoolean("done", true);
        io.execute(() -> {
            try {
                File staging = new File(getContext().getCacheDir(), "save-" + sha1(target) + ".tmp");
                try (FileOutputStream fos = new FileOutputStream(staging, append)) {
                    fos.write(Base64.decode(data, Base64.DEFAULT));
                }
                if (done) {
                    try (InputStream in = new FileInputStream(staging); OutputStream out = openOut(target)) {
                        copy(in, out);
                    } finally {
                        staging.delete();
                    }
                    if (target.startsWith("/")) {
                        MediaScannerConnection.scanFile(getContext(), new String[] { target }, new String[] { "application/pdf" }, null);
                    }
                }
                call.resolve();
            } catch (Exception e) {
                call.reject("Could not write the file: " + e.getMessage());
            }
        });
    }

    private InputStream openIn(String target) throws Exception {
        if (target.startsWith("/")) return new FileInputStream(target);
        InputStream in = getContext().getContentResolver().openInputStream(Uri.parse(target));
        if (in == null) throw new Exception("no stream");
        return in;
    }

    private OutputStream openOut(String target) throws Exception {
        if (target.startsWith("/")) {
            File f = new File(target);
            File parent = f.getParentFile();
            if (parent != null) parent.mkdirs();
            return new FileOutputStream(f, false);
        }
        OutputStream out = getContext().getContentResolver().openOutputStream(Uri.parse(target), "wt");
        if (out == null) throw new Exception("not writable");
        return out;
    }

    // ------------------------------------------------------------------ share & print

    @PluginMethod
    public void shareTarget(PluginCall call) {
        File dir = new File(getContext().getCacheDir(), "share");
        File[] old = dir.listFiles();
        if (old != null) for (File f : old) f.delete();
        dir.mkdirs();
        String name = call.getString("name", "document.pdf").replaceAll("[\\\\/:*?\"<>|]", "_");
        JSObject res = new JSObject();
        res.put("path", new File(dir, name).getAbsolutePath());
        call.resolve(res);
    }

    @PluginMethod
    public void share(PluginCall call) {
        File f = new File(call.getString("path"));
        Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType("application/pdf");
        send.putExtra(Intent.EXTRA_STREAM, uri);
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        Intent chooser = Intent.createChooser(send, call.getString("name", f.getName()));
        chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        getActivity().startActivity(chooser);
        call.resolve();
    }

    // Prints the WebView itself: the print stylesheet shows only the pages
    // print.js rendered (edits and redactions baked in). Resolves once Android
    // has the document, so the page must not be torn down before then.
    @PluginMethod
    public void print(PluginCall call) {
        String name = call.getString("name", "egPDF");
        boolean landscape = call.getBoolean("landscape", false);
        getActivity().runOnUiThread(() -> {
            try {
                PrintManager pm = (PrintManager) getContext().getSystemService(Context.PRINT_SERVICE);
                PrintDocumentAdapter adapter = bridge.getWebView().createPrintDocumentAdapter(name);
                PrintAttributes attrs = new PrintAttributes.Builder()
                    .setMediaSize(landscape ? PrintAttributes.MediaSize.ISO_A4.asLandscape() : PrintAttributes.MediaSize.ISO_A4)
                    .build();
                PrintJob job = pm.print(name, adapter, attrs);
                watchPrintJob(call, job);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        });
    }

    private void watchPrintJob(PluginCall call, PrintJob job) {
        main.postDelayed(() -> {
            if (job.isCancelled() || job.isFailed()) {
                call.reject(job.isCancelled() ? "Print cancelled" : "Printing failed");
            } else if (job.isQueued() || job.isStarted() || job.isCompleted() || job.isBlocked()) {
                call.resolve();
            } else {
                watchPrintJob(call, job);
            }
        }, 500);
    }

    // ------------------------------------------------------------------ app

    @PluginMethod
    public void getVersion(PluginCall call) {
        JSObject res = new JSObject();
        res.put("version", appVersion());
        call.resolve(res);
    }

    @PluginMethod
    public void exitApp(PluginCall call) {
        call.resolve();
        // keep the process (and any open documents) — just step back
        getActivity().runOnUiThread(() -> getActivity().moveTaskToBack(true));
    }

    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url", "");
        if (url.startsWith("https://") || url.startsWith("http://")) {
            getActivity().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        }
        call.resolve();
    }

    private String appVersion() {
        try {
            return getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "0.0.0";
        }
    }

    // ------------------------------------------------------------------ self-update

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences("egpdf", Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void getAutoCheck(PluginCall call) {
        JSObject res = new JSObject();
        res.put("value", prefs().getBoolean("autoUpdateCheck", true));
        call.resolve(res);
    }

    @PluginMethod
    public void setAutoCheck(PluginCall call) {
        prefs().edit().putBoolean("autoUpdateCheck", call.getBoolean("value", true)).apply();
        call.resolve();
    }

    @PluginMethod
    public void updateCheck(PluginCall call) {
        io.execute(() -> {
            try {
                HttpURLConnection con = open("https://api.github.com/repos/" + UPDATE_REPO + "/releases/latest");
                con.setRequestProperty("Accept", "application/vnd.github+json");
                if (con.getResponseCode() != 200) throw new Exception("HTTP " + con.getResponseCode());
                JSONObject rel = new JSONObject(new String(readAll(con.getInputStream()), StandardCharsets.UTF_8));
                String version = rel.optString("tag_name", "").replaceFirst("^v", "");
                String url = null;
                JSONArray assets = rel.optJSONArray("assets");
                for (int k = 0; assets != null && k < assets.length(); k++) {
                    JSONObject a = assets.getJSONObject(k);
                    if (UPDATE_ASSET.equals(a.optString("name"))) url = a.optString("browser_download_url");
                }
                JSObject res = new JSObject();
                // a release without an APK (desktop-only) is not an update here
                res.put("available", url != null && !version.isEmpty() && isNewer(version, appVersion()));
                res.put("version", version);
                res.put("htmlUrl", rel.optString("html_url", null));
                res.put("url", url);
                call.resolve(res);
            } catch (Exception e) {
                call.reject("Could not reach GitHub: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void updateDownload(PluginCall call) {
        String url = call.getString("url");
        String version = call.getString("version", "new");
        io.execute(() -> {
            try {
                if (url == null || !url.startsWith("https://")) throw new Exception("no APK in the latest release");
                File dir = new File(getContext().getCacheDir(), "updates");
                File[] old = dir.listFiles();
                if (old != null) for (File f : old) f.delete();
                dir.mkdirs();
                File dest = new File(dir, "egPDF-" + version.replaceAll("[^0-9A-Za-z.]", "") + ".apk");
                HttpURLConnection con = open(url);
                if (con.getResponseCode() != 200) throw new Exception("HTTP " + con.getResponseCode());
                long total = con.getContentLengthLong();
                try (InputStream in = con.getInputStream(); OutputStream out = new FileOutputStream(dest)) {
                    byte[] buf = new byte[64 * 1024];
                    long got = 0;
                    int n, lastPct = -1;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        got += n;
                        if (total > 0) {
                            int pct = (int) (got * 100 / total);
                            if (pct != lastPct) {
                                lastPct = pct;
                                JSObject ev = new JSObject();
                                ev.put("pct", pct);
                                notifyListeners("updateProgress", ev);
                            }
                        }
                    }
                }
                JSObject res = new JSObject();
                res.put("path", dest.getAbsolutePath());
                call.resolve(res);
            } catch (Exception e) {
                call.reject("Download failed: " + e.getMessage());
            }
        });
    }

    // Hands the APK to Android's package installer, which updates egPDF in place
    // (same signing key) after the user confirms.
    @PluginMethod
    public void updateInstall(PluginCall call) {
        File apk = new File(call.getString("path", ""));
        if (!apk.isFile()) {
            call.reject("The downloaded update is missing — try again.");
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) {
            getActivity().startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName())));
            call.reject("Allow egPDF to install updates, then tap “Update now” again.");
            return;
        }
        Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
        Intent i = new Intent(Intent.ACTION_VIEW);
        i.setDataAndType(uri, "application/vnd.android.package-archive");
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        getActivity().startActivity(i);
        call.resolve();
    }

    private static HttpURLConnection open(String url) throws Exception {
        HttpURLConnection con = (HttpURLConnection) new URL(url).openConnection();
        con.setRequestProperty("User-Agent", UPDATE_UA);
        con.setConnectTimeout(15000);
        con.setReadTimeout(30000);
        con.setInstanceFollowRedirects(true);
        return con;
    }

    // Is `remote` a newer major.minor.patch than `local`? (same rule as main.js)
    static boolean isNewer(String remote, String local) {
        String[] a = remote.split("\\."), b = local.split("\\.");
        for (int k = 0; k < 3; k++) {
            int x = k < a.length ? parseIntSafe(a[k]) : 0;
            int y = k < b.length ? parseIntSafe(b[k]) : 0;
            if (x != y) return x > y;
        }
        return false;
    }

    private static int parseIntSafe(String s) {
        try { return Integer.parseInt(s.replaceAll("[^0-9].*$", "")); } catch (Exception e) { return 0; }
    }

    // ------------------------------------------------------------------ utils

    private static JSArray toArray(List<JSObject> list) {
        JSArray arr = new JSArray();
        for (JSObject o : list) arr.put(o);
        return arr;
    }

    private static byte[] readAll(InputStream in) throws Exception {
        try (InputStream s = in) {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            copy(s, bos);
            return bos.toByteArray();
        }
    }

    private static void copy(InputStream in, OutputStream out) throws Exception {
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    }

    private static String sha1(String s) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-1").digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte x : d) sb.append(String.format("%02x", x));
            return sb.toString();
        } catch (Exception e) {
            return Integer.toHexString(s.hashCode());
        }
    }
}
