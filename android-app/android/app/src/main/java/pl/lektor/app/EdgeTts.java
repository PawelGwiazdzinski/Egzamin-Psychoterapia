package pl.lektor.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * Neuronowe głosy Microsoft Edge ("Czytaj na głos") – port biblioteki edge-tts (MIT).
 * Zwraca MP3 (24 kHz, 48 kbit/s) oraz znaczniki czasu słów.
 */
public final class EdgeTts {
    static final String TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
    static final String CHROMIUM_FULL = "143.0.3650.75";
    static final String CHROMIUM_MAJOR = "143";
    static final String WSS_URL = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=" + TRUSTED_CLIENT_TOKEN;
    static final String USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/"
            + CHROMIUM_MAJOR + ".0.0.0 Safari/537.36 Edg/" + CHROMIUM_MAJOR + ".0.0.0";
    private static final long WIN_EPOCH = 11644473600L;

    /** Korekta zegara (sekundy), gdy serwer odrzuci token z powodu różnicy czasu. */
    static volatile long clockSkewSeconds = 0;

    private static final OkHttpClient CLIENT = new OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .pingInterval(20, TimeUnit.SECONDS)
            .build();

    public static final class Mark {
        public final long offsetMs;
        public final long durationMs;
        public final String text;

        Mark(long offsetMs, long durationMs, String text) {
            this.offsetMs = offsetMs;
            this.durationMs = durationMs;
            this.text = text;
        }
    }

    public static final class Result {
        public final byte[] mp3;
        public final List<Mark> marks;

        Result(byte[] mp3, List<Mark> marks) {
            this.mp3 = mp3;
            this.marks = marks;
        }
    }

    public static final class EdgeException extends IOException {
        public final boolean network;

        EdgeException(String msg, boolean network) {
            super(msg);
            this.network = network;
        }
    }

    private EdgeTts() { }

    // ------------------------------------------------------------------ API
    public static Result synthesize(String text, String voice) throws IOException {
        IOException last = null;
        for (int attempt = 0; attempt < 2; attempt++) {
            try {
                return synthesizeOnce(text, voice);
            } catch (SkewException e) {
                last = e; // zegar skorygowany – próbujemy jeszcze raz
            }
        }
        throw last != null ? last : new EdgeException("Edge TTS: nieznany błąd", true);
    }

    private static final class SkewException extends IOException {
        SkewException(String m) { super(m); }
    }

