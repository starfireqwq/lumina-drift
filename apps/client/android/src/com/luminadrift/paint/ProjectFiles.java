package com.luminadrift.paint;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.webkit.JsPromptResult;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

final class ProjectFiles {
    static final int SAVE_DOCUMENT = 201;
    private final Activity activity;
    private final ExecutorService writer = Executors.newSingleThreadExecutor();
    private final File transfer;
    private FileOutputStream stream;
    private JsPromptResult pending;

    ProjectFiles(Activity activity) {
        this.activity = activity;
        transfer = new File(activity.getCacheDir(), "project-transfer");
    }

    void begin() throws Exception {
        if (stream != null || pending != null) throw new Exception("請等待目前的儲存完成。");
        stream = new FileOutputStream(transfer);
    }

    void chunk(String encoded) throws Exception {
        if (stream == null) throw new Exception("檔案傳輸尚未開始。");
        stream.write(android.util.Base64.decode(encoded, android.util.Base64.DEFAULT));
    }

    void discard() throws Exception {
        if (stream != null) stream.close();
        stream = null;
        pending = null;
        transfer.delete();
    }

    void save(JSONObject payload, JsPromptResult result) throws Exception {
        if (stream == null || pending != null) throw new Exception("檔案尚未準備完成。");
        stream.getFD().sync();
        stream.close();
        stream = null;
        pending = result;
        Uri existing = Uri.parse(payload.optString("existingFilePath"));
        boolean writable = activity.getContentResolver().getPersistedUriPermissions().stream()
            .anyMatch(permission -> permission.isWritePermission() && permission.getUri().equals(existing));
        if (writable) {
            write(existing);
            return;
        }
        if (payload.optBoolean("onlyExisting")) {
            complete("{\"error\":\"上次的儲存位置已無法存取，請另存新檔。\"}");
            return;
        }
        String name = payload.optString("defaultName", "artwork.lumina");
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(name.endsWith(".png") ? "image/png" : "application/octet-stream");
        intent.putExtra(Intent.EXTRA_TITLE, name);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        activity.startActivityForResult(intent, SAVE_DOCUMENT);
    }

    void onResult(int code, Intent data) {
        if (pending == null) return;
        if (code != Activity.RESULT_OK || data == null || data.getData() == null) {
            complete("{\"saved\":false}");
            return;
        }
        Uri uri = data.getData();
        try {
            activity.getContentResolver().takePersistableUriPermission(uri,
                data.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION));
            write(uri);
        } catch (Exception error) {
            fail(error);
        }
    }

    private void write(Uri uri) {
        writer.execute(() -> {
            try (FileInputStream input = new FileInputStream(transfer);
                 OutputStream output = activity.getContentResolver().openOutputStream(uri, "wt")) {
                if (output == null) throw new Exception("無法寫入選擇的檔案。");
                byte[] buffer = new byte[65536];
                int count;
                while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                output.flush();
                JSONObject response = new JSONObject().put("saved", true).put("filePath", uri.toString());
                activity.runOnUiThread(() -> complete(response.toString()));
            } catch (Exception error) {
                activity.runOnUiThread(() -> fail(error));
            }
        });
    }

    private void fail(Exception error) {
        complete("{\"error\":" + JSONObject.quote(error.getMessage()) + "}");
    }

    private void complete(String value) {
        JsPromptResult result = pending;
        pending = null;
        transfer.delete();
        if (result != null) result.confirm(value);
    }
}
