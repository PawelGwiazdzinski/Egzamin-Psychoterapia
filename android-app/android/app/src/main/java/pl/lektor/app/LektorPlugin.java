package pl.lektor.app;

import android.Manifest;
import android.app.PendingIntent;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Rect;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.util.Base64;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.IntentCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.Scope;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Natywne funkcje Lektora:
 *  - mowa: systemowy TextToSpeech (preferowane "Usługi Google do zamiany mowy"), zdarzenia start/range/done,
 *  - usługa pierwszoplanowa, żeby czytanie trwało przy wygaszonym ekranie,
 *  - OCR: ML Kit (na urządzeniu),
 *  - logowanie Google (AuthorizationClient) -> token dostępu do Google Docs,
 *  - odbieranie plików PDF / tekstu udostępnionych z innych aplikacji.
 */
@CapacitorPlugin(name = "Lektor")
public class LektorPlugin extends Plugin {
    private static final String GOOGLE_TTS = "com.google.android.tts";
    static LektorPlugin instance;

    private TextToSpeech tts;
    private boolean ttsReady = false;
    private final List<Runnable> pendingTts = new ArrayList<>();
    private String lastQueuedId = null;
    private String title = "Lektor";

    private ActivityResultLauncher<IntentSenderRequest> authLauncher;
    private PluginCall pendingAuth;

    private JSObject pendingShared;
    private TextRecognizer recognizer;

    @Override
    public void load() {
        instance = this;
        initTts();
        authLauncher = getActivity().getActivityResultRegistry().register(
                "lektor-google-auth",
                new ActivityResultContracts.StartIntentSenderForResult(),
                result -> {
                    PluginCall call = pendingAuth;
                    pendingAuth = null;
                    if (call == null) return;
                    try {
                        AuthorizationResult r = Identity.getAuthorizationClient(getActivity())
                                .getAuthorizationResultFromIntent(result.getData());
                        resolveToken(call, r);
                    } catch (ApiException e) {
                        call.reject("Logowanie anulowane lub nieudane (" + e.getStatusCode() + ")");
                    }
                });
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(getContext(),
                Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(getActivity(), new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1001);
        }
        readSharedIntent(getActivity().getIntent(), false);
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        readSharedIntent(intent, true);
    }

    @Override
    protected void handleOnDestroy() {
        if (tts != null) tts.shutdown();
        stopService();
        instance = null;
    }

    // ------------------------------------------------------------------ TTS
    private boolean isInstalled(String pkg) {
        try {
            getContext().getPackageManager().getPackageInfo(pkg, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    private void initTts() {
        TextToSpeech.OnInitListener onInit = status -> {
            ttsReady = status == TextToSpeech.SUCCESS;
            List<Runnable> run = new ArrayList<>(pendingTts);
            pendingTts.clear();
            for (Runnable r : run) r.run();
        };
        tts = isInstalled(GOOGLE_TTS)
                ? new TextToSpeech(getContext(), onInit, GOOGLE_TTS)
                : new TextToSpeech(getContext(), onInit);
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override
            public void onStart(String id) { emit("start", id, -1, -1, null); }

            @Override
            public void onDone(String id) {
                emit("done", id, -1, -1, null);
                if (id != null && id.equals(lastQueuedId)) stopService();
            }

            @Override
            @SuppressWarnings("deprecation")
            public void onError(String id) { emit("error", id, -1, -1, "błąd syntezy mowy"); }

            @Override
            public void onError(String id, int code) {
                emit("error", id, -1, -1, code == TextToSpeech.ERROR_NETWORK || code == TextToSpeech.ERROR_NETWORK_TIMEOUT
                        ? "głos wymaga internetu – wybierz głos offline" : "błąd syntezy mowy (" + code + ")");
            }

            @Override
            public void onRangeStart(String id, int start, int end, int frame) { emit("range", id, start, end, null); }
        });
    }

    private void whenReady(PluginCall call, Runnable r) {
        if (ttsReady) r.run();
        else if (tts == null) call.reject("Brak syntezatora mowy");
        else pendingTts.add(r);
    }

    private void emit(String type, String id, int start, int end, String message) {
        JSObject o = new JSObject();
        o.put("type", type);
        o.put("id", id);
        if (start >= 0) { o.put("start", start); o.put("end", end); }
        if (message != null) o.put("message", message);
        notifyListeners("tts", o);
    }

    @PluginMethod
    public void getVoices(PluginCall call) {
        whenReady(call, () -> {
            JSArray arr = new JSArray();
            Set<Voice> voices = null;
            try { voices = tts.getVoices(); } catch (Exception ignored) { }
            if (voices != null) {
                for (Voice v : voices) {
                    JSObject o = new JSObject();
                    o.put("name", v.getName());
                    o.put("locale", v.getLocale().toLanguageTag());
                    o.put("quality", v.getQuality());
                    o.put("network", v.isNetworkConnectionRequired());
                    o.put("notInstalled", v.getFeatures() != null
                            && v.getFeatures().contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED));
                    arr.put(o);
                }
            }
            JSObject ret = new JSObject();
            ret.put("voices", arr);
            ret.put("engine", tts.getDefaultEngine());
            call.resolve(ret);
        });
    }

