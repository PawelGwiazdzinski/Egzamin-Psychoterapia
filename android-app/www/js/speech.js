// Silniki mowy o wspólnym interfejsie. Zdarzenia: {type:'start'|'range'|'done'|'error', id, start, end, message}
// start/end to pozycje znaków w tekście zdania (do podświetlania słów).
import { Lektor, http } from "./native.js";

/* Preferowane męskie głosy Google TTS (offline, bardzo dobra jakość). */
export const PREFERRED = {
  pl: ["pl-pl-x-bmg-local", "pl-pl-x-jmk-local", "pl-pl-x-bmg-network", "pl-pl-x-jmk-network"],
  en: ["en-us-x-iom-local", "en-us-x-tpd-local", "en-us-x-iol-local", "en-gb-x-rjs-local", "en-gb-x-gbd-local",
       "en-us-x-iom-network", "en-us-x-tpd-network"],
};
const MALE_HINT = /bmg|jmk|iom|tpd|iol|rjs|gbd|gbb|male|marek|andrew|brian|ryan|guy|davis|daniel|adam|michael/i;

const listeners = new Set();
export const onSpeech = (cb) => listeners.add(cb);
const emit = (e) => listeners.forEach((cb) => cb(e));

/* ------------------------------------------------ Android TTS (natywnie) */
const android = {
  name: "android",
  async init() {
    if (!Lektor) return false;
    await Lektor.addListener("tts", emit);
    return true;
  },
  async voices(lang) {
    const r = await Lektor.getVoices();
    const pref = lang === "pl" ? "pl" : "en";
    return r.voices
      .filter((v) => v.locale.toLowerCase().startsWith(pref) && !v.notInstalled)
      .map((v) => ({ id: v.name, label: prettyAndroid(v), male: MALE_HINT.test(v.name), network: v.network, quality: v.quality }));
  },
  play(items, o) { return Lektor.speak({ items, voice: o.voice || "", locale: o.lang === "pl" ? "pl-PL" : "en-US", rate: o.rate, flush: true, title: o.title || "" }); },
  enqueue(items, o) { return Lektor.speak({ items, voice: o.voice || "", locale: o.lang === "pl" ? "pl-PL" : "en-US", rate: o.rate, flush: false, title: o.title || "" }); },
  stop() { return Lektor.stop(); },
};

function prettyAndroid(v) {
  const m = v.name.match(/^([a-z]{2})-([a-z]{2})-x-([a-z]+)-(local|network)$/i);
  const base = m ? `${m[1].toUpperCase()}-${m[2].toUpperCase()} ${m[3]}` : v.name;
  const male = MALE_HINT.test(v.name) ? " ♂" : "";
  return `${base}${male}${v.network ? " (online)" : ""}`;
}

/* ------------------------------------------------ Web Speech (przeglądarka, testy) */
const web = {
  name: "web",
  queue: [], cur: null, o: null,
  async init() { return "speechSynthesis" in window; },
  async voices(lang) {
    let vs = speechSynthesis.getVoices();
    if (!vs.length) { await new Promise((r) => setTimeout(r, 300)); vs = speechSynthesis.getVoices(); }
    return vs.filter((v) => v.lang.toLowerCase().startsWith(lang)).map((v) => ({ id: v.name, label: v.name, male: MALE_HINT.test(v.name) }));
  },
  play(items, o) { this.stop(); this.o = o; this.queue = [...items]; this.next(); },
  enqueue(items, o) { this.o = o; this.queue.push(...items); if (!this.cur) this.next(); },
  stop() { this.queue = []; this.cur = null; speechSynthesis.cancel(); },
  next() {
    const it = this.queue.shift();
    this.cur = it || null;
    if (!it) return;
    const u = new SpeechSynthesisUtterance(it.text);
    const v = speechSynthesis.getVoices().find((x) => x.name === this.o.voice);
    if (v) u.voice = v;
    u.lang = this.o.lang === "pl" ? "pl-PL" : "en-US";
    u.rate = this.o.rate;
    u.onstart = () => emit({ type: "start", id: it.id });
    u.onboundary = (e) => emit({ type: "range", id: it.id, start: e.charIndex, end: e.charIndex + (e.charLength || 1) });
    u.onend = () => { if (this.cur !== it) return; emit({ type: "done", id: it.id }); this.next(); };
    u.onerror = (e) => { if (e.error !== "interrupted" && e.error !== "canceled") emit({ type: "error", id: it.id, message: e.error }); };
    speechSynthesis.speak(u);
  },
};

