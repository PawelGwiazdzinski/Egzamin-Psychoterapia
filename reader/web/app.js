/* Lektor – frontend */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const api = async (url, opts = {}) => {
  const o = { ...opts };
  if (o.json !== undefined) {
    o.body = JSON.stringify(o.json);
    o.headers = { "Content-Type": "application/json" };
    o.method = o.method || "POST";
    delete o.json;
  }
  const r = await fetch(url, o);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  return r.json();
};
const store = {
  get(k, d) { try { const v = localStorage.getItem("lektor." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("lektor." + k, JSON.stringify(v)); } catch {} },
};
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const norm = (s) => (s || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

let toastTimer;
function toast(html, ms = 3500) {
  const t = $("#toast");
  t.innerHTML = html;
  t.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => (t.hidden = true), ms);
}

/* ------------------------------------------------------------------ state */
const S = {
  status: null,
  docs: [],
  id: null,
  meta: null,
  doc: null,      // {pages, sentences, lang}
  notes: [],
  view: store.get("view", "pages"),
  idx: 0,
  playing: false,
  token: 0,
  rate: store.get("rate", 1),
  engine: store.get("engine", "edge"),
  voice: store.get("voice", {}), // {engine|lang: voiceName}
  lang: "pl",
  clips: new Map(),
  wordStarts: null,
  userScrollAt: 0,
};
const audio = $("#audio");

/* ------------------------------------------------------------------ init */
async function init() {
  if (innerWidth < 1100) $("#app").classList.add("lib-closed");
  if (innerWidth < 760) $("#app").classList.add("notes-closed");
  bindUI();
  await refreshStatus();
  await loadLibrary();
  const last = store.get("lastDoc");
  if (last && S.docs.some((d) => d.id === last && d.ready)) openDoc(last);
}

async function refreshStatus() {
  try { S.status = await api("/api/status"); } catch { S.status = null; }
  renderGoogleBox();
  renderEngines();
  const ob = $("#ocrBox");
  if (S.status) {
    ob.textContent = S.status.uocr_online ? "OCR: Unlimited-OCR połączony"
      : S.status.uocr_url ? "OCR: Unlimited-OCR offline (zapasowo Tesseract)" : "OCR skanów: Tesseract (Unlimited-OCR nieustawiony)";
  }
}

/* ------------------------------------------------------------------ library */
async function loadLibrary() {
  S.docs = await api("/api/docs");
  const ul = $("#docList");
  ul.innerHTML = "";
  if (!S.docs.length) {
    ul.innerHTML = `<li class="muted small" style="cursor:default">Biblioteka jest pusta.</li>`;
    return;
  }
  for (const d of S.docs) {
    const li = document.createElement("li");
    li.dataset.id = d.id;
    if (d.id === S.id) li.classList.add("on");
    const pct = d.sentences ? Math.round((100 * (d.position || 0)) / d.sentences) : 0;
    const info = d.ready ? `${(d.lang || "").toUpperCase()} · ${d.pages ? d.pages + " str." : "tekst"} · ${pct}%` : "przetwarzanie…";
    li.innerHTML = `<div class="t"><b title="${esc(d.title)}">${esc(d.title)}</b><span>${info}</span>
      <div class="bar"><i style="width:${pct}%"></i></div></div>
      <button class="icon-btn del" title="Usuń">✕</button>`;
    li.onclick = (e) => {
      if (e.target.closest(".del")) return deleteDoc(d);
      if (d.ready) openDoc(d.id); else waitForJob(d.id);
    };
    ul.appendChild(li);
  }
}

async function deleteDoc(d) {
  if (!confirm(`Usunąć „${d.title}” wraz z lokalnymi notatkami? (Dokument w Google Docs zostaje.)`)) return;
  await api(`/api/docs/${d.id}`, { method: "DELETE" });
  if (S.id === d.id) location.reload();
  loadLibrary();
}

async function uploadFile(file) {
  const fd = new FormData();
  fd.append("file", file);
  toast(`Wczytuję „${esc(file.name)}”…`, 0);
  try {
    const { id } = await api("/api/docs", { method: "POST", body: fd });
    await loadLibrary();
    await waitForJob(id);
  } catch (e) { toast("Błąd: " + esc(e.message)); }
}

async function waitForJob(id) {
  for (;;) {
    const j = await api(`/api/docs/${id}/job`);
    if (j.state === "done") { toast("Gotowe ✓", 1500); await loadLibrary(); return openDoc(id); }
    if (j.state === "error") { toast("Nie udało się przetworzyć: " + esc(j.msg), 8000); return loadLibrary(); }
    toast(esc(j.msg || "Przetwarzanie…"), 0);
    await new Promise((r) => setTimeout(r, 700));
  }
}

/* ------------------------------------------------------------------ open doc */
async function openDoc(id) {
  stop();
  const { meta, doc } = await api(`/api/docs/${id}`);
  S.id = id; S.meta = meta; S.doc = doc;
  S.clips.clear();
  S.lang = meta.lang || doc.lang || "pl";
  if (meta.engine) S.engine = meta.engine;
  S.idx = Math.min(meta.position || 0, doc.sentences.length - 1);
  store.set("lastDoc", id);
  $("#docTitle").textContent = meta.title;
  $("#empty").hidden = true;
  $$("#docList li").forEach((li) => li.classList.toggle("on", li.dataset.id === id));
  $("#mdExport").href = `/api/docs/${id}/notes.md`;
  if (innerWidth < 1100) $("#app").classList.add("lib-closed");
  const hasPages = doc.pages.length > 0;
  $("#viewSeg").hidden = !hasPages;
  if (!hasPages) S.view = "text";
  else S.view = store.get("view", "pages");
  renderEngines();
  renderLang();
  buildPages();
  buildText();
  setView(S.view);
  await loadNotes();
  highlight(true);
  updatePos();
  const ocrN = meta.ocr_pages || 0;
  if (ocrN) toast(`${ocrN} str. odczytano przez OCR`, 3000);
}

/* ------------------------------------------------------------------ pages view */
let pageObserver;
function buildPages() {
  const box = $("#pages");
  box.innerHTML = "";
  pageObserver?.disconnect();
  if (!S.doc.pages.length) return;
  pageObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const img = e.target.querySelector("img");
      if (!img.src) img.src = img.dataset.src;
      pageObserver.unobserve(e.target);
    }
  }, { root: $("#viewport"), rootMargin: "1200px 0px" });
  S.doc.pages.forEach((p, i) => {
    const div = document.createElement("div");
    div.className = "page";
    div.dataset.p = i;
    div.style.aspectRatio = `${p.w} / ${p.h}`;
    div.style.setProperty("--page-w", Math.round(Math.min(980, p.w * 1.45)) + "px");
    const badge = p.source !== "text" ? `<span class="badge">OCR: ${p.source}</span>` : "";
    div.innerHTML = `<img data-src="/api/docs/${S.id}/page/${i}.png?zoom=2" alt="Strona ${i + 1}">${badge}<span class="pno">${i + 1}</span>`;
    div.addEventListener("click", (e) => onPageClick(e, i, div));
    box.appendChild(div);
    pageObserver.observe(div);
  });
}

