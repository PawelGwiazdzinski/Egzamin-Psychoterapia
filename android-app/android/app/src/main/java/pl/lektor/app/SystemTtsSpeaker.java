package pl.lektor.app;

import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/** Głosy telefonu (systemowy TextToSpeech, najchętniej "Usługi Google do zamiany mowy"). */
final class SystemTtsSpeaker implements Speaker {
    static final String GOOGLE_TTS = "com.google.android.tts";
    private static final int LOOKAHEAD = 6;

    private final Callback cb;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final List<Runnable> pending = new ArrayList<>();
    private TextToSpeech tts;
    private boolean ready;
    private boolean failed;

    private List<Item> items = Collections.emptyList();
    private final Map<String, Integer> indexOf = new HashMap<>();
    private int feedPos;
    private int lastStarted = -1;
    private int generation;
    private boolean active;
    private String voice = "";
    private String locale = "pl-PL";
    private float rate = 1f;

    SystemTtsSpeaker(Context ctx, Callback cb) {
        this.cb = cb;
        TextToSpeech.OnInitListener onInit = status -> main.post(() -> {
            ready = status == TextToSpeech.SUCCESS;
            failed = !ready;
            List<Runnable> run = new ArrayList<>(pending);
            pending.clear();
            for (Runnable r : run) r.run();
        });
        tts = isInstalled(ctx, GOOGLE_TTS) ? new TextToSpeech(ctx, onInit, GOOGLE_TTS) : new TextToSpeech(ctx, onInit);
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override
            public void onStart(String uid) {
                main.post(() -> handleStart(uid));
            }

            @Override
            public void onDone(String uid) {
                main.post(() -> handleDone(uid));
            }

            @Override
            @SuppressWarnings("deprecation")
            public void onError(String uid) {
                main.post(() -> handleError(uid, -1));
            }

            @Override
            public void onError(String uid, int code) {
                main.post(() -> handleError(uid, code));
            }

            @Override
            public void onRangeStart(String uid, int start, int end, int frame) {
                main.post(() -> handleRange(uid, start, end));
            }
        });
    }

    static boolean isInstalled(Context ctx, String pkg) {
        try {
            ctx.getPackageManager().getPackageInfo(pkg, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    void whenReady(Runnable r) {
        if (ready || failed) r.run();
        else pending.add(r);
    }

    boolean isReady() {
        return ready;
    }

    String engineName() {
        try {
            return tts != null ? tts.getDefaultEngine() : "";
        } catch (Exception e) {
            return "";
        }
    }

    /** Lista głosów (tylko gdy silnik gotowy). */
    List<Voice> voices() {
        if (!ready) return Collections.emptyList();
        try {
            Set<Voice> set = tts.getVoices();
            return set == null ? Collections.<Voice>emptyList() : new ArrayList<>(set);
        } catch (Exception e) {
            return Collections.emptyList();
        }
    }

    // ------------------------------------------------------------------ Speaker
    @Override
    public void setVoice(String voice, String locale) {
        this.voice = voice == null ? "" : voice;
        if (locale != null && !locale.isEmpty()) this.locale = locale;
    }

    @Override
    public void setRate(float rate) {
        this.rate = rate;
        if (ready) tts.setSpeechRate(rate);
    }

    @Override
    public void start(List<Item> items, int from) {
        whenReady(() -> {
            generation++;
            if (!ready) {
                String id = from < items.size() ? items.get(from).id : "";
                cb.onError(id, "Brak syntezatora mowy w telefonie. Zainstaluj „Usługi Google do zamiany mowy”.", false);
                return;
            }
            tts.stop();
            this.items = items;
            indexOf.clear();
            for (int i = 0; i < items.size(); i++) indexOf.put(items.get(i).id, i);
            feedPos = from;
            lastStarted = from - 1;
            active = true;
            applyVoice();
            tts.setSpeechRate(rate);
            feed(true);
        });
    }

    private void applyVoice() {
        Voice chosen = null;
        if (!voice.isEmpty()) {
            for (Voice v : voices()) {
                if (v.getName().equals(voice)) {
                    chosen = v;
                    break;
                }
            }
        }
        try {
            if (chosen != null) tts.setVoice(chosen);
            else tts.setLanguage(Locale.forLanguageTag(locale));
        } catch (Exception ignored) { }
    }

    private void feed(boolean first) {
        int max = TextToSpeech.getMaxSpeechInputLength() - 1;
        while (active && feedPos < items.size() && feedPos - lastStarted <= LOOKAHEAD) {
            Item it = items.get(feedPos);
            String text = it.text.length() > max ? it.text.substring(0, max) : it.text;
            Bundle params = new Bundle();
            String uid = generation + ":" + it.id;
            params.putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, uid);
            int mode = first ? TextToSpeech.QUEUE_FLUSH : TextToSpeech.QUEUE_ADD;
            int r = tts.speak(text, mode, params, uid);
            first = false;
            feedPos++;
            if (r != TextToSpeech.SUCCESS) {
                cb.onError(it.id, "Syntezator mowy odrzucił tekst", false);
                active = false;
                return;
            }
        }
    }

    private String idOf(String uid) {
        int i = uid.indexOf(':');
        if (i < 0) return null;
        try {
            if (Integer.parseInt(uid.substring(0, i)) != generation) return null;
        } catch (NumberFormatException e) {
            return null;
        }
        return uid.substring(i + 1);
    }

    private void handleStart(String uid) {
        String id = idOf(uid);
        if (id == null || !active) return;
        Integer idx = indexOf.get(id);
        if (idx != null) lastStarted = idx;
        cb.onStart(id);
        feed(false);
    }

    private void handleRange(String uid, int start, int end) {
        String id = idOf(uid);
        if (id == null || !active) return;
        cb.onRange(id, start, end);
    }

    private void handleDone(String uid) {
        String id = idOf(uid);
        if (id == null || !active) return;
        cb.onDone(id);
    }

    private void handleError(String uid, int code) {
        String id = idOf(uid);
        if (id == null || !active) return;
        active = false;
        boolean network = code == TextToSpeech.ERROR_NETWORK || code == TextToSpeech.ERROR_NETWORK_TIMEOUT;
        String msg = network ? "Ten głos wymaga internetu – wybierz głos offline w ustawieniach"
                : code == TextToSpeech.ERROR_NOT_INSTALLED_YET ? "Głos nie jest jeszcze pobrany – pobierz go w ustawieniach głosów telefonu"
                : "Błąd syntezatora mowy (" + code + ")";
        cb.onError(id, msg, network);
    }

    @Override
    public void pause() {
        active = false;
        generation++;
        if (ready) tts.stop();
    }

    @Override
    public boolean resume() {
        return false; // systemowy TTS nie wznawia w środku zdania
    }

    @Override
    public void stop() {
        pause();
    }

    @Override
    public void release() {
        stop();
        try {
            tts.shutdown();
        } catch (Exception ignored) { }
    }
}
