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
import android.provider.OpenableColumns;
import android.speech.tts.TextToSpeech;
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

/**
 * Most między aplikacją (WebView) a Androidem:
 *  - czytanie (Playback: głosy Edge / głosy telefonu, tło, słuchawki, powiadomienie),
 *  - OCR skanów (ML Kit, na urządzeniu),
 *  - logowanie Google (opcjonalne, OAuth),
 *  - pliki udostępnione z innych aplikacji i linki lektor://.
 */
@CapacitorPlugin(name = "Lektor")
public class LektorPlugin extends Plugin implements Playback.Listener {
    static LektorPlugin instance;

    private static final String[][] EDGE_VOICES = {
            {"pl-PL-MarekNeural", "Marek ♂", "pl-PL"},
            {"pl-PL-ZofiaNeural", "Zofia ♀", "pl-PL"},
            {"en-US-AndrewMultilingualNeural", "Andrew ♂", "en-US"},
            {"en-US-BrianMultilingualNeural", "Brian ♂", "en-US"},
            {"en-GB-RyanNeural", "Ryan (GB) ♂", "en-GB"},
            {"en-US-GuyNeural", "Guy ♂", "en-US"},
            {"en-US-AvaMultilingualNeural", "Ava ♀", "en-US"},
            {"en-GB-SoniaNeural", "Sonia (GB) ♀", "en-GB"},
    };

    private Playback playback;
    private ActivityResultLauncher<IntentSenderRequest> authLauncher;
    private PluginCall pendingAuth;
    private TextRecognizer recognizer;

    @Override
    public void load() {
        instance = this;
        playback = Playback.get(getContext());
        playback.setListener(this);
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
        readIntent(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        readIntent(intent);
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) {
            instance = null;
            if (playback != null) playback.setListener(null); // czytanie trwa dalej w tle
        }
    }

    // ------------------------------------------------------------------ zdarzenia z Playback
    @Override
    public void onTts(JSObject e) {
        notifyListeners("tts", e);
    }

    @Override
    public void onState(JSObject s) {
        notifyListeners("state", s);
    }