    private void applyVoice(String voiceName, String locale) {
        Voice chosen = null;
        if (voiceName != null && !voiceName.isEmpty()) {
            try {
                for (Voice v : tts.getVoices()) if (v.getName().equals(voiceName)) { chosen = v; break; }
            } catch (Exception ignored) { }
        }
        if (chosen != null) tts.setVoice(chosen);
        else tts.setLanguage(Locale.forLanguageTag(locale));
    }

    @PluginMethod
    public void speak(PluginCall call) {
        final JSArray items = call.getArray("items", new JSArray());
        final String voice = call.getString("voice", "");
        final String locale = call.getString("locale", "pl-PL");
        final float rate = call.getFloat("rate", 1f);
        final boolean flush = call.getBoolean("flush", true);
        final String t = call.getString("title", "");
        whenReady(call, () -> {
            try {
                if (flush) tts.stop();
                applyVoice(voice, locale);
                tts.setSpeechRate(rate);
                int max = TextToSpeech.getMaxSpeechInputLength() - 1;
                for (int i = 0; i < items.length(); i++) {
                    JSONObject it = items.getJSONObject(i);
                    String id = it.getString("id");
                    String text = it.getString("text");
                    if (text.length() > max) text = text.substring(0, max);
                    Bundle params = new Bundle();
                    params.putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, id);
                    int mode = (i == 0 && flush) ? TextToSpeech.QUEUE_FLUSH : TextToSpeech.QUEUE_ADD;
                    tts.speak(text, mode, params, id);
                    lastQueuedId = id;
                }
                if (t != null && !t.isEmpty()) title = t;
                startService();
                call.resolve();
            } catch (Exception e) {
                call.reject("Błąd mowy: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (tts != null) tts.stop();
        stopService();
        call.resolve();
    }

    /** Wywoływane z powiadomienia ("Pauza"). */
    void pauseFromNotification() {
        if (tts != null) tts.stop();
        stopService();
        JSObject o = new JSObject();
        o.put("action", "pause");
        notifyListeners("media", o, true);
    }

    @PluginMethod
    public void openTtsSettings(PluginCall call) {
        try {
            Intent i = new Intent("com.android.settings.TTS_SETTINGS");
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        } catch (Exception e) {
            Intent i = new Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        }
        call.resolve();
    }

    private void startService() {
        Intent i = new Intent(getContext(), TtsService.class);
        i.putExtra("title", title);
        try { ContextCompat.startForegroundService(getContext(), i); } catch (Exception ignored) { }
    }

    private void stopService() {
        try { getContext().stopService(new Intent(getContext(), TtsService.class)); } catch (Exception ignored) { }
    }

    // ------------------------------------------------------------------ OCR (ML Kit)
    @PluginMethod
    public void ocr(PluginCall call) {
        String b64 = call.getString("image");
        if (b64 == null) { call.reject("Brak obrazu"); return; }
        byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
        Bitmap bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        if (bmp == null) { call.reject("Nieprawidłowy obraz"); return; }
        if (recognizer == null) recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
        TextRecognizer rec = recognizer;
        rec.process(InputImage.fromBitmap(bmp, 0))
                .addOnSuccessListener(text -> {
                    JSArray blocks = new JSArray();
                    for (Text.TextBlock b : text.getTextBlocks()) {
                        JSArray lines = new JSArray();
                        for (Text.Line l : b.getLines()) {
                            JSArray words = new JSArray();
                            for (Text.Element e : l.getElements()) {
                                Rect r = e.getBoundingBox();
                                if (r == null) continue;
                                JSObject w = new JSObject();
                                w.put("text", e.getText());
                                JSArray box = new JSArray();
                                box.put(r.left); box.put(r.top); box.put(r.right); box.put(r.bottom);
                                w.put("box", box);
                                words.put(w);
                            }
                            JSObject lo = new JSObject();
                            lo.put("words", words);
                            lines.put(lo);
                        }
                        JSObject bo = new JSObject();
                        bo.put("lines", lines);
                        blocks.put(bo);
                    }
                    JSObject ret = new JSObject();
                    ret.put("blocks", blocks);
                    ret.put("width", bmp.getWidth());
                    ret.put("height", bmp.getHeight());
                    call.resolve(ret);
                })
                .addOnFailureListener(e -> call.reject("OCR: " + e.getMessage()));
    }

    // ------------------------------------------------------------------ Google
    @PluginMethod
    public void googleAuthorize(PluginCall call) {
        JSArray arr = call.getArray("scopes", new JSArray());
        boolean interactive = call.getBoolean("interactive", true);
        List<Scope> scopes = new ArrayList<>();
        try {
            for (int i = 0; i < arr.length(); i++) scopes.add(new Scope(arr.getString(i)));
        } catch (Exception e) { call.reject("Złe zakresy"); return; }
        AuthorizationRequest req = AuthorizationRequest.builder().setRequestedScopes(scopes).build();
        Identity.getAuthorizationClient(getActivity()).authorize(req)
                .addOnSuccessListener(res -> {
                    if (res.hasResolution()) {
                        if (!interactive) { call.reject("Wymagane logowanie"); return; }
                        PendingIntent pi = res.getPendingIntent();
                        if (pi == null) { call.reject("Brak okna logowania"); return; }
                        pendingAuth = call;
                        authLauncher.launch(new IntentSenderRequest.Builder(pi.getIntentSender()).build());
                    } else {
                        resolveToken(call, res);
                    }
                })
                .addOnFailureListener(e -> call.reject("Google: " + e.getMessage()));
    }

    private void resolveToken(PluginCall call, AuthorizationResult r) {
        String token = r.getAccessToken();
        if (token == null) { call.reject("Brak tokenu Google"); return; }
        JSObject o = new JSObject();
        o.put("accessToken", token);
        call.resolve(o);
    }

    // ------------------------------------------------------------------ udostępnione pliki
    @PluginMethod
    public void getSharedFile(PluginCall call) {
        JSObject o = pendingShared != null ? pendingShared : new JSObject();
        pendingShared = null;
        call.resolve(o);
    }

    private void readSharedIntent(Intent intent, boolean notify) {
        if (intent == null) return;
        String action = intent.getAction();
        Uri uri = null;
        String text = null;
        if (Intent.ACTION_VIEW.equals(action)) uri = intent.getData();
        else if (Intent.ACTION_SEND.equals(action)) {
            uri = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri.class);
            if (uri == null) text = intent.getStringExtra(Intent.EXTRA_TEXT);
        } else return;
        final Uri fUri = uri;
        final String fText = text;
        final String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        intent.setAction(null); // nie importuj ponownie po obrocie ekranu
        new Thread(() -> {
            JSObject o = new JSObject();
            try {
                if (fUri != null) {
                    ContentResolver cr = getContext().getContentResolver();
                    String name = "dokument.pdf";
                    try (Cursor c = cr.query(fUri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                        if (c != null && c.moveToFirst()) name = c.getString(0);
                    } catch (Exception ignored) { }
                    try (InputStream in = cr.openInputStream(fUri)) {
                        ByteArrayOutputStream bos = new ByteArrayOutputStream();
                        byte[] buf = new byte[1 << 16];
                        int n;
                        while (in != null && (n = in.read(buf)) > 0) bos.write(buf, 0, n);
                        String mime = cr.getType(fUri);
                        if (mime != null && mime.startsWith("text/")) o.put("text", bos.toString("UTF-8"));
                        else o.put("data", Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP));
                    }
                    o.put("name", name);
                } else if (fText != null) {
                    o.put("text", fText);
                    o.put("name", subject != null ? subject : "Udostępniony tekst");
                } else return;
            } catch (Exception e) {
                o.put("error", e.getMessage());
            }
            // retain=true: dostarczy zdarzenie także, gdy JS jeszcze nie nasłuchuje (start aplikacji)
            notifyListeners("sharedFile", o, true);
        }).start();
    }
}
