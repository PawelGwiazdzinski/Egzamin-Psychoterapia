// Odtwarzacz mowy – jedna fasada, trzy implementacje:
//  * natywna (Android): głosy Edge Neural (online) i głosy telefonu; czytanie w tle, słuchawki, powiadomienie,
//  * ElevenLabs (własny klucz API, JS),
//  * przeglądarka (Web Speech API) – do testów na komputerze.
// Zdarzenia: {type:'start'|'range'|'done'|'error', id, index, start, end, message} oraz {type:'state', ...stan}
import { Lektor, isNative, http } from "./native.js";

export const ENGINE_LABEL = {
  edge: "Edge Neural – Marek / Andrew (online)",
  system: "Głosy telefonu (Google, offline)",
  elevenlabs: "ElevenLabs (własny klucz)",
  web: "Przeglądarka",
};

export const PREFERRED_SYSTEM = {
  pl: ["pl-pl-x-bmg-local", "pl-pl-x-jmk-local", "pl-pl-x-bmg-network", "pl-pl-x-jmk-network"],
  en: ["en-us-x-iom-local", "en-us-x-tpd-local", "en-us-x-iol-local", "en-gb-x-rjs-local", "en-gb-x-gbd-local",
       "en-us-x-iom-network", "en-us-x-tpd-network"],
};
export const PREFERRED_EDGE = { pl: "pl-PL-MarekNeural", en: "en-US-AndrewMultilingualNeural" };
const MALE_HINT = /bmg|jmk|iom|tpd|iol|rjs|gbd|gbb|♂|male|marek|andrew|brian|ryan|guy|davis|daniel|adam|michael/i;

export function availableEngines() {
  return isNative ? ["edge", "system", "elevenlabs"] : ["web", "elevenlabs"];
}

const listeners = new Set();
const emit = (e) => listeners.forEach((cb) => { try { cb(e); } catch (err) { console.error(err); } });

/* ================================================================ natywny (Android) */
const nativeImpl = {
  ready: false,
  async init() {
    if (this.ready || !Lektor) return;
    this.ready = true;
    await Lektor.addListener("tts", (e) => emit(e));
    await Lektor.addListener("state", (s) => emit({ type: "state", ...s }));
  },
  async voices(engine, lang) {
    await this.init();
    const r = await Lektor.getVoices({ engine });
    const pref = lang === "pl" ? "pl" : "en";
    return r.voices
      .filter((v) => (v.locale || "").toLowerCase().startsWith(pref) && !v.notInstalled)
      .map((v) => ({ id: v.name, label: v.label || prettySystem(v), male: MALE_HINT.test(v.label || v.name),
                     network: !!v.network, quality: v.quality || 0 }));
  },
  async load(o) { await this.init(); return Lektor.load(o); },
  play: () => Lektor.play(), pause: () => Lektor.pause(), stop: () => Lektor.stop(),
  next: () => Lektor.next(), prev: () => Lektor.prev(), seek: (index) => Lektor.seek({ index }),
  setRate: (rate) => Lektor.setRate({ rate }),
  setVoice: (engine, voice, locale) => Lektor.setVoice({ engine, voice, locale }),
  setSleepTimer: (minutes) => Lektor.setSleepTimer({ minutes }),
  getState: () => Lektor.getState(),
};

function prettySystem(v) {
  const m = v.name.match(/^([a-z]{2})-([a-z]{2})-x-([a-z]+)-(local|network)$/i);
  const base = m ? `${m[1].toUpperCase()}-${m[2].toUpperCase()} ${m[3]}` : v.name;
  return `${base}${MALE_HINT.test(v.name) ? " ♂" : ""}${v.network ? " (online)" : ""}`;
}