    // ------------------------------------------------------------------ głosy
    @PluginMethod
    public void getVoices(PluginCall call) {
        String engine = call.getString("engine", "system");
        if ("edge".equals(engine)) {
            JSArray arr = new JSArray();
            for (String[] v : EDGE_VOICES) {
                JSObject o = new JSObject();
                o.put("name", v[0]);
                o.put("label", v[1]);
                o.put("locale", v[2]);
                o.put("male", v[1].contains("♂"));
                o.put("network", true);
                o.put("notInstalled", false);
                arr.put(o);
            }
            JSObject ret = new JSObject();
            ret.put("voices", arr);
            ret.put("engine", "edge");
            call.resolve(ret);
            return;
        }
        SystemTtsSpeaker sys = playback.systemSpeaker();
        sys.whenReady(() -> {
            JSArray arr = new JSArray();
            for (Voice v : sys.voices()) {
                JSObject o = new JSObject();
                o.put("name", v.getName());
                o.put("locale", v.getLocale().toLanguageTag());
                o.put("quality", v.getQuality());
                o.put("network", v.isNetworkConnectionRequired());
                o.put("notInstalled", v.getFeatures() != null
                        && v.getFeatures().contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED));
                arr.put(o);
            }
            JSObject ret = new JSObject();
            ret.put("voices", arr);
            ret.put("engine", sys.engineName());
            ret.put("ready", sys.isReady());
            ret.put("googleInstalled", SystemTtsSpeaker.isInstalled(getContext(), SystemTtsSpeaker.GOOGLE_TTS));
            call.resolve(ret);
        });
    }

    // ------------------------------------------------------------------ odtwarzanie
    @PluginMethod
    public void load(PluginCall call) {
        JSArray arr = call.getArray("items", new JSArray());
        List<Speaker.Item> items = new ArrayList<>(arr.length());
        try {
            for (int i = 0; i < arr.length(); i++) {
                JSONObject it = arr.getJSONObject(i);
                items.add(new Speaker.Item(it.getString("id"), it.getString("text")));
            }
        } catch (Exception e) {
            call.reject("Nieprawidłowa lista zdań");
            return;
        }
        playback.load(items,
                call.getInt("index", 0),
                call.getString("engine", "edge"),
                call.getString("voice", ""),
                call.getString("locale", "pl-PL"),
                call.getFloat("rate", 1f),
                call.getString("title", ""),
                call.getBoolean("autoplay", true));
        call.resolve(playback.state());
    }

    @PluginMethod
    public void play(PluginCall call) {
        playback.play();
        call.resolve(playback.state());
    }

    @PluginMethod
    public void pause(PluginCall call) {
        playback.pause();
        call.resolve(playback.state());
    }

    @PluginMethod
    public void stop(PluginCall call) {
        playback.stop();
        call.resolve(playback.state());
    }

    @PluginMethod
    public void next(PluginCall call) {
        playback.next();
        call.resolve(playback.state());
    }

    @PluginMethod
    public void prev(PluginCall call) {
        playback.prev();
        call.resolve(playback.state());
    }

    @PluginMethod
    public void seek(PluginCall call) {
        playback.seek(call.getInt("index", 0));
        call.resolve(playback.state());
    }

    @PluginMethod
    public void setRate(PluginCall call) {
        playback.setRate(call.getFloat("rate", 1f));
        call.resolve(playback.state());
    }

    @PluginMethod
    public void setVoice(PluginCall call) {
        playback.setVoice(call.getString("engine", "edge"), call.getString("voice", ""), call.getString("locale", "pl-PL"));
        call.resolve(playback.state());
    }

    @PluginMethod
    public void setSleepTimer(PluginCall call) {
        playback.setSleepTimer(call.getInt("minutes", 0));
        call.resolve(playback.state());
    }

    @PluginMethod
    public void getState(PluginCall call) {
        call.resolve(playback.state());
    }

    // ------------------------------------------------------------------ ustawienia głosów telefonu
    @PluginMethod
    public void openTtsSettings(PluginCall call) {
        try {
            Intent i = new Intent("com.android.settings.TTS_SETTINGS");
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        } catch (Exception e) {
            Intent i = new Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                getContext().startActivity(i);
            } catch (Exception ignored) { }
        }
        call.resolve();
    }

    /** Otwiera ekran pobierania głosów Google (albo sklep, jeśli silnika Google nie ma). */
    @PluginMethod
    public void installVoices(PluginCall call) {
        boolean google = SystemTtsSpeaker.isInstalled(getContext(), SystemTtsSpeaker.GOOGLE_TTS);
        try {
            if (google) {
                Intent i = new Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA);
                i.setPackage(SystemTtsSpeaker.GOOGLE_TTS);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
            } else {
                Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + SystemTtsSpeaker.GOOGLE_TTS));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
            }
        } catch (Exception e) {
            openTtsSettings(call);
            return;
        }
        JSObject r = new JSObject();
        r.put("googleInstalled", google);
        call.resolve(r);
    }

    // ------------------------------------------------------------------ OCR (ML Kit)
    @PluginMethod
    public void ocr(PluginCall call) {
        String b64 = call.getString("image");
        if (b64 == null) {
            call.reject("Brak obrazu");
            return;
        }
        byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
        Bitmap bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        if (bmp == null) {
            call.reject("Nieprawidłowy obraz");
            return;
        }
        if (recognizer == null) recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
        recognizer.process(InputImage.fromBitmap(bmp, 0))
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
                                box.put(r.left);
                                box.put(r.top);
                                box.put(r.right);
                                box.put(r.bottom);
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

    // ------------------------------------------------------------------ Google (OAuth, opcjonalnie)
    @PluginMethod
    public void googleAuthorize(PluginCall call) {
        JSArray arr = call.getArray("scopes", new JSArray());
        boolean interactive = call.getBoolean("interactive", true);
        List<Scope> scopes = new ArrayList<>();
        try {
            for (int i = 0; i < arr.length(); i++) scopes.add(new Scope(arr.getString(i)));
        } catch (Exception e) {
            call.reject("Złe zakresy");
            return;
        }
        AuthorizationRequest req = AuthorizationRequest.builder().setRequestedScopes(scopes).build();
        Identity.getAuthorizationClient(getActivity()).authorize(req)
                .addOnSuccessListener(res -> {
                    if (res.hasResolution()) {
                        if (!interactive) {
                            call.reject("Wymagane logowanie");
                            return;
                        }
                        PendingIntent pi = res.getPendingIntent();
                        if (pi == null) {
                            call.reject("Brak okna logowania");
                            return;
                        }
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
        if (token == null) {
            call.reject("Brak tokenu Google");
            return;
        }
        JSObject o = new JSObject();
        o.put("accessToken", token);
        call.resolve(o);
    }

    // ------------------------------------------------------------------ pliki i linki z zewnątrz
    private void readIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        Uri uri = null;
        String text = null;
        if (Intent.ACTION_VIEW.equals(action)) {
            uri = intent.getData();
            if (uri != null && "lektor".equalsIgnoreCase(uri.getScheme())) {
                JSObject o = new JSObject();
                o.put("url", uri.toString());
                o.put("host", uri.getHost());
                for (String k : uri.getQueryParameterNames()) o.put(k, uri.getQueryParameter(k));
                intent.setAction(null);
                notifyListeners("appLink", o, true);
                return;
            }
        } else if (Intent.ACTION_SEND.equals(action)) {
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
            notifyListeners("sharedFile", o, true);
        }).start();
    }
}
