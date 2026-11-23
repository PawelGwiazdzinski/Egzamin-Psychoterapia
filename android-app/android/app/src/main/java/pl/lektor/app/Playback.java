package pl.lektor.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.drawable.Icon;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Kontroler czytania po stronie Androida: kolejka zdań, silnik mowy, fokus audio, MediaSession
 * (słuchawki, ekran blokady) i powiadomienie. Działa niezależnie od WebView, więc czytanie trwa w tle.
 */
final class Playback implements Speaker.Callback {
    interface Listener {
        void onTts(JSObject e);

        void onState(JSObject s);
    }

    static final String CHANNEL = "lektor_reading";
    static final int NOTIFICATION_ID = 1;
    static final String ENGINE_EDGE = "edge";
    static final String ENGINE_SYSTEM = "system";

    private static Playback instance;

    static synchronized Playback get(Context ctx) {
        if (instance == null) instance = new Playback(ctx.getApplicationContext());
        return instance;
    }

    private final Context app;
    private final Handler main = new Handler(Looper.getMainLooper());
    private Listener listener;

    private List<Speaker.Item> items = new ArrayList<>();
    private final Map<String, Integer> indexOf = new HashMap<>();
    private int index = -1;
    private boolean playing;
    private boolean buffering;
    private boolean finished;
    private boolean pausedMidSentence;
    private String engine = ENGINE_EDGE;
    private String voice = "";
    private String locale = "pl-PL";
    private float rate = 1f;
    private String title = "Lektor";
    private String lastError;
    private boolean fallenBack;

    private final SystemTtsSpeaker system;
    private final EdgeSpeaker edge;
    private Speaker speaker;