function onPageClick(e, pno, div) {
  const r = div.getBoundingClientRect();
  const p = S.doc.pages[pno];
  const x = ((e.clientX - r.left) / r.width) * p.w;
  const y = ((e.clientY - r.top) / r.height) * p.h;
  let best = -1, bestD = Infinity;
  S.doc.sentences.forEach((s, si) => {
    for (const w of s.words) {
      if (w[1] !== pno || w[2] == null) continue;
      const dx = Math.max(w[2] - x, 0, x - w[4]);
      const dy = Math.max(w[3] - y, 0, y - w[5]);
      const d = dx * dx + dy * dy * 4;
      if (d < bestD) { bestD = d; best = si; }
    }
  });
  if (best >= 0 && bestD < 900) playFrom(best);
}

/** Sumuje prostokąty słów zdania w linie, osobno dla każdej strony. */
function sentenceRects(s) {
  const boxes = [];
  for (const w of s.words) {
    if (w[2] != null) boxes.push({ p: w[1], b: [w[2], w[3], w[4], w[5]] });
    if (w.length > 6 && w[7] != null) boxes.push({ p: w[6], b: [w[7], w[8], w[9], w[10]] });
  }
  const lines = [];
  for (const { p, b } of boxes) {
    const h = b[3] - b[1];
    const L = lines.find((l) => l.p === p && Math.abs(l.b[1] - b[1]) < h * 0.6 && Math.abs(l.b[3] - b[3]) < h * 0.6
      && b[0] - l.b[2] < h * 3 && b[2] > l.b[0] - h * 3);
    if (L) { L.b = [Math.min(L.b[0], b[0]), Math.min(L.b[1], b[1]), Math.max(L.b[2], b[2]), Math.max(L.b[3], b[3])]; }
    else lines.push({ p, b: [...b] });
  }
  return lines;
}

function pct(b, p) {
  return `left:${(b[0] / p.w) * 100}%;top:${(b[1] / p.h) * 100}%;width:${((b[2] - b[0]) / p.w) * 100}%;height:${((b[3] - b[1]) / p.h) * 100}%`;
}

