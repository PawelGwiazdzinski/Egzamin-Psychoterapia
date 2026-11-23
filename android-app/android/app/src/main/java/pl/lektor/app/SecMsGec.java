package pl.lektor.app;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Token Sec-MS-GEC (wersja 2) wymagany przez usługę "Czytaj na głos" Edge.
 * Port funkcji z biblioteki edge-tts (drm.py, licencja MIT). Czysta Java, bez zależności od Androida.
 */
final class SecMsGec {
    static final String TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
    private static final long WIN_EPOCH = 11644473600L;
    private static final long M = 0xFFFFFFFFL;

    private static final long[] SHA256_INITIAL = {0x6A09E667L, 0xBB67AE85L, 0x3C6EF372L, 0xA54FF53AL, 0x510E527FL, 0x9B05688CL, 0x1F83D9ABL, 0x5BE0CD19L};
    private static final long[] SHA256_STATE = {0xFD9FBEA2L, 0x91243CE7L, 0xBE499094L, 0xCD2E1E0AL, 0x6C006F49L, 0x04BD35ABL, 0xFEB0A7E4L, 0x03EFFBD2L};
    private static final long[] SHA256_SCHEDULE = {0xEB24BF9EL, 0x1558691FL, 0xA0C09EE2L, 0x0CFA32BAL, 0xA622EE8CL, 0xD1DD9491L, 0xC0DD25A0L,
            0xF9E70AB6L, 0xF0C31573L, 0x7058CE4EL, 0x7188E606L, 0x00E5AB33L, 0xD258B060L, 0x72766564L};
    private static final long[] K = {
            0x428A2F98L, 0x71374491L, 0xB5C0FBCFL, 0xE9B5DBA5L, 0x3956C25BL, 0x59F111F1L, 0x923F82A4L, 0xAB1C5ED5L,
            0xD807AA98L, 0x12835B01L, 0x243185BEL, 0x550C7DC3L, 0x72BE5D74L, 0x80DEB1FEL, 0x9BDC06A7L, 0xC19BF174L,
            0xE49B69C1L, 0xEFBE4786L, 0x0FC19DC6L, 0x240CA1CCL, 0x2DE92C6FL, 0x4A7484AAL, 0x5CB0A9DCL, 0x76F988DAL,
            0x983E5152L, 0xA831C66DL, 0xB00327C8L, 0xBF597FC7L, 0xC6E00BF3L, 0xD5A79147L, 0x06CA6351L, 0x14292967L,
            0x27B70A85L, 0x2E1B2138L, 0x4D2C6DFCL, 0x53380D13L, 0x650A7354L, 0x766A0ABBL, 0x81C2C92EL, 0x92722C85L,
            0xA2BFE8A1L, 0xA81A664BL, 0xC24B8B70L, 0xC76C51A3L, 0xD192E819L, 0xD6990624L, 0xF40E3585L, 0x106AA070L,
            0x19A4C116L, 0x1E376C08L, 0x2748774CL, 0x34B0BCB5L, 0x391C0CB3L, 0x4ED8AA4AL, 0x5B9CCA4FL, 0x682E6FF3L,
            0x748F82EEL, 0x78A5636FL, 0x84C87814L, 0x8CC70208L, 0x90BEFFFAL, 0xA4506CEBL, 0xBEF9A3F7L, 0xC67178F2L};
    private static final long SHA256_ADJUSTMENT = 0xC9DC06A7L;
    private static final long SIGMA0_ADJUSTMENT = 0x059C0B80L;
    private static final long SIGMA1_ADJUSTMENT = 0x000B92C0L;
    private static final long[][] CS64_COEFFICIENTS = {
            {0xE82E91B1L, 0xB32700D0L}, {0x44DE24C6L, 0x88DFF51DL}, {0x3BEB65BCL, 0x29514038L}, {0xC89C5933L, 0xB328CBDFL},
            {0x8D1EC211L, 0xD405B4D5L}, {0x314EF5D5L, 0x26E55F3CL}, {0xE92491B1L, 0x607801C6L}, {0xF0A5B9D5L, 0x82B2C1FBL},
            {0x06064CF3L, 0xFA51A3DAL}, {0xDA79FA60L, 0x207CC464L}, {0xBED20560L, 0x3C3C74F3L}, {0x89F9C9F8L, 0xD2D14B61L},
            {0x35FA38C6L, 0xBB04A2C1L}, {0xCB49E3C6L, 0xC5626167L}};
    private static final long CS64_FACTOR = 0x82893933L;
    private static final long CS64_ADJUSTMENT0 = 0xF2F90B1AL;
    private static final long CS64_ADJUSTMENT1 = 0x0B1A0000L;

