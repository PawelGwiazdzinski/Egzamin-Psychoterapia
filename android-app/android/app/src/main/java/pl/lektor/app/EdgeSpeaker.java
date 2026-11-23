package pl.lektor.app;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.media.PlaybackParams;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/** Głosy Edge Neural (online). Synteza zdań z wyprzedzeniem, pamięć podręczna MP3 na dysku, podświetlanie słów. */
final class EdgeSpeaker implements Speaker {
    private static final long CACHE_LIMIT = 350L * 1024 * 1024;
    private static final long CACHE_TARGET = 200L * 1024 * 1024;

    static final class Clip {
        final File file;
        final long[] offsets;
        final int[] starts;
        final int[] ends;

        Clip(File file, long[] offsets, int[] starts, int[] ends) {
            this.file = file;
            this.offsets = offsets;
            this.starts = starts;
            this.ends = ends;
        }
    }

    private final Callback cb;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService synth = Executors.newFixedThreadPool(2);
    private final ExecutorService waiter = Executors.newSingleThreadExecutor();
    private final Map<String, Future<Clip>> inflight = new ConcurrentHashMap<>();
    private final File cacheDir;

    private List<Item> items = Collections.emptyList();
    private int cur = -1;
    private int generation;
    private String voice = "pl-PL-MarekNeural";
    private float rate = 1f;