    private static Result synthesizeOnce(String text, String voice) throws IOException {
        final String url = WSS_URL
                + "&ConnectionId=" + connectId()
                + "&Sec-MS-GEC=" + secMsGec()
                + "&Sec-MS-GEC-Version=2-" + CHROMIUM_FULL;
        Request req = new Request.Builder()
                .url(url)
                .header("Pragma", "no-cache")
                .header("Cache-Control", "no-cache")
                .header("Origin", "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold")
                .header("User-Agent", USER_AGENT)
                .header("Accept-Language", "en-US,en;q=0.9")
                .header("Cookie", "muid=" + UUID.randomUUID().toString().replace("-", "").toUpperCase(Locale.ROOT) + ";")
                .build();

        final ByteArrayOutputStream audio = new ByteArrayOutputStream(64 * 1024);
        final List<Mark> marks = new ArrayList<>();
        final CountDownLatch done = new CountDownLatch(1);
        final Throwable[] failure = new Throwable[1];
        final int[] failCode = new int[1];
        final String[] serverDate = new String[1];
        final boolean[] finished = new boolean[1];

        WebSocket ws = CLIENT.newWebSocket(req, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                String ts = dateToString();
                webSocket.send("X-Timestamp:" + ts + "\r\n"
                        + "Content-Type:application/json; charset=utf-8\r\n"
                        + "Path:speech.config\r\n\r\n"
                        + "{\"context\":{\"synthesis\":{\"audio\":{\"metadataoptions\":{"
                        + "\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"true\"},"
                        + "\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}\r\n");
                webSocket.send("X-RequestId:" + connectId() + "\r\n"
                        + "Content-Type:application/ssml+xml\r\n"
                        + "X-Timestamp:" + ts + "Z\r\n"
                        + "Path:ssml\r\n\r\n"
                        + ssml(voice, text));
            }

            @Override
            public void onMessage(WebSocket webSocket, String message) {
                int sep = message.indexOf("\r\n\r\n");
                if (sep < 0) return;
                Map<String, String> h = headers(message.substring(0, sep));
                String path = h.get("Path");
                if ("audio.metadata".equals(path)) {
                    try {
                        JSONArray arr = new JSONObject(message.substring(sep + 4)).getJSONArray("Metadata");
                        for (int i = 0; i < arr.length(); i++) {
                            JSONObject m = arr.getJSONObject(i);
                            if (!"WordBoundary".equals(m.optString("Type"))) continue;
                            JSONObject d = m.getJSONObject("Data");
                            String t = unescapeXml(d.getJSONObject("text").optString("Text", ""));
                            marks.add(new Mark(d.optLong("Offset") / 10_000L, d.optLong("Duration") / 10_000L, t));
                        }
                    } catch (Exception ignored) { }
                } else if ("turn.end".equals(path)) {
                    finished[0] = true;
                    webSocket.close(1000, null);
                    done.countDown();
                }
            }

            @Override
            public void onMessage(WebSocket webSocket, ByteString bytes) {
                byte[] b = bytes.toByteArray();
                if (b.length < 2) return;
                int hl = ((b[0] & 0xff) << 8) | (b[1] & 0xff);
                if (hl + 2 > b.length) return;
                Map<String, String> h = headers(new String(b, 2, hl, StandardCharsets.UTF_8));
                if (!"audio".equals(h.get("Path"))) return;
                int start = hl + 2;
                if (b.length > start) audio.write(b, start, b.length - start);
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                failure[0] = t;
                if (response != null) {
                    failCode[0] = response.code();
                    serverDate[0] = response.header("Date");
                }
                done.countDown();
            }

            @Override
            public void onClosed(WebSocket webSocket, int code, String reason) {
                done.countDown();
            }
        });

        try {
            if (!done.await(75, TimeUnit.SECONDS)) {
                ws.cancel();
                throw new EdgeException("Edge TTS: przekroczono czas oczekiwania", true);
            }
        } catch (InterruptedException e) {
            ws.cancel();
            Thread.currentThread().interrupt();
            throw new EdgeException("Przerwano", true);
        }

        if (failure[0] != null) {
            if (failCode[0] == 403 && serverDate[0] != null) {
                Date d = parseHttpDate(serverDate[0]);
                if (d != null) {
                    long skew = d.getTime() / 1000L - (System.currentTimeMillis() / 1000L);
                    if (Math.abs(skew - clockSkewSeconds) > 30) {
                        clockSkewSeconds = skew;
                        throw new SkewException("zegar skorygowany");
                    }
                }
                throw new EdgeException("Edge TTS odrzucił połączenie (403). Głosy Edge mogą być chwilowo niedostępne.", false);
            }
            String m = failure[0].getMessage();
            throw new EdgeException("Brak połączenia z głosami Edge" + (m != null ? " (" + m + ")" : ""), true);
        }
        if (!finished[0] && audio.size() == 0) throw new EdgeException("Edge TTS nie zwrócił dźwięku", true);
        if (audio.size() == 0) throw new EdgeException("Edge TTS nie zwrócił dźwięku (pusty tekst?)", false);
        return new Result(audio.toByteArray(), marks);
    }

    // ------------------------------------------------------------------ pomocnicze
    private static Map<String, String> headers(String block) {
        Map<String, String> out = new HashMap<>();
        for (String line : block.split("\r\n")) {
            int i = line.indexOf(':');
            if (i > 0) out.put(line.substring(0, i).trim(), line.substring(i + 1).trim());
        }
        return out;
    }

    private static String connectId() {
        return UUID.randomUUID().toString().replace("-", "");
    }

    static String dateToString() {
        SimpleDateFormat f = new SimpleDateFormat("EEE MMM dd yyyy HH:mm:ss 'GMT+0000 (Coordinated Universal Time)'", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date());
    }

    private static Date parseHttpDate(String s) {
        String[] patterns = {"EEE, dd MMM yyyy HH:mm:ss zzz", "EEEE, dd-MMM-yy HH:mm:ss zzz", "EEE MMM d HH:mm:ss yyyy"};
        for (String p : patterns) {
            try {
                SimpleDateFormat f = new SimpleDateFormat(p, Locale.US);
                f.setTimeZone(TimeZone.getTimeZone("GMT"));
                return f.parse(s);
            } catch (Exception ignored) { }
        }
        return null;
    }

    static String ssml(String voice, String text) {
        return "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>"
                + "<voice name='" + voice + "'>"
                + "<prosody pitch='+0Hz' rate='+0%' volume='+0%'>"
                + escapeXml(cleanText(text))
                + "</prosody></voice></speak>";
    }

    static String cleanText(String s) {
        StringBuilder sb = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c <= 8 || c == 11 || c == 12 || (c >= 14 && c <= 31)) sb.append(' ');
            else sb.append(c);
        }
        String t = sb.toString().trim();
        if (t.length() > 3000) t = t.substring(0, 3000);
        return t;
    }

    static String escapeXml(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;").replace("'", "&apos;");
    }

    static String unescapeXml(String s) {
        return s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&#39;", "'").replace("&amp;", "&");
    }

    /** Token Sec-MS-GEC v2 z korektą zegara. */
    static String secMsGec() {
        return SecMsGec.token(System.currentTimeMillis() / 1000L + clockSkewSeconds);
    }
}