function drawPageHighlight() {
  $$(".page .hl").forEach((e) => e.remove());
  const s = S.doc?.sentences[S.idx];
  if (!s || !S.doc.pages.length) return null;
  let first = null;
  const approx = s.words.length > 1 && s.words.every((w) => w[2] != null && w[2] === s.words[0][2] && w[3] === s.words[0][3]);
  for (const { p, b } of sentenceRects(s)) {
    const div = $(`.page[data-p="${p}"]`);
    if (!div) continue;
    const pad = 1.5;
    const el = document.createElement("div");
    el.className = "hl" + (approx ? " block" : "");
    el.style.cssText = pct([b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad], S.doc.pages[p]);
    div.appendChild(el);
    if (!first) first = { div, b, p };
  }
  return first;
}

function drawWordHighlight(wi) {
  const s = S.doc?.sentences[S.idx];
  if (!s) return;
  // widok stron
  let el = $(".page .hl.word");
  const w = s.words[wi];
  if (S.view === "pages" && w && w[2] != null && !$(".page .hl.block")) {
    const div = $(`.page[data-p="${w[1]}"]`);
    if (div) {
      if (!el || el.parentNode !== div) { el?.remove(); el = document.createElement("div"); el.className = "hl word"; div.appendChild(el); }
      el.style.cssText = pct([w[2] - 1, w[3] - 1, w[4] + 1, w[5] + 1], S.doc.pages[w[1]]);
    }
  } else el?.remove();
  // widok tekstu
  const span = $(`#textView .s[data-i="${S.idx}"]`);
  if (span) {
    $$(".w.cur", span).forEach((x) => x.classList.remove("cur"));
    span.querySelector(`.w[data-w="${wi}"]`)?.classList.add("cur");
  }
}

/* ------------------------------------------------------------------ text view */
function buildText() {
  const tv = $("#textView");
  const frag = document.createDocumentFragment();
  let p = null, lastPage = -1;
  const noted = notedSet();
  S.doc.sentences.forEach((s, i) => {
    if (S.doc.pages.length && s.page !== lastPage) {
      const pg = document.createElement("span");
      pg.className = "pg";
      pg.textContent = `Strona ${s.page + 1}`;
      frag.appendChild(pg);
      lastPage = s.page;
      p = null;
    }
    if (!p || s.par) { p = document.createElement("p"); frag.appendChild(p); }
    const span = document.createElement("span");
    span.className = "s" + (noted.has(i) ? " noted" : "");
    span.dataset.i = i;
    span.textContent = s.text + " ";
    p.appendChild(span);
  });
  tv.innerHTML = "";
  tv.appendChild(frag);
}

document.addEventListener("click", (e) => {
    const s = e.target.closest("#textView .s");
    if (!s || String(getSelection()).trim()) return;
    playFrom(+s.dataset.i);
});

let wordsRendered = -1;
function renderTextCurrent() {
  const tv = $("#textView");
  const prev = tv.querySelector(".s.cur");
  if (prev) {
    prev.classList.remove("cur");
    if (wordsRendered >= 0) { prev.textContent = S.doc.sentences[+prev.dataset.i].text + " "; }
  }
  const cur = tv.querySelector(`.s[data-i="${S.idx}"]`);
  if (!cur) return null;
  cur.classList.add("cur");
  const s = S.doc.sentences[S.idx];
  cur.innerHTML = s.words.map((w, k) => `<span class="w" data-w="${k}">${esc(w[0])}</span>`).join(" ") + " ";
  wordsRendered = S.idx;
  return cur;
}

/* ------------------------------------------------------------------ highlight + scroll */
function highlight(force = false) {
  if (!S.doc) return;
  const pageHit = drawPageHighlight();
  const textEl = renderTextCurrent();
  if (!$("#follow").checked && !force) return;
  if (!force && Date.now() - S.userScrollAt < 4000) return;
  const vp = $("#viewport");
  let targetY = null;
  if (S.view === "pages" && pageHit) {
    const pr = S.doc.pages[pageHit.p];
    targetY = pageHit.div.offsetTop + (pageHit.b[1] / pr.h) * pageHit.div.offsetHeight;
  } else if (S.view === "text" && textEl) {
    targetY = textEl.offsetTop;
  }
  if (targetY == null) return;
  const top = vp.scrollTop, h = vp.clientHeight;
  if (force || targetY < top + h * 0.12 || targetY > top + h * 0.72) {
    vp.style.scrollBehavior = force ? "auto" : "smooth";
    vp.scrollTop = targetY - h * 0.3;
  }
}

function setView(v) {
  S.view = v;
  if (S.doc?.pages.length) store.set("view", v);
  $$("#viewSeg button").forEach((b) => b.classList.toggle("on", b.dataset.view === v));
  $("#pages").hidden = v !== "pages";
  $("#textView").hidden = v !== "text";
  highlight(true);
}