    private MediaPlayer mp;
    private Clip clip;
    private String clipId;
    private boolean paused;
    private boolean prepared;
    private boolean started;
    private int lastWord = -1;
    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            tick();
            if (mp != null && started && !paused) main.postDelayed(this, 50);
        }
    };

    EdgeSpeaker(Context ctx, Callback cb) {
        this.cb = cb;
        cacheDir = new File(ctx.getCacheDir(), "edge-tts");
        //noinspection ResultOfMethodCallIgnored
        cacheDir.mkdirs();
        synth.submit(this::pruneCache);
    }

    // ------------------------------------------------------------------ Speaker
    @Override
    public void setVoice(String voice, String locale) {
        if (voice != null && !voice.isEmpty()) this.voice = voice;
    }

    @Override
    public void setRate(float rate) {
        this.rate = rate;
        applySpeed();
    }

    @Override
    public void start(List<Item> items, int from) {
        releasePlayer();
        generation++;
        this.items = items;
        paused = false;
        playIndex(from, generation);
    }

    @Override
    public void pause() {
        paused = true;
        main.removeCallbacks(ticker);
        if (mp != null && prepared && started) {
            try {
                if (mp.isPlaying()) mp.pause();
            } catch (Exception ignored) { }
        }
    }

    @Override
    public boolean resume() {
        paused = false;
        if (mp != null && prepared) {
            if (started) {
                try {
                    mp.start();
                } catch (Exception e) {
                    return false;
                }
                applySpeed();
                main.post(ticker);
            } else {
                startPlayback();
            }
        }
        // jeśli trwa buforowanie, odtwarzanie ruszy w onPrepared
        return true;
    }

    @Override
    public void stop() {
        generation++;
        paused = false;
        releasePlayer();
    }

    @Override
    public void release() {
        stop();
        synth.shutdownNow();
        waiter.shutdownNow();
    }

    // ------------------------------------------------------------------ odtwarzanie
    private void playIndex(final int i, final int gen) {
        if (i < 0 || i >= items.size()) return;
        cur = i;
        final Item it = items.get(i);
        cb.onBuffering(it.id, true);
        final Future<Clip> f = ensure(it);
        if (i + 1 < items.size()) ensure(items.get(i + 1));
        if (i + 2 < items.size()) ensure(items.get(i + 2));
        waiter.submit(() -> {
            Clip c = null;
            Throwable err = null;
            try {
                c = f.get();
            } catch (ExecutionException e) {
                err = e.getCause() != null ? e.getCause() : e;
            } catch (Throwable e) {
                err = e;
            }
            final Clip cc = c;
            final Throwable ee = err;
            main.post(() -> {
                if (gen != generation) return;
                cb.onBuffering(it.id, false);
                if (cc == null) {
                    boolean network = !(ee instanceof EdgeTts.EdgeException) || ((EdgeTts.EdgeException) ee).network;
                    String msg = ee != null && ee.getMessage() != null ? ee.getMessage() : "Błąd głosu Edge";
                    cb.onError(it.id, msg, network);
                    return;
                }
                begin(i, it, cc, gen);
            });
        });
    }

    private void begin(final int i, final Item it, final Clip c, final int gen) {
        releasePlayer();
        clip = c;
        clipId = it.id;
        prepared = false;
        started = false;
        lastWord = -1;
        try {
            mp = new MediaPlayer();
            mp.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build());
            mp.setDataSource(c.file.getAbsolutePath());
            mp.setOnPreparedListener(p -> {
                if (gen != generation || p != mp) return;
                prepared = true;
                if (!paused) startPlayback();
            });
            mp.setOnCompletionListener(p -> {
                if (gen != generation || p != mp) return;
                main.removeCallbacks(ticker);
                releasePlayer();
                cb.onDone(it.id);
                playIndex(i + 1, gen);
            });
            mp.setOnErrorListener((p, what, extra) -> {
                if (gen == generation) {
                    releasePlayer();
                    // uszkodzony plik w pamięci podręcznej – usuwamy, następnym razem zsyntezujemy od nowa
                    //noinspection ResultOfMethodCallIgnored
                    c.file.delete();
                    cb.onError(it.id, "Błąd odtwarzania dźwięku (" + what + "/" + extra + ")", false);
                }
                return true;
            });
            mp.prepareAsync();
        } catch (Exception e) {
            releasePlayer();
            cb.onError(it.id, "Nie udało się odtworzyć: " + e.getMessage(), false);
        }
    }

    private void startPlayback() {
        if (mp == null || !prepared) return;
        try {
            mp.start();
        } catch (Exception e) {
            cb.onError(clipId, "Nie udało się uruchomić odtwarzania", false);
            return;
        }
        started = true;
        applySpeed();
        cb.onStart(clipId);
        tick();
        main.removeCallbacks(ticker);
        main.postDelayed(ticker, 50);
    }

    private void applySpeed() {
        if (mp == null || !prepared || !started) return;
        try {
            PlaybackParams pp = mp.getPlaybackParams();
            if (Math.abs(pp.getSpeed() - rate) > 0.01f) {
                boolean wasPlaying = mp.isPlaying();
                mp.setPlaybackParams(pp.setSpeed(rate));
                if (!wasPlaying && mp.isPlaying()) mp.pause(); // setPlaybackParams potrafi wznowić odtwarzanie
            }
        } catch (Exception ignored) { }
    }

    private void tick() {
        if (mp == null || clip == null || !started) return;
        int pos;
        try {
            pos = mp.getCurrentPosition();
        } catch (Exception e) {
            return;
        }
        long[] off = clip.offsets;
        int k = -1;
        for (int j = 0; j < off.length; j++) {
            if (off[j] <= pos + 70) k = j;
            else break;
        }
        if (k >= 0 && k != lastWord) {
            lastWord = k;
            cb.onRange(clipId, clip.starts[k], clip.ends[k]);
        }
    }

    private void releasePlayer() {
        main.removeCallbacks(ticker);
        if (mp != null) {
            try {
                mp.reset();
            } catch (Exception ignored) { }
            try {
                mp.release();
            } catch (Exception ignored) { }
            mp = null;
        }
        clip = null;
        prepared = false;
        started = false;
    }

    // ------------------------------------------------------------------ synteza i pamięć podręczna
    private String key(Item it) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-1");
            byte[] d = md.digest((voice + "|" + it.text.trim()).getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte b : d) sb.append(String.format(Locale.ROOT, "%02x", b & 0xff));
            return sb.toString();
        } catch (Exception e) {
            return Integer.toHexString((voice + it.text).hashCode());
        }
    }

    private Future<Clip> ensure(final Item it) {
        final String k = key(it);
        final File mp3 = new File(cacheDir, k + ".mp3");
        final File meta = new File(cacheDir, k + ".json");
        if (mp3.exists() && meta.exists() && mp3.length() > 0) {
            try {
                Clip c = loadClip(mp3, meta);
                //noinspection ResultOfMethodCallIgnored
                mp3.setLastModified(System.currentTimeMillis());
                return CompletableFuture.completedFuture(c);
            } catch (Exception ignored) {
                // uszkodzone metadane – syntezujemy ponownie
            }
        }
        final String v = voice;
        return inflight.computeIfAbsent(k, kk -> synth.submit(() -> {
            try {
                EdgeTts.Result r = EdgeTts.synthesize(it.text, v);
                Clip c = buildClip(it.text, r, mp3);
                File tmp = new File(cacheDir, k + ".tmp");
                try (FileOutputStream out = new FileOutputStream(tmp)) {
                    out.write(r.mp3);
                }
                //noinspection ResultOfMethodCallIgnored
                tmp.renameTo(mp3);
                Files.write(meta.toPath(), clipJson(c).getBytes(StandardCharsets.UTF_8));
                return c;
            } finally {
                inflight.remove(kk);
            }
        }));
    }

    private static Clip buildClip(String text, EdgeTts.Result r, File file) {
        List<long[]> rows = new ArrayList<>();
        String lower = text.toLowerCase(Locale.ROOT);
        int cursor = 0;
        for (EdgeTts.Mark m : r.marks) {
            String w = m.text == null ? "" : m.text.trim();
            if (w.isEmpty()) continue;
            int idx = lower.indexOf(w.toLowerCase(Locale.ROOT), cursor);
            if (idx < 0) {
                // słowo mogło zostać znormalizowane (np. liczby) – szukamy pierwszego tokenu po kursorze
                idx = nextTokenStart(text, cursor);
                if (idx < 0) continue;
                int end = nextTokenEnd(text, idx);
                rows.add(new long[]{m.offsetMs, idx, end});
                cursor = end;
                continue;
            }
            rows.add(new long[]{m.offsetMs, idx, idx + w.length()});
            cursor = idx + w.length();
        }
        long[] off = new long[rows.size()];
        int[] st = new int[rows.size()];
        int[] en = new int[rows.size()];
        for (int i = 0; i < rows.size(); i++) {
            off[i] = rows.get(i)[0];
            st[i] = (int) rows.get(i)[1];
            en[i] = (int) rows.get(i)[2];
        }
        return new Clip(file, off, st, en);
    }

    private static int nextTokenStart(String s, int from) {
        for (int i = from; i < s.length(); i++) if (Character.isLetterOrDigit(s.charAt(i))) return i;
        return -1;
    }

    private static int nextTokenEnd(String s, int from) {
        int i = from;
        while (i < s.length() && !Character.isWhitespace(s.charAt(i))) i++;
        return i;
    }

    private static String clipJson(Clip c) {
        JSONObject o = new JSONObject();
        try {
            o.put("o", new JSONArray(Arrays.asList(box(c.offsets))));
            o.put("s", new JSONArray(Arrays.asList(box(c.starts))));
            o.put("e", new JSONArray(Arrays.asList(box(c.ends))));
        } catch (Exception ignored) { }
        return o.toString();
    }

    private static Long[] box(long[] a) {
        Long[] out = new Long[a.length];
        for (int i = 0; i < a.length; i++) out[i] = a[i];
        return out;
    }

    private static Integer[] box(int[] a) {
        Integer[] out = new Integer[a.length];
        for (int i = 0; i < a.length; i++) out[i] = a[i];
        return out;
    }

    private static Clip loadClip(File mp3, File meta) throws Exception {
        JSONObject o = new JSONObject(new String(Files.readAllBytes(meta.toPath()), StandardCharsets.UTF_8));
        JSONArray ao = o.getJSONArray("o"), as = o.getJSONArray("s"), ae = o.getJSONArray("e");
        long[] off = new long[ao.length()];
        int[] st = new int[as.length()];
        int[] en = new int[ae.length()];
        for (int i = 0; i < ao.length(); i++) off[i] = ao.getLong(i);
        for (int i = 0; i < as.length(); i++) st[i] = as.getInt(i);
        for (int i = 0; i < ae.length(); i++) en[i] = ae.getInt(i);
        return new Clip(mp3, off, st, en);
    }

    private void pruneCache() {
        try {
            File[] files = cacheDir.listFiles();
            if (files == null) return;
            long total = 0;
            for (File f : files) total += f.length();
            if (total < CACHE_LIMIT) return;
            Arrays.sort(files, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
            for (File f : files) {
                if (total < CACHE_TARGET) break;
                total -= f.length();
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
        } catch (Exception ignored) { }
    }
}