/* ------------------------------------------------ ElevenLabs (opcjonalnie, własny klucz) */
const eleven = {
  name: "elevenlabs",
  queue: [], cur: null, o: null, audio: new Audio(), cache: new Map(), timer: null,
  async init() { return true; },
  async voices() {
    const key = localStorage.getItem("lektor.elevenKey");
    if (!key) return [];
    try {
      const r = await http({ url: "https://api.elevenlabs.io/v1/voices", headers: { "xi-api-key": key } });
      return r.voices.map((v) => ({ id: v.voice_id, label: v.name + (v.labels?.gender === "male" ? " ♂" : ""), male: v.labels?.gender === "male" }));
    } catch { return []; }
  },
  synth(it) {
    const k = this.o.voice + "|" + it.text;
    if (!this.cache.has(k)) {
      const key = localStorage.getItem("lektor.elevenKey");
      const p = http({
        url: `https://api.elevenlabs.io/v1/text-to-speech/${this.o.voice}/with-timestamps`, method: "POST",
        headers: { "xi-api-key": key, "Content-Type": "application/json" },
        data: { text: it.text, model_id: "eleven_multilingual_v2", language_code: this.o.lang },
      });
      p.catch(() => this.cache.delete(k));
      this.cache.set(k, p);
      if (this.cache.size > 30) this.cache.delete(this.cache.keys().next().value);
    }
    return this.cache.get(k);
  },
  play(items, o) { this.stop(); this.o = o; this.queue = [...items]; this.next(); },
  enqueue(items, o) { this.o = o; this.queue.push(...items); if (!this.cur) this.next(); },
  stop() { this.queue = []; this.cur = null; this.audio.pause(); cancelAnimationFrame(this.timer); },
  async next() {
    const it = this.queue.shift();
    this.cur = it || null;
    if (!it) return;
    if (!this.o.voice) { emit({ type: "error", id: it.id, message: "Wybierz głos ElevenLabs (wpisz klucz API w ustawieniach)" }); return; }
    let r;
    try { r = await this.synth(it); } catch (e) { if (this.cur === it) emit({ type: "error", id: it.id, message: e.message }); return; }
    if (this.cur !== it) return;
    if (this.queue[0]) this.synth(this.queue[0]).catch(() => {});
    const al = r.alignment || {};
    const starts = al.character_start_times_seconds || [];
    this.audio.src = "data:audio/mpeg;base64," + r.audio_base64;
    this.audio.playbackRate = this.o.rate;
    this.audio.onended = () => { if (this.cur === it) { emit({ type: "done", id: it.id }); this.next(); } };
    emit({ type: "start", id: it.id });
    try { await this.audio.play(); } catch (e) { emit({ type: "error", id: it.id, message: e.message }); return; }
    let lastWord = -1;
    const tick = () => {
      if (this.cur !== it) return;
      const t = this.audio.currentTime;
      let ci = 0;
      while (ci + 1 < starts.length && starts[ci + 1] <= t) ci++;
      // początek słowa
      let ws = ci;
      while (ws > 0 && !/\s/.test(it.text[ws - 1] || " ")) ws--;
      if (ws !== lastWord) { lastWord = ws; emit({ type: "range", id: it.id, start: ws, end: ws + 1 }); }
      this.timer = requestAnimationFrame(tick);
    };
    tick();
  },
};

export const ENGINES = { android, web, elevenlabs: eleven };
export const ENGINE_LABEL = { android: "Głosy telefonu (Google TTS, offline)", web: "Przeglądarka", elevenlabs: "ElevenLabs (własny klucz)" };

export async function availableEngines() {
  const out = [];
  if (await android.init()) out.push("android");
  else if (await web.init()) out.push("web");
  out.push("elevenlabs");
  return out;
}

/** Wybiera najlepszy męski głos z listy. */
export function pickDefault(voices, lang) {
  for (const id of PREFERRED[lang] || []) { const v = voices.find((x) => x.id === id); if (v) return v.id; }
  const local = voices.filter((v) => !v.network);
  return (local.find((v) => v.male) || voices.find((v) => v.male) || local[0] || voices[0])?.id || "";
}

export function setRate(engine, rate) {
  if (engine === "elevenlabs") eleven.audio.playbackRate = rate;
}