function updatePos() {
  if (!S.doc) return;
  const n = S.doc.sentences.length;
  const s = S.doc.sentences[S.idx];
  $("#posLabel").textContent = `${S.doc.pages.length ? "str. " + (s.page + 1) + " · " : ""}${S.idx + 1} / ${n}`;
  $("#progressFill").style.width = `${(100 * (S.idx + 1)) / n}%`;
  savePos();
}

let posTimer;
function savePos() {
  clearTimeout(posTimer);
  posTimer = setTimeout(() => S.id && api(`/api/docs/${S.id}`, { method: "PATCH", json: { position: S.idx } }).catch(() => {}), 1500);
}

/* ------------------------------------------------------------------ voices */
const ENGINE_LABEL = { edge: "Edge Neural (darmowy)", piper: "Piper (offline)", elevenlabs: "ElevenLabs", browser: "Przeglądarka" };
function renderEngines() {
  const sel = $("#engineSel");
  const engines = ["edge", "piper", "browser"];
  if (S.status?.elevenlabs) engines.splice(2, 0, "elevenlabs");
  if (!engines.includes(S.engine)) S.engine = "edge";
  sel.innerHTML = engines.map((e) => `<option value="${e}" ${e === S.engine ? "selected" : ""}>${ENGINE_LABEL[e]}</option>`).join("");
  renderVoices();
}