    private SecMsGec() { }

    private static long rotr(long v, int n) {
        v &= M;
        return ((v >>> n) | (v << (32 - n))) & M;
    }

    private static long rol16(long v) {
        v &= M;
        return ((v << 16) | (v >>> 16)) & M;
    }

    private static long sigma0(long v) {
        return (rotr(v, 7) ^ rotr(v, 18) ^ ((v & M) >>> 3)) & M;
    }

    private static long sigma1(long v) {
        return (rotr(v, 17) ^ rotr(v, 19) ^ ((v & M) >>> 10)) & M;
    }

    private static void expandSchedule(long[] w, int first) {
        for (int i = first; i < 64; i++) {
            w[i] = (sigma1(w[i - 2]) + w[i - 7] + sigma0(w[i - 15]) + w[i - 16]) & M;
        }
    }

    private static long[] rounds(long[] state, long[] w, int firstRound) {
        long a = state[0], b = state[1], c = state[2], d = state[3], e = state[4], f = state[5], g = state[6], h = state[7];
        for (int i = firstRound; i < 64; i++) {
            long k = (firstRound == 14 && i == 14) ? SHA256_ADJUSTMENT : K[i];
            long s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            long ch = g ^ (e & (f ^ g));
            long t1 = (h + s1 + ch + k + w[i]) & M;
            long s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            long maj = (a & b) | (c & (a | b));
            long t2 = (s0 + maj) & M;
            h = g; g = f; f = e; e = (d + t1) & M; d = c; c = b; b = a; a = (t1 + t2) & M;
        }
        return new long[]{a, b, c, d, e, f, g, h};
    }

    private static long[] sha256Init(byte[] data7) {
        long[] w = new long[64];
        w[14] = ((data7[0] & 0xffL) << 16) | ((data7[1] & 0xffL) << 8) | (data7[2] & 0xffL);
        w[15] = ((data7[3] & 0xffL) << 24) | ((data7[4] & 0xffL) << 16) | ((data7[5] & 0xffL) << 8) | (data7[6] & 0xffL);
        for (int i = 16; i < 30; i++) {
            long v = SHA256_SCHEDULE[i - 16];
            if (i - 2 >= 14) v += (i == 16) ? (sigma1(w[i - 2]) ^ SIGMA1_ADJUSTMENT) : sigma1(w[i - 2]);
            if (i - 7 >= 14) v += w[i - 7];
            if (i - 15 >= 14) v += (i == 29) ? (sigma0(w[i - 15]) ^ SIGMA0_ADJUSTMENT) : sigma0(w[i - 15]);
            w[i] = v & M;
        }
        w[30] = (sigma1(w[28]) + w[23] + sigma0(w[15]) + w[14] + SHA256_ADJUSTMENT - K[14]) & M;
        expandSchedule(w, 31);
        long[] working = rounds(SHA256_STATE, w, 14);
        long[] out = new long[8];
        for (int i = 0; i < 8; i++) out[i] = (SHA256_INITIAL[i] + working[i]) & M;
        return out;
    }

    private static byte[] sha256Digest(byte[] data) {
        int length = 57 + data.length;
        int zeros = Math.floorMod(55 - length, 64);
        ByteBuffer buf = ByteBuffer.allocate((data.length - 7) + 1 + zeros + 8);
        buf.put(data, 7, data.length - 7);
        buf.put((byte) 0x80);
        buf.put(new byte[zeros]);
        buf.putLong((long) length * 8L);
        byte[] padded = buf.array();
        byte[] head = new byte[7];
        System.arraycopy(data, 0, head, 0, 7);
        long[] state = sha256Init(head);
        for (int off = 0; off < padded.length; off += 64) {
            long[] w = new long[64];
            ByteBuffer bb = ByteBuffer.wrap(padded, off, 64).order(ByteOrder.BIG_ENDIAN);
            for (int i = 0; i < 16; i++) w[i] = bb.getInt() & M;
            expandSchedule(w, 16);
            long[] working = rounds(state, w, 0);
            for (int i = 0; i < 8; i++) state[i] = (state[i] + working[i]) & M;
        }
        ByteBuffer out = ByteBuffer.allocate(32).order(ByteOrder.BIG_ENDIAN);
        for (long s : state) out.putInt((int) s);
        return out.array();
    }