    private MediaSession session;
    private final AudioManager audioManager;
    private AudioFocusRequest focusRequest;
    private boolean hasFocus;
    private boolean resumeOnFocus;
    private final AudioManager.OnAudioFocusChangeListener focusListener = change -> {
        switch (change) {
            case AudioManager.AUDIOFOCUS_LOSS:
                resumeOnFocus = false;
                if (playing) pause();
                break;
            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT:
            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK:
                if (playing) {
                    resumeOnFocus = true;
                    pause();
                }
                break;
            case AudioManager.AUDIOFOCUS_GAIN:
                if (resumeOnFocus) {
                    resumeOnFocus = false;
                    play();
                }
                break;
            default:
                break;
        }
    };
    private final BroadcastReceiver noisyReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (playing) pause();
        }
    };
    private boolean noisyRegistered;

    private Runnable sleepRunnable;
    private long sleepEndsAt;

    private Playback(Context app) {
        this.app = app;
        audioManager = (AudioManager) app.getSystemService(Context.AUDIO_SERVICE);
        system = new SystemTtsSpeaker(app, this);
        edge = new EdgeSpeaker(app, this);
        speaker = edge;
        createChannel();
    }

    void setListener(Listener l) {
        listener = l;
    }

    SystemTtsSpeaker systemSpeaker() {
        return system;
    }

    // ------------------------------------------------------------------ sterowanie
    void load(List<Speaker.Item> newItems, int startIndex, String engineName, String voiceName, String loc, float r,
              String docTitle, boolean autoplay) {
        speaker.stop();
        items = newItems;
        indexOf.clear();
        for (int i = 0; i < items.size(); i++) indexOf.put(items.get(i).id, i);
        index = Math.max(0, Math.min(startIndex, items.size() - 1));
        finished = false;
        pausedMidSentence = false;
        fallenBack = false;
        lastError = null;
        if (docTitle != null && !docTitle.isEmpty()) title = docTitle;
        applyEngine(engineName, voiceName, loc, false);
        rate = r;
        system.setRate(r);
        edge.setRate(r);
        updateMetadata();
        if (autoplay) startAt(index);
        else emitState();
    }

    void play() {
        if (items.isEmpty()) return;
        if (finished) index = 0;
        if (playing) return;
        if (pausedMidSentence && speaker.resume()) {
            playing = true;
            pausedMidSentence = false;
            requestFocus();
            onPlayingChanged();
            return;
        }
        startAt(index < 0 ? 0 : index);
    }

    void pause() {
        if (!playing) return;
        speaker.pause();
        playing = false;
        pausedMidSentence = engine.equals(ENGINE_EDGE);
        buffering = false;
        onPlayingChanged();
    }

    void stop() {
        speaker.stop();
        playing = false;
        pausedMidSentence = false;
        buffering = false;
        abandonFocus();
        if (session != null) session.setActive(false);
        stopService();
        emitState();
    }

    void next() {
        if (index + 1 < items.size()) startAt(index + 1);
    }

    void prev() {
        startAt(Math.max(0, index - 1));
    }

    void seek(int i) {
        if (items.isEmpty()) return;
        i = Math.max(0, Math.min(i, items.size() - 1));
        if (playing) startAt(i);
        else {
            index = i;
            pausedMidSentence = false;
            finished = false;
            emitState();
        }
    }

    void setRate(float r) {
        rate = r;
        system.setRate(r);
        edge.setRate(r);
        if (playing && speaker == system) startAt(index);
        emitState();
    }

    void setVoice(String engineName, String voiceName, String loc) {
        boolean wasPlaying = playing;
        applyEngine(engineName, voiceName, loc, true);
        if (wasPlaying) startAt(index);
        else emitState();
    }

    void setSleepTimer(int minutes) {
        if (sleepRunnable != null) main.removeCallbacks(sleepRunnable);
        sleepRunnable = null;
        sleepEndsAt = 0;
        if (minutes > 0) {
            sleepEndsAt = System.currentTimeMillis() + minutes * 60_000L;
            sleepRunnable = () -> {
                sleepRunnable = null;
                sleepEndsAt = 0;
                if (playing) pause();
                JSObject s = state();
                s.put("sleep", true);
                if (listener != null) listener.onState(s);
            };
            main.postDelayed(sleepRunnable, minutes * 60_000L);
        }
        emitState();
    }

    private void applyEngine(String engineName, String voiceName, String loc, boolean stopCurrent) {
        String e = ENGINE_SYSTEM.equals(engineName) ? ENGINE_SYSTEM : ENGINE_EDGE;
        Speaker next = e.equals(ENGINE_EDGE) ? edge : system;
        if (stopCurrent && next != speaker) speaker.stop();
        engine = e;
        speaker = next;
        voice = voiceName == null ? "" : voiceName;
        if (loc != null && !loc.isEmpty()) locale = loc;
        if (voice.isEmpty() && e.equals(ENGINE_EDGE)) voice = locale.startsWith("pl") ? "pl-PL-MarekNeural" : "en-US-AndrewMultilingualNeural";
        speaker.setVoice(voice, locale);
    }

    private void startAt(int i) {
        if (items.isEmpty()) return;
        index = Math.max(0, Math.min(i, items.size() - 1));
        finished = false;
        pausedMidSentence = false;
        playing = true;
        lastError = null;
        requestFocus();
        speaker.start(items, index);
        onPlayingChanged();
    }

    // ------------------------------------------------------------------ Speaker.Callback (wątek główny)
    @Override
    public void onStart(String id) {
        Integer i = indexOf.get(id);
        if (i != null) index = i;
        buffering = false;
        JSObject e = new JSObject();
        e.put("type", "start");
        e.put("id", id);
        e.put("index", index);
        if (listener != null) listener.onTts(e);
        emitState();
        updateNotification();
    }

    @Override
    public void onRange(String id, int start, int end) {
        if (listener == null) return;
        JSObject e = new JSObject();
        e.put("type", "range");
        e.put("id", id);
        e.put("start", start);
        e.put("end", end);
        listener.onTts(e);
    }

    @Override
    public void onDone(String id) {
        JSObject e = new JSObject();
        e.put("type", "done");
        e.put("id", id);
        if (listener != null) listener.onTts(e);
        Integer i = indexOf.get(id);
        if (i != null && i >= items.size() - 1) {
            finished = true;
            playing = false;
            pausedMidSentence = false;
            abandonFocus();
            onPlayingChanged();
            stopService();
        }
    }

    @Override
    public void onBuffering(String id, boolean b) {
        if (buffering == b) return;
        buffering = b;
        emitState();
    }

    @Override
    public void onError(String id, String message, boolean network) {
        lastError = message;
        if (speaker == edge && !fallenBack && system.isReady()) {
            // Głosy Edge niedostępne (np. brak internetu) – czytamy dalej głosem telefonu.
            fallenBack = true;
            edge.stop();
            engine = ENGINE_SYSTEM;
            speaker = system;
            voice = "";
            system.setVoice("", locale);
            JSObject s = state();
            s.put("fallback", true);
            s.put("message", message);
            if (listener != null) listener.onState(s);
            if (playing) {
                speaker.start(items, index);
                updateNotification();
            }
            return;
        }
        playing = false;
        pausedMidSentence = false;
        buffering = false;
        JSObject e = new JSObject();
        e.put("type", "error");
        e.put("id", id);
        e.put("message", message);
        e.put("network", network);
        if (listener != null) listener.onTts(e);
        abandonFocus();
        onPlayingChanged();
    }

    // ------------------------------------------------------------------ stan
    JSObject state() {
        JSObject s = new JSObject();
        s.put("playing", playing);
        s.put("buffering", buffering);
        s.put("index", index);
        s.put("id", index >= 0 && index < items.size() ? items.get(index).id : "");
        s.put("engine", engine);
        s.put("voice", voice);
        s.put("locale", locale);
        s.put("rate", rate);
        s.put("loaded", items.size());
        s.put("finished", finished);
        s.put("sleepEndsAt", sleepEndsAt);
        if (lastError != null) s.put("error", lastError);
        return s;
    }

    private void emitState() {
        if (listener != null) listener.onState(state());
    }

    private void onPlayingChanged() {
        updateSessionState();
        if (playing) {
            registerNoisy();
            startService();
        } else {
            unregisterNoisy();
            updateNotification();
        }
        emitState();
    }

    // ------------------------------------------------------------------ fokus audio
    private void requestFocus() {
        if (hasFocus || audioManager == null) return;
        int r;
        if (Build.VERSION.SDK_INT >= 26) {
            if (focusRequest == null) {
                focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                        .setAudioAttributes(new AudioAttributes.Builder()
                                .setUsage(AudioAttributes.USAGE_MEDIA)
                                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                        .setOnAudioFocusChangeListener(focusListener, main)
                        .setWillPauseWhenDucked(true)
                        .build();
            }
            r = audioManager.requestAudioFocus(focusRequest);
        } else {
            //noinspection deprecation
            r = audioManager.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
        }
        hasFocus = r == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
    }

    private void abandonFocus() {
        if (!hasFocus || audioManager == null) return;
        if (Build.VERSION.SDK_INT >= 26 && focusRequest != null) audioManager.abandonAudioFocusRequest(focusRequest);
        else //noinspection deprecation
            audioManager.abandonAudioFocus(focusListener);
        hasFocus = false;
    }

    private void registerNoisy() {
        if (noisyRegistered) return;
        ContextCompat.registerReceiver(app, noisyReceiver, new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY),
                ContextCompat.RECEIVER_EXPORTED);
        noisyRegistered = true;
    }

    private void unregisterNoisy() {
        if (!noisyRegistered) return;
        try {
            app.unregisterReceiver(noisyReceiver);
        } catch (Exception ignored) { }
        noisyRegistered = false;
    }

    // ------------------------------------------------------------------ MediaSession
    private MediaSession session() {
        if (session == null) {
            session = new MediaSession(app, "Lektor");
            //noinspection deprecation
            session.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
            session.setCallback(new MediaSession.Callback() {
                @Override
                public void onPlay() {
                    play();
                }

                @Override
                public void onPause() {
                    pause();
                }

                @Override
                public void onSkipToNext() {
                    next();
                }

                @Override
                public void onSkipToPrevious() {
                    prev();
                }

                @Override
                public void onStop() {
                    stop();
                }
            }, main);
            updateMetadata();
        }
        return session;
    }

    private void updateMetadata() {
        if (session == null) return;
        session.setMetadata(new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, "Lektor")
                .build());
    }

    private void updateSessionState() {
        MediaSession s = session();
        long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE
                | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS | PlaybackState.ACTION_STOP;
        s.setPlaybackState(new PlaybackState.Builder()
                .setActions(actions)
                .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                        PlaybackState.PLAYBACK_POSITION_UNKNOWN, playing ? rate : 0f)
                .build());
        updateMetadata();
        if (playing) s.setActive(true);
    }

    // ------------------------------------------------------------------ powiadomienie / usługa
    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = app.getSystemService(NotificationManager.class);
        if (nm == null || nm.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Czytanie", NotificationManager.IMPORTANCE_LOW);
        ch.setShowBadge(false);
        ch.setSound(null, null);
        nm.createNotificationChannel(ch);
    }

    private PendingIntent servicePi(String action, int code) {
        Intent i = new Intent(app, TtsService.class).setAction(action);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        return Build.VERSION.SDK_INT >= 26 ? PendingIntent.getForegroundService(app, code, i, flags)
                : PendingIntent.getService(app, code, i, flags);
    }

    Notification buildNotification() {
        Intent open = new Intent(app, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openPi = PendingIntent.getActivity(app, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(app, CHANNEL) : new Notification.Builder(app);
        int pct = items.isEmpty() ? 0 : (int) Math.round(100.0 * (index + 1) / items.size());
        b.setSmallIcon(android.R.drawable.ic_media_play)
                .setContentTitle(title)
                .setContentText((playing ? (buffering ? "Ładowanie głosu…" : "Czyta") : finished ? "Koniec" : "Wstrzymano") + " · " + pct + "%")
                .setContentIntent(openPi)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setOngoing(playing)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .addAction(new Notification.Action.Builder(Icon.createWithResource(app, android.R.drawable.ic_media_previous),
                        "Poprzednie", servicePi(TtsService.ACTION_PREV, 2)).build())
                .addAction(playing
                        ? new Notification.Action.Builder(Icon.createWithResource(app, android.R.drawable.ic_media_pause),
                        "Pauza", servicePi(TtsService.ACTION_PAUSE, 3)).build()
                        : new Notification.Action.Builder(Icon.createWithResource(app, android.R.drawable.ic_media_play),
                        "Czytaj", servicePi(TtsService.ACTION_PLAY, 4)).build())
                .addAction(new Notification.Action.Builder(Icon.createWithResource(app, android.R.drawable.ic_media_next),
                        "Następne", servicePi(TtsService.ACTION_NEXT, 5)).build())
                .addAction(new Notification.Action.Builder(Icon.createWithResource(app, android.R.drawable.ic_menu_close_clear_cancel),
                        "Zamknij", servicePi(TtsService.ACTION_STOP, 6)).build())
                .setStyle(new Notification.MediaStyle()
                        .setMediaSession(session().getSessionToken())
                        .setShowActionsInCompactView(0, 1, 2));
        if (Build.VERSION.SDK_INT >= 31) b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        return b.build();
    }

    private void startService() {
        try {
            ContextCompat.startForegroundService(app, new Intent(app, TtsService.class).setAction(TtsService.ACTION_START));
        } catch (Exception e) {
            // np. ograniczenia uruchamiania usług w tle – czytanie i tak trwa, tylko bez powiadomienia
            updateNotification();
        }
    }

    private void stopService() {
        try {
            app.stopService(new Intent(app, TtsService.class));
        } catch (Exception ignored) { }
        NotificationManager nm = (NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(NOTIFICATION_ID);
    }

    void updateNotification() {
        if (!TtsService.running) return;
        NotificationManager nm = (NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIFICATION_ID, buildNotification());
    }
}