function voiceOptions() {
  const st = S.status;
  if (S.engine === "edge") return (st?.edge_alternatives?.[S.lang] || [st?.voices.edge[S.lang]]).filter(Boolean);
  if (S.engine === "piper") return [st?.voices.piper[S.lang]].filter(Boolean);
  if (S.engine === "elevenlabs") return [st?.voices.elevenlabs[S.lang]].filter(Boolean);
  const pref = S.lang === "pl" ? "pl" : "en";
  return speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith(pref)).map((v) => v.name);
}
function currentVoice() {
  const opts = voiceOptions();
  const saved = S.voice[S.engine + "|" + S.lang];
  return opts.includes(saved) ? saved : opts[0] || "";
}
function prettyVoice(v) {
  return v.replace(/^(pl-PL|en-US|en-GB)-/, "").replace(/Neural$/, "").replace(/Multilingual/, " Multilingual")
    .replace(/^(pl_PL|en_US)-/, "").replace(/-(medium|high|low)$/, " ($1)");
}
function renderVoices() {
  const opts = voiceOptions();
  const cur = currentVoice();
  $("#voiceSel").innerHTML = opts.length
    ? opts.map((v) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(prettyVoice(v))}</option>`).join("")
    : `<option value="">(brak głosu)</option>`;
}
function renderLang() {
  $$("#langSeg button").forEach((b) => b.classList.toggle("on", b.dataset.lang === S.lang));
  renderVoices();
}
if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = () => S.engine === "browser" && renderVoices();

/* ------------------------------------------------------------------ playback */
function clipKey(i) { return `${S.engine}|${currentVoice()}|${S.lang}|${i}`; }

function getClip(i) {
  const key = clipKey(i);
  if (!S.clips.has(key)) {
    const s = S.doc.sentences[i];
    const p = api("/api/tts", { json: { text: s.text, lang: S.lang, engine: S.engine, voice: currentVoice() } })
      .then((r) => {
        const bytes = Uint8Array.from(atob(r.audio), (c) => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: r.mime }));
        return { url, marks: r.marks, map: alignMarks(s.words, r.marks) };
      });
    p.catch(() => S.clips.delete(key));
    S.clips.set(key, p);
    if (S.clips.size > 40) {
      const [k, old] = S.clips.entries().next().value;
      S.clips.delete(k);
      old.then((c) => URL.revokeObjectURL(c.url)).catch(() => {});
    }
  }
  return S.clips.get(key);
}

/** Dopasowuje znaczniki czasu słów z syntezatora do słów zdania. */
function alignMarks(words, marks) {
  const map = [];
  let j = 0;
  for (const m of marks) {
    const nm = norm(m.t);
    let found = -1;
    for (let k = j; k < Math.min(words.length, j + 5); k++) {
      const nw = norm(words[k][0]);
      if (nw && nm && (nw === nm || nw.startsWith(nm) || nm.startsWith(nw))) { found = k; break; }
    }
    if (found >= 0) { map.push(found); j = found + 1; }
    else map.push(Math.max(0, j - 1));
  }
  return map;
}

function setPlayIcon() {
  $("#playBtn").textContent = S.playing ? "⏸" : "▶";
  $("#playBtn").title = S.playing ? "Pauza (Spacja)" : "Czytaj (Spacja)";
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = S.playing ? "playing" : "paused";
}
function setLoading(v) { $("#playBtn").classList.toggle("loading", v); }

async function playFrom(i) {
  if (!S.doc) return;
  S.idx = Math.max(0, Math.min(i, S.doc.sentences.length - 1));
  S.playing = true;
  S.userScrollAt = 0;
  setPlayIcon();
  highlight();
  updatePos();
  await speakCurrent();
}

async function speakCurrent() {
  const tok = ++S.token;
  audio.pause();
  if (S.engine === "browser") return speakBrowser(tok);
  speechSynthesis?.cancel();
  setLoading(true);
  let clip;
  try {
    clip = await getClip(S.idx);
  } catch (e) {
    if (tok !== S.token) return;
    setLoading(false);
    pause();
    toast(`${esc(e.message)}<br><small>Zmień silnik mowy (np. „Piper” offline albo „Przeglądarka”).</small>`, 9000);
    return;
  }
  if (tok !== S.token) return;
  setLoading(false);
  for (let k = 1; k <= 3; k++) if (S.idx + k < S.doc.sentences.length) getClip(S.idx + k).catch(() => {});
  S.curClip = clip;
  audio.src = clip.url;
  audio.playbackRate = S.rate;
  audio.preservesPitch = true;
  try { await audio.play(); } catch (e) { if (tok === S.token) { pause(); } }
  if (tok === S.token) wordLoop(tok);
}

function wordLoop(tok) {
  let last = -1;
  const step = () => {
    if (tok !== S.token || !S.playing) return;
    const c = S.curClip;
    if (c?.marks.length) {
      const t = audio.currentTime * 1000;
      let mi = -1;
      for (let k = 0; k < c.marks.length; k++) { if (c.marks[k].start <= t + 30) mi = k; else break; }
      const wi = mi >= 0 ? c.map[mi] : -1;
      if (wi !== last && wi >= 0) { drawWordHighlight(wi); last = wi; }
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

audio.addEventListener("ended", () => { if (S.playing) next(true); });

function speakBrowser(tok) {
  const s = S.doc.sentences[S.idx];
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(s.text);
  const v = speechSynthesis.getVoices().find((x) => x.name === currentVoice());
  if (v) u.voice = v;
  u.lang = S.lang === "pl" ? "pl-PL" : "en-US";
  u.rate = S.rate;
  // pozycje słów w tekście zdania
  const starts = [];
  let cur = 0;
  for (const w of s.words) { const k = s.text.indexOf(w[0], cur); starts.push(k < 0 ? cur : k); if (k >= 0) cur = k + w[0].length; }
  u.onboundary = (e) => {
    if (tok !== S.token) return;
    let wi = 0;
    while (wi + 1 < starts.length && starts[wi + 1] <= e.charIndex) wi++;
    drawWordHighlight(wi);
  };
  u.onend = () => { if (tok === S.token && S.playing) next(true); };
  speechSynthesis.speak(u);
}

function pause() {
  S.playing = false;
  S.token++;
  audio.pause();
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  setLoading(false);
  setPlayIcon();
}
function stop() { pause(); }
function toggle() {
  if (!S.doc) return;
  if (S.playing) return pause();
  // wznowienie w środku zdania, jeśli to ten sam klip
  if (S.engine !== "browser" && audio.src && S.curClip && S.curClip.url === audio.src && audio.currentTime > 0 && !audio.ended
      && S.clipIdx === S.idx) {
    S.playing = true; setPlayIcon();
    const tok = ++S.token;
    audio.play().then(() => wordLoop(tok)).catch(() => pause());
    return;
  }
  playFrom(S.idx);
}
function next(auto = false) {
  if (!S.doc) return;
  if (S.idx >= S.doc.sentences.length - 1) { pause(); if (auto) toast("Koniec dokumentu"); return; }
  if (S.playing) playFrom(S.idx + 1);
  else { S.idx++; highlight(); updatePos(); }
}
function prev() {
  if (!S.doc) return;
  const i = Math.max(0, S.idx - 1);
  if (S.playing) playFrom(i); else { S.idx = i; highlight(); updatePos(); }
}
audio.addEventListener("play", () => { S.clipIdx = S.idx; });

function setRate(r) {
  S.rate = Math.round(Math.min(3, Math.max(0.5, r)) * 100) / 100;
  $("#rate").value = S.rate;
  $("#rateOut").textContent = S.rate.toFixed(2) + "×";
  audio.playbackRate = S.rate;
  store.set("rate", S.rate);
}

/* ------------------------------------------------------------------ notes */
function notedSet() {
  const set = new Set();
  for (const n of S.notes) {
    if (n.sentence == null) continue;
    const [a, b] = Array.isArray(n.sentence) ? n.sentence : [n.sentence, n.sentence];
    for (let i = a; i <= b; i++) set.add(i);
  }
  return set;
}

async function loadNotes() {
  S.notes = await api(`/api/docs/${S.id}/notes`);
  renderNotes();
}

function groups() {
  const g = [];
  for (const n of S.notes) if (!g.includes(n.group)) g.push(n.group);
  return g;
}

function renderNotes() {
  const list = $("#noteList");
  const gd = S.meta?.gdoc_id;
  const link = $("#gdocLink");
  link.hidden = !gd;
  if (gd) link.href = `https://docs.google.com/document/d/${gd}/edit`;
  if (!S.notes.length) {
    list.innerHTML = `<div class="empty-notes">Brak notatek.<br>Podczas czytania naciśnij <kbd>N</kbd> albo „＋ Notatka”.</div>`;
  } else {
    const byGroup = {};
    for (const n of S.notes) (byGroup[n.group] ||= []).push(n);
    const collapsed = store.get("collapsed." + S.id, []);
    list.innerHTML = Object.entries(byGroup).map(([g, ns]) => `
      <details class="group" ${collapsed.includes(g) ? "" : "open"} data-g="${esc(g)}">
        <summary>${esc(g)} <span class="n">${ns.length}</span></summary>
        ${ns.map((n) => `
          <div class="note" data-id="${n.id}">
            ${n.quote ? `<q data-s="${Array.isArray(n.sentence) ? n.sentence[0] : n.sentence ?? ""}">${esc(n.quote)}</q>` : ""}
            ${n.thought ? `<p>${esc(n.thought)}</p>` : ""}
            <div class="meta">${n.page != null ? `s. ${n.page + 1}` : ""}
              <span title="${n.synced ? "Zapisane w Google Docs" : "Tylko lokalnie"}">${n.synced ? "☁ Google Docs" : "● lokalnie"}</span>
              <span class="acts"><button data-act="edit">edytuj</button><button data-act="del">usuń</button></span>
            </div>
          </div>`).join("")}
      </details>`).join("");
  }
  $("#groupList").innerHTML = groups().map((g) => `<option value="${esc(g)}">`).join("");
  const noted = notedSet();
  $$("#textView .s").forEach((el) => el.classList.toggle("noted", noted.has(+el.dataset.i)));
}