/* ================================================================ wspólna baza dla implementacji JS */
class JsPlayer {
  constructor() { this.items = []; this.index = 0; this.playing = false; this.rate = 1; this.voice = ""; this.locale = "pl-PL"; this.gen = 0; this.sleepT = null; this.sleepEndsAt = 0; this.engine = "web"; }
  state(extra = {}) {
    return { type: "state", playing: this.playing, buffering: !!this.buffering, index: this.index,
      id: this.items[this.index]?.id ?? "", engine: this.engine, voice: this.voice, locale: this.locale, rate: this.rate,
      loaded: this.items.length, finished: !!this.finished, sleepEndsAt: this.sleepEndsAt, ...extra };
  }
  emitState(extra) { emit(this.state(extra)); }
  async load({ items, index = 0, voice, locale, rate = 1, autoplay = true }) {
    this.stopCurrent(); this.items = items; this.index = Math.max(0, Math.min(index, items.length - 1));
    this.voice = voice || ""; this.locale = locale || "pl-PL"; this.rate = rate; this.finished = false;
    if (autoplay) this.startAt(this.index); else this.emitState();
    return this.state();
  }
  async play() { if (this.playing) return; if (this.finished) this.index = 0; if (!(await this.resumeCurrent())) this.startAt(this.index); }
  async pause() { if (!this.playing) return; this.pauseCurrent(); this.playing = false; this.emitState(); }
  async stop() { this.stopCurrent(); this.playing = false; this.emitState(); }
  async next() { if (this.index + 1 < this.items.length) this.startAt(this.index + 1); }
  async prev() { this.startAt(Math.max(0, this.index - 1)); }
  async seek(i) { i = Math.max(0, Math.min(i, this.items.length - 1)); if (this.playing) this.startAt(i); else { this.index = i; this.finished = false; this.emitState(); } }
  async setRate(r) { this.rate = r; this.applyRate(); this.emitState(); }
  async setVoice(engine, voice, locale) { this.voice = voice || ""; this.locale = locale || this.locale; if (this.playing) this.startAt(this.index); else this.emitState(); }
  async setSleepTimer(min) {
    clearTimeout(this.sleepT); this.sleepT = null; this.sleepEndsAt = 0;
    if (min > 0) { this.sleepEndsAt = Date.now() + min * 60000; this.sleepT = setTimeout(() => { this.sleepEndsAt = 0; this.pause(); this.emitState({ sleep: true }); }, min * 60000); }
    this.emitState();
  }
  async getState() { return this.state(); }
  startAt(i) {
    this.gen++; this.stopCurrent(); this.index = i; this.playing = true; this.finished = false; this.emitState();
    this.speak(i, this.gen);
  }
  onDone(i, gen) {
    if (gen !== this.gen) return;
    emit({ type: "done", id: this.items[i].id, index: i });
    if (i + 1 >= this.items.length) { this.playing = false; this.finished = true; this.emitState(); return; }
    this.index = i + 1; this.speak(i + 1, gen);
  }
  fail(i, msg) { this.playing = false; emit({ type: "error", id: this.items[i]?.id, index: i, message: msg }); this.emitState(); }
  // do nadpisania:
  speak() {} stopCurrent() {} pauseCurrent() {} async resumeCurrent() { return false; } applyRate() {}
}

/* ================================================================ przeglądarka (Web Speech API) */
class WebPlayer extends JsPlayer {
  constructor() { super(); this.engine = "web"; }
  async voices(engine, lang) {
    let vs = speechSynthesis.getVoices();
    if (!vs.length) { await new Promise((r) => setTimeout(r, 300)); vs = speechSynthesis.getVoices(); }
    return vs.filter((v) => v.lang.toLowerCase().startsWith(lang)).map((v) => ({ id: v.name, label: v.name, male: MALE_HINT.test(v.name) }));
  }
  speak(i, gen) {
    const it = this.items[i];
    const u = new SpeechSynthesisUtterance(it.text);
    const v = speechSynthesis.getVoices().find((x) => x.name === this.voice);
    if (v) u.voice = v;
    u.lang = this.locale; u.rate = this.rate;
    u.onstart = () => gen === this.gen && emit({ type: "start", id: it.id, index: i });
    u.onboundary = (e) => gen === this.gen && emit({ type: "range", id: it.id, index: i, start: e.charIndex, end: e.charIndex + (e.charLength || 1) });
    u.onend = () => this.onDone(i, gen);
    u.onerror = (e) => { if (gen === this.gen && !["interrupted", "canceled"].includes(e.error)) this.fail(i, e.error); };
    this.utt = u;
    speechSynthesis.speak(u);
  }
  stopCurrent() { speechSynthesis.cancel(); }
  pauseCurrent() { this.gen++; speechSynthesis.cancel(); }
}

