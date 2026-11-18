package com.luminadrift.paint;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.JsPromptResult;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.net.URLConnection;
import org.json.JSONObject;

public final class MainActivity extends Activity {
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final int OPEN_DOCUMENT = 202;
    private static final int AUDIO_PERMISSION = 203;
    private WebView web;
    private ProjectFiles files;
    private ValueCallback<Uri[]> openFiles;
    private PermissionRequest audioRequest;
    private boolean closing;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        files = new ProjectFiles(this);
        web = new WebView(this);
        setContentView(web);
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            web.setOnApplyWindowInsetsListener((view, insets) -> {
                android.graphics.Insets bars = insets.getInsets(
                    android.view.WindowInsets.Type.systemBars()
                    | android.view.WindowInsets.Type.displayCutout()
                    | android.view.WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return insets;
            });
        }
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        // Hosts can serve rooms over HTTP or HTTPS.
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(false);
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (!trusted(uri.toString())) return null;
                String path = uri.getPath();
                if (path == null || path.contains("..") || path.contains("\\")
                    || !path.startsWith("/assets/")) return missing();
                String asset = path.substring("/assets/".length());
                try {
                    String mime = URLConnection.guessContentTypeFromName(asset);
                    if (asset.endsWith(".js") || asset.endsWith(".mjs")) mime = "text/javascript";
                    if (asset.endsWith(".svg")) mime = "image/svg+xml";
                    if (asset.endsWith(".css")) mime = "text/css";
                    if (asset.endsWith(".json")) mime = "application/json";
                    if (asset.endsWith(".wasm")) mime = "application/wasm";
                    InputStream input = getAssets().open("web/" + asset);
                    return new WebResourceResponse(mime == null ? "application/octet-stream" : mime, "UTF-8", input);
                } catch (Exception error) {
                    return missing();
                }
            }

            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (trusted(url)) return false;
                if ("http".equals(request.getUrl().getScheme()) || "https".equals(request.getUrl().getScheme())) {
                    startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()));
                }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onJsPrompt(WebView view, String url, String message, String value, JsPromptResult result) {
                if (!trusted(url) || !message.startsWith("lumina:")) return false;
                try {
                    JSONObject payload = new JSONObject(message.substring("lumina:".length()));
                    switch (payload.getString("action")) {
                        case "begin": files.begin(); break;
                        case "chunk": files.chunk(payload.getString("data")); break;
                        case "discard": files.discard(); break;
                        case "save": files.save(payload, result); return true;
                        case "storage":
                            result.confirm(new JSONObject().put("path", getDataDir() + "/app_webview/Default/IndexedDB").toString());
                            return true;
                        case "close":
                            result.confirm("{}");
                            if (payload.has("error")) closeFailed(payload.optString("error"));
                            else finish();
                            return true;
                        default: throw new Exception("Unknown native operation");
                    }
                    result.confirm("{}");
                } catch (Exception error) {
                    result.confirm("{\"error\":" + JSONObject.quote(error.getMessage()) + "}");
                }
                return true;
            }

            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (openFiles != null) openFiles.onReceiveValue(null);
                openFiles = callback;
                Intent intent = params.createIntent();
                // Extensions such as .abr and .lumina are not registered Android MIME types.
                intent.setType("*/*");
                try {
                    startActivityForResult(intent, OPEN_DOCUMENT);
                    return true;
                } catch (Exception error) {
                    openFiles = null;
                    return false;
                }
            }

            @Override public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    if (!trusted(request.getOrigin().toString()) || request.getResources().length != 1
                        || !PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(request.getResources()[0])) {
                        request.deny();
                    } else if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(new String[] {PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                    } else {
                        if (audioRequest != null) audioRequest.deny();
                        audioRequest = request;
                        requestPermissions(new String[] {Manifest.permission.RECORD_AUDIO}, AUDIO_PERMISSION);
                    }
                });
            }
        });
        web.loadUrl(ORIGIN + "/assets/index.html");
    }

    private static boolean trusted(String url) {
        Uri uri = Uri.parse(url);
        return "https".equals(uri.getScheme()) && "appassets.androidplatform.net".equals(uri.getHost());
    }

    private static WebResourceResponse missing() {
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found",
            java.util.Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == ProjectFiles.SAVE_DOCUMENT) files.onResult(result, data);
        if (request == OPEN_DOCUMENT && openFiles != null) {
            openFiles.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
            openFiles = null;
        }
    }

    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request != AUDIO_PERMISSION || audioRequest == null) return;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
            audioRequest.grant(new String[] {PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        } else audioRequest.deny();
        audioRequest = null;
    }

    @Override public void onBackPressed() {
        if (closing) return;
        closing = true;
        web.evaluateJavascript("window.dispatchEvent(new Event('lumina-prepare-close'))", null);
    }

    private void closeFailed(String error) {
        closing = false;
        new AlertDialog.Builder(this).setTitle("關閉前的儲存尚未完成").setMessage(error)
            .setNegativeButton("返回畫布", null).setPositiveButton("仍要關閉", (dialog, button) -> finish()).show();
    }

    @Override protected void onPause() {
        web.evaluateJavascript("window.dispatchEvent(new Event('pagehide'))", null);
        super.onPause();
    }
}