$("#noteList").addEventListener("click", async (e) => {
  const q = e.target.closest("q[data-s]");
  if (q && q.dataset.s !== "") { S.idx = +q.dataset.s; S.playing ? playFrom(S.idx) : (highlight(true), updatePos()); return; }
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = btn.closest(".note").dataset.id;
  const n = S.notes.find((x) => x.id === id);
  if (btn.dataset.act === "del") {
    if (!confirm("Usunąć notatkę? (W Google Docs usuń ją ręcznie albo użyj „Przebuduj dokument”.)")) return;
    await api(`/api/docs/${S.id}/notes/${id}`, { method: "DELETE" });
    loadNotes();
  } else {
    const thought = prompt("Edytuj swoją myśl:", n.thought);
    if (thought === null) return;
    const group = prompt("Grupa:", n.group);
    if (group === null) return;
    await api(`/api/docs/${S.id}/notes/${id}`, { method: "PUT", json: { thought, group } });
    loadNotes();
    toast("Zmieniono lokalnie. Aby odświeżyć Google Docs: ⋯ → Przebuduj dokument.", 5000);
  }
});
$("#noteList").addEventListener("toggle", (e) => {
  const d = e.target.closest("details.group");
  if (!d) return;
  const collapsed = $$("details.group:not([open])").map((x) => x.dataset.g);
  store.set("collapsed." + S.id, collapsed);
}, true);