    private static long[] wordsLe4Even(byte[] data) {
        int padLen = (4 - (data.length % 4)) % 4;
        byte[] p = new byte[data.length + padLen];
        System.arraycopy(data, 0, p, 0, data.length);
        int n = p.length / 4;
        long[] w = new long[n + (n % 2)];
        ByteBuffer bb = ByteBuffer.wrap(p).order(ByteOrder.LITTLE_ENDIAN);
        for (int i = 0; i < n; i++) w[i] = bb.getInt() & M;
        return w;
    }

    private static long[] cs64Digest(byte[] data, byte[] digest) {
        ByteBuffer db = ByteBuffer.wrap(digest).order(ByteOrder.LITTLE_ENDIAN);
        long keyA = (db.getInt() & M) | 1L;
        long keyB = (db.getInt() & M) | 1L;
        long[] factors = {(keyA * CS64_FACTOR) & M, (keyB * CS64_FACTOR) & M};
        List<Long> terms = new ArrayList<>();
        List<Long> offsets = new ArrayList<>();
        for (int i = 0; i < CS64_COEFFICIENTS.length; i++) {
            terms.add((CS64_COEFFICIENTS[i][0] * factors[i % 2]) & M);
            offsets.add(CS64_COEFFICIENTS[i][1]);
        }
        byte[] prefixed = new byte[data.length + 1];
        System.arraycopy(data, 0, prefixed, 1, data.length);
        long[] words = wordsLe4Even(prefixed);
        for (int i = 0; i < words.length; i++) {
            long word = words[i];
            long term = word * ((i % 2 == 0) ? keyA : keyB);
            long offset = rol16(word) * ((i % 2 == 0) ? 0xEF0569FBL : 0xC31713DBL);
            if (i == 0) {
                term += CS64_ADJUSTMENT0 * factors[0];
                offset += CS64_ADJUSTMENT1;
            }
            terms.add(term & M);
            offsets.add(offset & M);
        }
        long swapAcc = 0, swapLast = 0, state = 0, acc = 0;
        for (int i = 0; i < terms.size(); i += 2) {
            long x = terms.get(i), y = terms.get(i + 1);
            long t = rol16((offsets.get(i) + x) & M);
            long q = (t * 0x76F50F34L) & M;
            swapAcc += (rol16(q) * 0xC3EFEA97L + q) & M;
            t = rol16((offsets.get(i + 1) + y) & M);
            q = (t * 0x1881CE3CL) & M;
            swapLast = (rol16(q) * 0x35BD1EC9L + q) & M;
            swapAcc = (swapAcc + swapLast) & M;

            state = (state * keyA + x) & M;
            state = (rol16(state) * 0xCF98B111L) & M;
            state = (rol16(state) * 0x87085B9FL) & M;
            state = (rol16(state) * 0x12CEB96DL) & M;
            state = (rol16(state) * 0x257E1D83L) & M;
            acc += state;
            t = (state * keyB + y) & M;
            t = (rol16(t) * 0xA27416F5L) & M;
            t = (rol16(t) * 0xD38396FFL) & M;
            state = (rol16((rol16(t) * 0x7C932B89L) & M) * 0xBFA49F69L) & M;
            acc = (acc + state) & M;
        }
        return new long[]{(swapLast ^ state) & M, (swapAcc ^ acc) & M};
    }

    private static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) sb.append(String.format(Locale.ROOT, "%02X", x & 0xff));
        return sb.toString();
    }

    /** Token dla podanego czasu uniksowego (sekundy). */
    static String token(long unixSeconds) {
        long t = unixSeconds + WIN_EPOCH;
        t -= t % 300;
        long ticks = t * 10_000_000L;
        byte[] data = (ticks + TRUSTED_CLIENT_TOKEN).getBytes(StandardCharsets.US_ASCII);
        byte[] digest = sha256Digest(data);
        long[] cs = cs64Digest(data, digest);
        ByteBuffer cb = ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN);
        cb.putInt((int) cs[0]);
        cb.putInt((int) cs[1]);
        return hex(cb.array()) + "-" + hex(digest);
    }

    /** Uruchomienie z wiersza poleceń: wypisuje tokeny dla podanych znaczników czasu (do testów). */
    public static void main(String[] args) {
        for (String a : args) System.out.println(token(Long.parseLong(a)));
    }
}