/* ================================================================ ElevenLabs */
class ElevenPlayer extends JsPlayer {
  constructor() { super(); this.engine = "elevenlabs"; this.audio = new Audio(); this.cache = new Map(); this.raf = 0; }
  key() { return localStorage.getItem("lektor.elevenKey") || ""; }
  async voices() {
    if (!this.key()) return [];
    try {
      const r = await http({ url: "https://api.elevenlabs.io/v1/voices", headers: { "xi-api-key": this.key() } });
      return r.voices.map((v) => ({ id: v.voice_id, label: v.name + (v.labels?.gender === "male" ? " ♂" : ""), male: v.labels?.gender === "male" }));
    } catch { return []; }
  }
  synth(it) {
    const k = this.voice + "|" + it.text;
    if (!this.cache.has(k)) {
      const p = http({
        url: `https://api.elevenlabs.io/v1/text-to-speech/${this.voice}/with-timestamps`, method: "POST",
        headers: { "xi-api-key": this.key(), "Content-Type": "application/json" },
        data: { text: it.text, model_id: "eleven_multilingual_v2", language_code: this.locale.slice(0, 2) },
      });
      p.catch(() => this.cache.delete(k));
      this.cache.set(k, p);
      if (this.cache.size > 40) this.cache.delete(this.cache.keys().next().value);
    }
    return this.cache.get(k);
  }
  async speak(i, gen) {
    const it = this.items[i];
    if (!this.key() || !this.voice) return this.fail(i, "Wpisz klucz API ElevenLabs i wybierz głos w ustawieniach.");
    this.buffering = true; this.emitState();
    let r;
    try { r = await this.synth(it); } catch (e) { if (gen === this.gen) { this.buffering = false; this.fail(i, e.message); } return; }
    if (gen !== this.gen) return;
    this.buffering = false;
    if (this.items[i + 1]) this.synth(this.items[i + 1]).catch(() => {});
    const starts = r.alignment?.character_start_times_seconds || [];
    this.audio.src = "data:audio/mpeg;base64," + r.audio_base64;
    this.audio.playbackRate = this.rate;
    this.audio.onended = () => this.onDone(i, gen);
    try { await this.audio.play(); } catch (e) { return this.fail(i, e.message); }
    emit({ type: "start", id: it.id, index: i }); this.emitState();
    let lastWs = -1;
    const tick = () => {
      if (gen !== this.gen) return;
      const t = this.audio.currentTime;
      let ci = 0;
      while (ci + 1 < starts.length && starts[ci + 1] <= t + 0.05) ci++;
      let ws = ci;
      while (ws > 0 && !/\s/.test(it.text[ws - 1] || " ")) ws--;
      let we = ws;
      while (we < it.text.length && !/\s/.test(it.text[we])) we++;
      if (ws !== lastWs) { lastWs = ws; emit({ type: "range", id: it.id, index: i, start: ws, end: we }); }
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }
  stopCurrent() { cancelAnimationFrame(this.raf); this.audio.pause(); this.audio.onended = null; this.audio.removeAttribute("src"); }
  pauseCurrent() { cancelAnimationFrame(this.raf); this.audio.pause(); }
  async resumeCurrent() {
    if (!this.audio.src || this.audio.ended || !this.audio.currentTime) return false;
    this.playing = true; try { await this.audio.play(); } catch { return false; }
    this.emitState(); return true;
  }
  applyRate() { this.audio.playbackRate = this.rate; }
}

/* ================================================================ fasada */
const webPlayer = isNative ? null : new WebPlayer();
const elevenPlayer = new ElevenPlayer();
let current = null; // aktywna implementacja

function implFor(engine) {
  if (engine === "elevenlabs") return elevenPlayer;
  if (isNative) return nativeImpl;
  return webPlayer;
}

export const player = {
  on(cb) { listeners.add(cb); },
  engine: null,
  async load(o) {
    const impl = implFor(o.engine);
    if (current && current !== impl) await current.stop();
    current = impl; this.engine = o.engine;
    return impl.load(o);
  },
  play: () => current?.play(), pause: () => current?.pause(), stop: () => current?.stop(),
  next: () => current?.next(), prev: () => current?.prev(), seek: (i) => current?.seek(i),
  setRate: (r) => current?.setRate(r),
  setSleepTimer: (m) => (current || implFor(player.engine || availableEngines()[0]))?.setSleepTimer(m),
  getState: () => current?.getState(),
  /** Zmiana silnika/głosu w trakcie – gdy silnik się zmienia, trzeba załadować od nowa (robi to app.js). */
  async setVoice(engine, voice, locale) {
    if (!current || implFor(engine) !== current) return false;
    await current.setVoice(engine, voice, locale);
    return true;
  },
  voices: (engine, lang) => implFor(engine).voices(engine, lang),
  pickDefault(voices, lang, engine) {
    if (engine === "edge") return voices.find((v) => v.id === PREFERRED_EDGE[lang])?.id || voices[0]?.id || "";
    if (engine === "system") {
      for (const id of PREFERRED_SYSTEM[lang] || []) { const v = voices.find((x) => x.id === id); if (v) return v.id; }
      const local = voices.filter((v) => !v.network);
      return (local.find((v) => v.male) || voices.find((v) => v.male) || local[0] || voices[0])?.id || "";
    }
    return (voices.find((v) => v.male) || voices[0])?.id || "";
  },
};