/* composer */
const C = { range: null, wasPlaying: false };
function openComposer() {
  if (!S.doc) return toast("Najpierw otwórz dokument");
  C.wasPlaying = S.playing;
  pause();
  $("#app").classList.remove("notes-closed");
  const sel = String(getSelection()).trim();
  C.range = [S.idx, S.idx];
  $("#qText").textContent = sel || S.doc.sentences[S.idx].text;
  C.custom = !!sel;
  $("#thought").value = "";
  const lastGroup = store.get("group." + S.id, "");
  $("#group").value = lastGroup;
  const gs = groups();
  $("#groupChips").innerHTML = gs.slice(-10).map((g) => `<button type="button" class="chip ${g === lastGroup ? "on" : ""}">${esc(g)}</button>`).join("");
  $("#composer").hidden = false;
  $("#thought").focus();
}
function extendQuote(dir) {
  if (!C.range) return;
  if (dir < 0 && C.range[0] > 0) C.range[0]--;
  if (dir > 0 && C.range[1] < S.doc.sentences.length - 1) C.range[1]++;
  C.custom = false;
  $("#qText").textContent = S.doc.sentences.slice(C.range[0], C.range[1] + 1).map((s) => s.text).join(" ");
}
function closeComposer() {
  $("#composer").hidden = true;
  stopDictation();
}
async function saveNote(e) {
  e?.preventDefault();
  const quote = $("#qText").textContent.trim();
  const thought = $("#thought").value.trim();
  const group = $("#group").value.trim() || "Bez grupy";
  if (!quote && !thought) return;
  store.set("group." + S.id, group);
  const s0 = S.doc.sentences[C.range[0]];
  const body = { quote, thought, group, page: S.doc.pages.length ? s0.page : null,
                 sentence: C.range[0] === C.range[1] ? C.range[0] : C.range };
  closeComposer();
  toast("Zapisuję notatkę…", 0);
  try {
    const r = await api(`/api/docs/${S.id}/notes`, { json: body });
    if (r.gdoc_url && !S.meta.gdoc_id) S.meta.gdoc_id = r.gdoc_url.split("/d/")[1].split("/")[0];
    toast(r.warning ? esc(r.warning) : `Zapisano w Google Docs ✓ <a href="${r.gdoc_url}" target="_blank">otwórz</a>`, r.warning ? 5000 : 2500);
  } catch (err) { toast("Błąd zapisu: " + esc(err.message), 6000); }
  await loadNotes();
  if (C.wasPlaying && $("#resumeAfter").checked) playFrom(S.idx);
}

/* dyktowanie */
let rec = null;
function toggleDictation() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return toast("Dyktowanie działa w Chrome / Edge.");
  if (rec) return stopDictation();
  rec = new SR();
  rec.lang = S.lang === "en" ? "en-US" : "pl-PL";
  rec.continuous = true;
  rec.interimResults = true;
  const ta = $("#thought");
  const base = ta.value ? ta.value.replace(/\s*$/, " ") : "";
  let finalText = "";
  rec.onresult = (ev) => {
    let interim = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      if (ev.results[i].isFinal) finalText += ev.results[i][0].transcript;
      else interim += ev.results[i][0].transcript;
    }
    ta.value = base + finalText + interim;
  };
  rec.onend = () => stopDictation();
  rec.start();
  $("#dictate").classList.add("on");
}
function stopDictation() {
  if (rec) { rec.onend = null; try { rec.stop(); } catch {} }
  rec = null;
  $("#dictate").classList.remove("on");
}

/* ------------------------------------------------------------------ Google */
function renderGoogleBox() {
  const box = $("#googleBox");
  const st = S.status;
  if (!st) { box.innerHTML = `<span class="small muted">Serwer niedostępny</span>`; return; }
  if (!st.google_configured) {
    box.innerHTML = `<div class="gstatus"><span class="dot"></span><span>Google Docs: nieskonfigurowane</span></div>
      <span class="small muted">Dodaj <code>data/google_client_secret.json</code> – instrukcja w README.</span>`;
  } else if (!st.google_connected) {
    box.innerHTML = `<div class="gstatus"><span class="dot"></span><span>Google Docs</span></div>
      <button class="accent" id="gLogin">Połącz z Google</button>`;
    $("#gLogin").onclick = () => window.open("/api/google/login", "google", "width=520,height=680");
  } else {
    box.innerHTML = `<div class="gstatus"><span class="dot ok"></span><span>Google Docs połączone</span>
      <span class="spacer"></span><button class="chip" id="gLogout">rozłącz</button></div>`;
    $("#gLogout").onclick = async () => { await api("/api/google/logout", { method: "POST" }); refreshStatus(); };
  }
}
window.addEventListener("message", (e) => { if (e.data === "google-ok") { refreshStatus(); toast("Połączono z Google ✓"); } });

async function rebuildGdoc() {
  if (!S.id) return;
  toast("Przebudowuję dokument Google…", 0);
  try {
    const r = await api(`/api/docs/${S.id}/gdoc/rebuild`, { method: "POST" });
    S.meta.gdoc_id = r.gdoc_url.split("/d/")[1].split("/")[0];
    toast(`Gotowe ✓ <a href="${r.gdoc_url}" target="_blank">otwórz</a>`);
    loadNotes();
  } catch (e) { toast("Błąd: " + esc(e.message), 7000); }
}
async function linkGdoc() {
  if (!S.id) return;
  const url = prompt("Wklej link do istniejącego dokumentu Google Docs.\nNowe notatki będą dopisywane pod nagłówkami grup:");
  if (!url) return;
  try {
    const r = await api(`/api/docs/${S.id}/gdoc/link`, { json: { url } });
    S.meta.gdoc_id = r.gdoc_url.split("/d/")[1].split("/")[0];
    renderNotes();
    toast("Podłączono dokument ✓");
  } catch (e) { toast("Błąd: " + esc(e.message)); }
}

/* ------------------------------------------------------------------ UI bindings */
function bindUI() {
  $("#playBtn").onclick = toggle;
  $("#nextBtn").onclick = () => next();
  $("#prevBtn").onclick = prev;
  $("#noteBtn").onclick = openComposer;
  setRate(S.rate);
  $("#rate").oninput = (e) => setRate(+e.target.value);
  $("#engineSel").onchange = (e) => {
    S.engine = e.target.value;
    store.set("engine", S.engine);
    if (S.id) api(`/api/docs/${S.id}`, { method: "PATCH", json: { engine: S.engine } }).catch(() => {});
    renderVoices();
    if (S.playing) playFrom(S.idx);
  };
  $("#voiceSel").onchange = (e) => {
    S.voice[S.engine + "|" + S.lang] = e.target.value;
    store.set("voice", S.voice);
    if (S.playing) playFrom(S.idx);
  };
  $$("#langSeg button").forEach((b) => (b.onclick = () => {
    S.lang = b.dataset.lang;
    renderLang();
    if (S.id) api(`/api/docs/${S.id}`, { method: "PATCH", json: { lang: S.lang } }).catch(() => {});
    if (S.playing) playFrom(S.idx);
  }));
  $$("#viewSeg button").forEach((b) => (b.onclick = () => setView(b.dataset.view)));
  $("#progress").onclick = (e) => {
    if (!S.doc) return;
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.floor(((e.clientX - r.left) / r.width) * S.doc.sentences.length);
    S.playing ? playFrom(i) : ((S.idx = i), highlight(true), updatePos());
  };
  const vp = $("#viewport");
  ["wheel", "touchmove"].forEach((ev) => vp.addEventListener(ev, () => (S.userScrollAt = Date.now()), { passive: true }));

  $("#libClose").onclick = () => $("#app").classList.add("lib-closed");
  $("#libOpen").onclick = () => $("#app").classList.toggle("lib-closed");
  $("#notesClose").onclick = () => $("#app").classList.add("notes-closed");
  $("#notesOpen").onclick = () => $("#app").classList.toggle("notes-closed");

  // upload
  $("#fileInput").onchange = (e) => e.target.files[0] && uploadFile(e.target.files[0]);
  const drop = $("#drop");
  ["dragenter", "dragover"].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  document.addEventListener("drop", (e) => { const f = e.dataTransfer?.files?.[0]; if (f) uploadFile(f); });
  $("#pasteBtn").onclick = () => $("#pasteDlg").showModal();
  $("#pasteDlg").addEventListener("close", async () => {
    if ($("#pasteDlg").returnValue !== "ok") return;
    const text = $("#pasteText").value.trim();
    if (!text) return;
    const { id } = await api("/api/docs/text", { json: { text, title: $("#pasteTitle").value.trim() } });
    $("#pasteText").value = ""; $("#pasteTitle").value = "";
    await loadLibrary();
    openDoc(id);
  });

  // composer
  $("#composer").onsubmit = saveNote;
  $("#cancelNote").onclick = () => { closeComposer(); if (C.wasPlaying) playFrom(S.idx); };
  $("#qPrev").onclick = () => extendQuote(-1);
  $("#qNext").onclick = () => extendQuote(1);
  $("#dictate").onclick = toggleDictation;
  $("#groupChips").onclick = (e) => {
    const c = e.target.closest(".chip");
    if (!c) return;
    $("#group").value = c.textContent;
    $$("#groupChips .chip").forEach((x) => x.classList.toggle("on", x === c));
  };
  $("#composer").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) saveNote(e);
    if (e.key === "Escape") { closeComposer(); }
  });

  $("#gdocMenu").onclick = () => ($("#gdocOptions").hidden = !$("#gdocOptions").hidden);
  $("#rebuildBtn").onclick = rebuildGdoc;
  $("#linkBtn").onclick = linkGdoc;

  // klawiatura
  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea, select, [contenteditable=true]") || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === " ") { e.preventDefault(); toggle(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); next(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); prev(); }
    else if (e.key === "n" || e.key === "N") { e.preventDefault(); openComposer(); }
    else if (e.key === "+" || e.key === "=") setRate(S.rate + 0.1);
    else if (e.key === "-") setRate(S.rate - 0.1);
  });

  if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("play", toggle);
    navigator.mediaSession.setActionHandler("pause", pause);
    navigator.mediaSession.setActionHandler("nexttrack", () => next());
    navigator.mediaSession.setActionHandler("previoustrack", prev);
  }
}

init();
