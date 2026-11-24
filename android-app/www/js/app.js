// Lektor (Android) – logika aplikacji
import { db, uid, prefs } from "./db.js";
import { openPdf, extract, renderPage } from "./pdfdoc.js";
import { fromPlainText, detectLang } from "./textproc.js";
import { ocrPage } from "./ocr.js";
import { player, availableEngines, ENGINE_LABEL } from "./speech.js";
import * as gdocs from "./gdocs.js";
import { Lektor, isNative, share, onBackButton, minimizeApp, openExternal } from "./native.js";

const APP_VERSION = "1.2";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

let toastT;
function toast(html, ms = 3000) {
  const t = $("#toast");
  t.innerHTML = html;
  t.hidden = false;
  clearTimeout(toastT);
  if (ms) toastT = setTimeout(() => (t.hidden = true), ms);
}

const S = {
  id: null, meta: null, doc: null, pdf: null, notes: [],
  view: prefs.get("view", "pages"), zoom: prefs.get("zoom", 1),
  idx: 0, playing: false, buffering: false, loadedDoc: null, loadedEngine: null,
  engines: [], engine: null, lang: "pl", voices: [], voice: "",
  rate: prefs.get("rate", 1), follow: prefs.get("follow", true), sleepEndsAt: 0,
  userScrollAt: 0, wordStarts: new Map(),
};

/* ================================================================ start */
async function init() {
  applyTheme(prefs.get("theme", "auto"));
  document.documentElement.style.setProperty("--fs", prefs.get("fontSize", 19) + "px");
  document.documentElement.style.setProperty("--zoom", S.zoom);
  $("#appVersion").textContent = APP_VERSION;
  S.engines = availableEngines();
  S.engine = prefs.get("engine", null);
  if (!S.engines.includes(S.engine)) S.engine = S.engines[0];
  bindUI();
  window.__lektorReady = true;
  document.getElementById("fatal")?.remove();
  addEventListener("unhandledrejection", (e) => console.error("unhandled", e.reason));
  player.on(onPlayerEvent);
  await renderLibrary();
  const last = prefs.get("lastDoc", null);
  if (last && (await db.get("meta", last))) await openDoc(last);
  else { showEmpty(); await loadVoices(); }
  if (Lektor) {
    Lektor.addListener("sharedFile", (f) => importShared(f));
    Lektor.addListener("appLink", (l) => onAppLink(l));
    onBackButton(onBack);
    syncPlayerState();
  }
  if (gdocs.isConfigured()) setTimeout(syncPending, 4000);
}

function onBack() {
  const open = $$("dialog[open]");
  if (open.length) return open.at(-1).close();
  if (!$("#library").hidden || !$("#notes").hidden) return closeDrawers();
  minimizeApp();
}

async function syncPlayerState() {
  try {
    const st = await player.getState();
    if (st) onPlayerEvent({ type: "state", ...st });
  } catch { /* brak stanu */ }
}

/* ================================================================ biblioteka */
async function allMetas() {
  return (await db.all("meta")).sort((a, b) => (b.opened || b.created) - (a.opened || a.created));
}
async function renderLibrary() {
  const metas = await allMetas();
  const ul = $("#docList");
  if (!metas.length) { ul.innerHTML = `<li class="muted small" style="padding:12px">Biblioteka jest pusta.</li>`; return; }
  ul.innerHTML = metas.map((m) => {
    const pct = m.sentences ? Math.round((100 * (m.position || 0)) / m.sentences) : 0;
    return `<li data-id="${m.id}" class="${m.id === S.id ? "on" : ""}"><div class="t"><b>${esc(m.title)}</b>
      <span>${(m.lang || "").toUpperCase()} · ${m.pages ? m.pages + " str." : "tekst"} · ${pct}%</span><div class="bar"><i style="width:${pct}%"></i></div></div>
      <button class="icon-btn menu" aria-label="Więcej">⋯</button></li>`;
  }).join("");
}
$("#docList").addEventListener("click", async (e) => {
  const li = e.target.closest("li[data-id]");
  if (!li) return;
  const m = await db.get("meta", li.dataset.id);
  if (!m) return;
  if (e.target.closest(".menu")) return openDocMenu(m);
  closeDrawers();
  openDoc(m.id);
});

let menuMeta = null;
function openDocMenu(m) {
  menuMeta = m;
  $("#dmTitle").textContent = m.title;
  $("#docMenu").showModal();
}
async function deleteDoc(m) {
  if (!confirm(`Usunąć „${m.title}” i jego lokalne notatki? (Dokument w Google Docs zostaje.)`)) return;
  if (S.id === m.id) { await player.stop().catch(() => {}); S.id = null; S.doc = null; S.loadedDoc = null; prefs.set("lastDoc", null); showEmpty(); }
  await db.removeDoc(m.id);
  renderLibrary();
}
async function renameDoc(m) {
  const t = await ask("Nazwa dokumentu", m.title);
  if (!t || t === m.title) return;
  m.title = t;
  await db.put("meta", m);
  if (S.id === m.id) { S.meta.title = t; $("#docTitle").textContent = t; }
  renderLibrary();
}

/* ================================================================ import */
async function importFile(file) {
  const isText = /\.(txt|md)$/i.test(file.name) || file.type.startsWith("text/");
  const data = isText ? await file.text() : await file.arrayBuffer();
  return importData(file.name, data, isText);
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u.buffer;
}
function importShared(f) {
  if (!f) return;
  if (f.error) return toast("Nie udało się otworzyć pliku: " + esc(f.error), 6000);
  if (f.text) return importData(f.name || "Udostępniony tekst", f.text, true);
  if (f.data) return importData(f.name || "dokument.pdf", b64ToBytes(f.data), false);
}
async function importData(name, data, isText, title) {
  closeDrawers();
  const id = uid();
  toast("Wczytuję…", 0);
  try {
    let doc;
    if (isText) {
      const sentences = fromPlainText(data);
      doc = { pages: [], sentences, lang: detectLang(data), title: "" };
      await db.put("files", data, id);
    } else {
      await db.put("files", data.slice(0), id);
      const pdf = await openPdf(new Uint8Array(data.slice(0)));
      doc = await extract(pdf, { progress: (m) => toast(esc(m), 0), ocr: ocrPage });
      pdf.destroy();
    }
    if (!doc.sentences.length) throw new Error("Nie znaleziono tekstu. Jeśli to skan, OCR mógł się nie powieść.");
    const meta = { id, title: title || doc.title || name.replace(/\.[^.]+$/, ""), kind: isText ? "txt" : "pdf", created: Date.now(),
      position: 0, lang: doc.lang, pages: doc.pages.length, sentences: doc.sentences.length,
      ocrPages: doc.pages.filter((p) => p.source !== "text").length };
    await db.put("docs", { pages: doc.pages, sentences: doc.sentences }, id);
    await db.put("meta", meta);
    toast("Gotowe ✓", 1500);
    await openDoc(id);
    if (meta.ocrPages) toast(`${meta.ocrPages} str. odczytano przez OCR`);
  } catch (e) {
    await db.removeDoc(id);
    toast("Nie udało się wczytać: " + esc(e.message), 7000);
  }
  renderLibrary();
}

/* ================================================================ otwieranie */
function showEmpty() {
  $("#empty").hidden = false; $("#pages").hidden = true; $("#textView").hidden = true; $("#viewToggle").hidden = true;
  $("#docTitle").textContent = "Lektor";
  $("#posLabel").textContent = ""; $("#progressFill").style.width = "0";
}
async function openDoc(id) {
  if (S.id && S.id !== id && S.playing) await player.stop().catch(() => {});
  const meta = await db.get("meta", id);
  const doc = await db.get("docs", id);
  if (!meta || !doc) return showEmpty();
  S.pdf?.destroy();
  S.pdf = null;
  if (meta.kind === "pdf") S.pdf = await openPdf(new Uint8Array(await db.get("files", id)));
  S.id = id; S.meta = meta; S.doc = doc;
  if (S.loadedDoc !== id) { S.loadedDoc = null; S.playing = false; }
  S.idx = Math.min(meta.position || 0, doc.sentences.length - 1);
  S.lang = meta.lang || "pl";
  S.wordStarts.clear();
  meta.opened = Date.now();
  db.put("meta", meta);
  prefs.set("lastDoc", id);
  $("#docTitle").textContent = meta.title;
  $("#empty").hidden = true;
  $("#viewToggle").hidden = !doc.pages.length;
  buildPages();
  buildText();
  setView(doc.pages.length ? S.view : "text", true);
  await loadVoices();
  await loadNotes();
  updatePos();
  setPlayIcon();
  renderLibrary();
}

/* ================================================================ widok stron + zoom */
let pageObs;
function buildPages() {
  const box = $("#pages");
  box.innerHTML = "";
  pageObs?.disconnect();
  if (!S.pdf) return;
  pageObs = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) renderOne(e.target);
  }, { root: $("#viewport"), rootMargin: "1500px 0px" });
  S.doc.pages.forEach((p, i) => {
    const div = document.createElement("div");
    div.className = "page";
    div.dataset.p = i;
    div.style.aspectRatio = `${p.w} / ${p.h}`;
    div.innerHTML = `<canvas></canvas>${p.source !== "text" ? `<span class="badge">OCR: ${esc(p.source)}</span>` : ""}<span class="pno">${i + 1}</span>`;
    box.appendChild(div);
    pageObs.observe(div);
  });
}
function renderOne(div) {
  const w = div.clientWidth;
  if (!w || div.dataset.w === String(w) || div.dataset.busy) return;
  div.dataset.busy = "1";
  renderPage(S.pdf, +div.dataset.p, div.querySelector("canvas"), w)
    .then(() => { div.dataset.w = String(w); })
    .catch(() => {})
    .finally(() => { delete div.dataset.busy; });
}
function renderVisible() {
  const vr = $("#viewport").getBoundingClientRect();
  for (const div of $$(".page")) {
    const r = div.getBoundingClientRect();
    if (r.bottom > vr.top - 1200 && r.top < vr.bottom + 1200) renderOne(div);
  }
}
let lastWidth = innerWidth;
addEventListener("resize", () => {
  if (Math.abs(innerWidth - lastWidth) < 40 || !S.pdf) return;
  lastWidth = innerWidth;
  setTimeout(() => { renderVisible(); highlight(true); }, 50);
});

function setZoom(z, focal) {
  z = clamp(z, 1, 3);
  const vp = $("#viewport");
  const r = z / S.zoom;
  const fx = focal ? focal.x : vp.clientWidth / 2, fy = focal ? focal.y : vp.clientHeight / 2;
  const sl = vp.scrollLeft, st = vp.scrollTop;
  S.zoom = z;
  document.documentElement.style.setProperty("--zoom", z.toFixed(3));
  vp.scrollLeft = (sl + fx) * r - fx;
  vp.scrollTop = (st + fy) * r - fy;
}
let pinch = null;
const dist = (e) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
function bindPinch() {
  const vp = $("#viewport");
  vp.addEventListener("touchstart", (e) => {
    if (e.touches.length === 2 && S.view === "pages" && S.pdf) {
      const r = vp.getBoundingClientRect();
      pinch = { d: dist(e), z: S.zoom, x: (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left, y: (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top };
    }
  }, { passive: true });
  vp.addEventListener("touchmove", (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    setZoom(pinch.z * dist(e) / pinch.d, pinch);
  }, { passive: false });
  const end = () => { if (!pinch) return; pinch = null; prefs.set("zoom", S.zoom); setTimeout(renderVisible, 80); };
  vp.addEventListener("touchend", end);
  vp.addEventListener("touchcancel", end);
}

$("#pages").addEventListener("click", (e) => {
  const div = e.target.closest(".page");
  if (!div || pinch) return;
  const pno = +div.dataset.p, p = S.doc.pages[pno], r = div.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * p.w, y = ((e.clientY - r.top) / r.height) * p.h;
  let best = -1, bestD = Infinity;
  S.doc.sentences.forEach((s, si) => {
    if (Math.abs(s.page - pno) > 1) return;
    for (const w of s.words) {
      if (w[1] !== pno || w[2] == null) continue;
      const dx = Math.max(w[2] - x, 0, x - w[4]), dy = Math.max(w[3] - y, 0, y - w[5]);
      const d = dx * dx + dy * dy * 4;
      if (d < bestD) { bestD = d; best = si; }
    }
  });
  if (best >= 0 && bestD < 900) jumpTo(best, true);
});

function sentenceRects(s) {
  const boxes = [];
  for (const w of s.words) {
    if (w[2] != null) boxes.push({ p: w[1], b: [w[2], w[3], w[4], w[5]] });
    if (w.length > 6 && w[7] != null) boxes.push({ p: w[6], b: [w[7], w[8], w[9], w[10]] });
  }
  const lines = [];
  for (const { p, b } of boxes) {
    const h = b[3] - b[1];
    const L = lines.find((l) => l.p === p && Math.abs(l.b[1] - b[1]) < h * 0.6 && Math.abs(l.b[3] - b[3]) < h * 0.6 && b[0] - l.b[2] < h * 3 && b[2] > l.b[0] - h * 3);
    if (L) L.b = [Math.min(L.b[0], b[0]), Math.min(L.b[1], b[1]), Math.max(L.b[2], b[2]), Math.max(L.b[3], b[3])];
    else lines.push({ p, b: [...b] });
  }
  return lines;
}
const pct = (b, p) => `left:${(b[0] / p.w) * 100}%;top:${(b[1] / p.h) * 100}%;width:${((b[2] - b[0]) / p.w) * 100}%;height:${((b[3] - b[1]) / p.h) * 100}%`;

function drawPageHL() {
  $$(".page .hl").forEach((e) => e.remove());
  const s = S.doc?.sentences[S.idx];
  if (!s || !S.pdf) return null;
  const w0 = s.words[0];
  const approx = s.words.length > 1 && s.words.every((w) => w[2] != null && w[2] === w0[2] && w[3] === w0[3]);
  let first = null;
  for (const { p, b } of sentenceRects(s)) {
    const div = $(`.page[data-p="${p}"]`);
    if (!div) continue;
    const el = document.createElement("div");
    el.className = "hl" + (approx ? " block" : "");
    el.style.cssText = pct([b[0] - 1.5, b[1] - 1.5, b[2] + 1.5, b[3] + 1.5], S.doc.pages[p]);
    div.appendChild(el);
    first ||= { div, b, p };
  }
  return first;
}
function drawWord(wi) {
  const s = S.doc?.sentences[S.idx];
  if (!s) return;
  const w = s.words[wi];
  let el = $(".page .hl.word");
  if (S.view === "pages" && w && w[2] != null && !$(".page .hl.block")) {
    const div = $(`.page[data-p="${w[1]}"]`);
    if (div) {
      if (!el || el.parentNode !== div) { el?.remove(); el = document.createElement("div"); el.className = "hl word"; div.appendChild(el); }
      el.style.cssText = pct([w[2] - 1, w[3] - 1, w[4] + 1, w[5] + 1], S.doc.pages[w[1]]);
    }
  } else el?.remove();
  const span = $("#textView .s.cur");
  if (span) {
    span.querySelector(".w.cur")?.classList.remove("cur");
    span.querySelector(`.w[data-w="${wi}"]`)?.classList.add("cur");
  }
}

/* ================================================================ widok tekstu */
function buildText() {
  const tv = $("#textView");
  const frag = document.createDocumentFragment();
  let p = null, lastPage = -1;
  S.doc.sentences.forEach((s, i) => {
    if (S.doc.pages.length && s.page !== lastPage) {
      const pg = document.createElement("span");
      pg.className = "pg"; pg.textContent = `Strona ${s.page + 1}`;
      frag.appendChild(pg); lastPage = s.page; p = null;
    }
    if (!p || s.par) { p = document.createElement("p"); frag.appendChild(p); }
    const sp = document.createElement("span");
    sp.className = "s"; sp.dataset.i = i; sp.textContent = s.text + " ";
    p.appendChild(sp);
  });
  tv.innerHTML = "";
  tv.appendChild(frag);
}
$("#textView").addEventListener("click", (e) => {
  const s = e.target.closest(".s");
  if (s && !String(getSelection()).trim()) jumpTo(+s.dataset.i, true);
});
function renderTextCur() {
  const tv = $("#textView");
  const prev = tv.querySelector(".s.cur");
  if (prev) { prev.classList.remove("cur"); prev.textContent = S.doc.sentences[+prev.dataset.i].text + " "; }
  const cur = tv.querySelector(`.s[data-i="${S.idx}"]`);
  if (!cur) return null;
  cur.classList.add("cur");
  cur.innerHTML = S.doc.sentences[S.idx].words.map((w, k) => `<span class="w" data-w="${k}">${esc(w[0])}</span>`).join(" ") + " ";
  return cur;
}

function highlight(force = false) {
  if (!S.doc) return;
  const hit = drawPageHL();
  const tEl = renderTextCur();
  if (!force && (!S.follow || Date.now() - S.userScrollAt < 5000)) return;
  const vp = $("#viewport");
  let y = null, x = null;
  if (S.view === "pages" && hit) {
    const pr = S.doc.pages[hit.p];
    y = hit.div.offsetTop + (hit.b[1] / pr.h) * hit.div.offsetHeight;
    x = hit.div.offsetLeft + (hit.b[0] / pr.w) * hit.div.offsetWidth;
  } else if (S.view === "text" && tEl) y = tEl.offsetTop;
  if (y == null) return;
  const top = vp.scrollTop, h = vp.clientHeight;
  const opts = { behavior: force ? "auto" : "smooth" };
  if (force || y < top + h * 0.1 || y > top + h * 0.7) opts.top = y - h * 0.3;
  if (x != null && S.zoom > 1 && (x < vp.scrollLeft + 20 || x > vp.scrollLeft + vp.clientWidth - 60)) opts.left = Math.max(0, x - 40);
  if (opts.top != null || opts.left != null) vp.scrollTo(opts);
}
function setView(v, silent) {
  S.view = v;
  if (!silent && S.pdf) prefs.set("view", v);
  $("#pages").hidden = v !== "pages";
  $("#textView").hidden = v !== "text";
  $("#viewToggle").textContent = v === "pages" ? "¶" : "▤";
  if (v === "pages") setTimeout(renderVisible, 0);
  highlight(true);
}
function updatePos() {
  if (!S.doc) return;
  const n = S.doc.sentences.length, s = S.doc.sentences[S.idx];
  let label = S.pdf ? `s. ${s.page + 1}/${S.doc.pages.length}` : `${Math.round((100 * (S.idx + 1)) / n)}%`;
  if (S.sleepEndsAt > Date.now()) label += ` · 🌙 ${Math.ceil((S.sleepEndsAt - Date.now()) / 60000)} min`;
  $("#posLabel").textContent = label;
  $("#progressFill").style.width = `${(100 * (S.idx + 1)) / n}%`;
  if (updatePos.t) return;
  updatePos.t = setTimeout(() => { updatePos.t = null; savePos(); }, 1500);
}
function savePos() {
  if (!S.meta) return;
  S.meta.position = S.idx;
  db.put("meta", S.meta).catch(() => {});
}

/* ================================================================ głosy i ustawienia */
async function loadVoices() {
  try { S.voices = await player.voices(S.engine, S.lang); } catch { S.voices = []; }
  const saved = prefs.get(`voice.${S.engine}.${S.lang}`, "");
  S.voice = S.voices.some((v) => v.id === saved) ? saved : player.pickDefault(S.voices, S.lang, S.engine);
  renderSettings();
}
const locale = () => (S.lang === "pl" ? "pl-PL" : "en-US");

function renderSettings() {
  $("#engineSel").innerHTML = S.engines.map((e) => `<option value="${e}" ${e === S.engine ? "selected" : ""}>${ENGINE_LABEL[e]}</option>`).join("");
  $("#voiceSel").innerHTML = S.voices.length
    ? S.voices.map((v) => `<option value="${esc(v.id)}" ${v.id === S.voice ? "selected" : ""}>${esc(v.label)}</option>`).join("")
    : `<option value="">(brak głosów)</option>`;
  const hint = $("#voiceHint");
  if (S.engine === "edge") hint.textContent = "Głosy Edge są neuronowe i bardzo naturalne, ale wymagają internetu. Bez sieci Lektor sam przełączy się na głos telefonu.";
  else if (S.engine === "system") hint.textContent = S.voices.length
    ? "Głosy telefonu działają offline. Najlepsze są głosy Google (męskie: bmg / jmk po polsku, iom / tpd po angielsku)."
    : "Brak głosu w tym języku. Stuknij „Pobierz głosy offline (Google)” i pobierz polski oraz angielski (USA).";
  else if (S.engine === "elevenlabs") hint.textContent = S.voices.length ? "Głosy z Twojego konta ElevenLabs." : "Wpisz klucz API ElevenLabs w sekcji Zaawansowane.";
  else hint.textContent = "";
  $$("#langSeg button").forEach((b) => b.classList.toggle("on", b.dataset.lang === S.lang));
  $("#rate").value = S.rate;
  $("#rateOut").textContent = S.rate.toFixed(2) + "×";
  $("#rateBtn").textContent = +S.rate.toFixed(2) + "×";
  $("#fontSize").value = prefs.get("fontSize", 19);
  $("#follow").checked = S.follow;
  $("#themeSel").value = prefs.get("theme", "auto");
  $("#uocrUrl").value = prefs.get("uocrUrl", "");
  $("#elevenKey").value = localStorage.getItem("lektor.elevenKey") || "";
  $("#installVoicesBtn").hidden = !isNative;
  $("#ttsSettings").hidden = !isNative;
  renderGoogle();
}
function applyTheme(v) {
  if (v === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = v;
}

/* ================================================================ odtwarzanie */
function setPlayIcon() {
  $("#playBtn .play-ico").textContent = S.playing ? "⏸" : "▶";
  $("#playBtn").classList.toggle("loading", S.playing && S.buffering);
  $("#playBtn").setAttribute("aria-label", S.playing ? "Pauza" : "Czytaj");
}
function effectiveEngine() {
  if (S.engine === "edge" && navigator.onLine === false && S.engines.includes("system")) {
    toast("Brak internetu – czytam głosem telefonu", 3000);
    return "system";
  }
  return S.engine;
}
async function loadIntoPlayer(i, autoplay = true) {
  const engine = effectiveEngine();
  const items = S.doc.sentences.map((s, k) => ({ id: String(k), text: s.text }));
  S.loadedDoc = S.id; S.loadedEngine = engine;
  S.idx = i;
  if (autoplay) { S.playing = true; setPlayIcon(); highlight(); updatePos(); }
  try {
    await player.load({ items, index: i, engine, voice: engine === S.engine ? S.voice : "", locale: locale(), rate: S.rate, title: S.meta.title, autoplay });
  } catch (e) {
    S.playing = false; S.loadedDoc = null; setPlayIcon();
    toast("Nie udało się uruchomić czytania: " + esc(e.message || e), 6000);
  }
}
const needsLoad = () => S.loadedDoc !== S.id || S.loadedEngine !== effectiveEngine();
async function playFrom(i) {
  if (!S.doc) return;
  i = clamp(i, 0, S.doc.sentences.length - 1);
  S.userScrollAt = 0;
  if (needsLoad()) return loadIntoPlayer(i, true);
  S.idx = i; S.playing = true; setPlayIcon(); highlight(); updatePos();
  await player.seek(i);
  await player.play();
}
async function toggle() {
  if (!S.doc) return;
  if (S.playing) { await player.pause(); S.playing = false; setPlayIcon(); savePos(); return; }
  if (!needsLoad()) {
    const st = await player.getState().catch(() => null);
    if (st && st.index === S.idx) { S.playing = true; setPlayIcon(); await player.play(); return; }
  }
  playFrom(S.idx);
}
async function jumpTo(i, play = false) {
  if (!S.doc) return;
  i = clamp(i, 0, S.doc.sentences.length - 1);
  if (S.playing || play) return playFrom(i);
  S.idx = i; highlight(true); updatePos();
  if (!needsLoad()) player.seek(i).catch(() => {});
}
function setRate(r) {
  S.rate = Math.round(clamp(r, 0.5, 3) * 100) / 100;
  prefs.set("rate", S.rate);
  renderSettings();
  if (!needsLoad()) player.setRate(S.rate).catch(() => {});
}
async function onVoiceChanged() {
  prefs.set(`voice.${S.engine}.${S.lang}`, S.voice);
  if (needsLoad()) { if (S.playing) playFrom(S.idx); return; }
  const ok = await player.setVoice(S.engine, S.voice, locale()).catch(() => false);
  if (!ok && S.playing) playFrom(S.idx); else if (!ok) S.loadedDoc = null;
}
async function onEngineChanged(e) {
  S.engine = e;
  prefs.set("engine", e);
  await loadVoices();
  S.loadedEngine = null;
  if (S.playing) playFrom(S.idx);
}
function onPlayerEvent(e) {
  if (e.type === "state") {
    const docLoaded = S.loadedDoc === S.id && S.doc;
    S.playing = !!e.playing; S.buffering = !!e.buffering; S.sleepEndsAt = e.sleepEndsAt || 0;
    if (docLoaded && typeof e.index === "number" && e.index >= 0 && e.index !== S.idx) { S.idx = e.index; highlight(); updatePos(); }
    setPlayIcon();
    if (e.fallback) {
      S.engine = "system"; S.loadedEngine = "system";
      loadVoices();
      toast("Głosy Edge niedostępne (" + esc(e.message || "brak internetu") + ") – czytam głosem telefonu.", 6000);
    }
    if (e.sleep) toast("🌙 Timer snu: czytanie wstrzymane");
    if (e.finished && docLoaded) { toast("Koniec dokumentu"); savePos(); }
    if (!e.playing) savePos();
    return;
  }
  if (S.loadedDoc !== S.id || !S.doc) return;
  if (e.type === "start") {
    const i = typeof e.index === "number" ? e.index : +e.id;
    S.playing = true; S.buffering = false; setPlayIcon();
    if (i !== S.idx) { S.idx = i; highlight(); updatePos(); } else highlight();
  } else if (e.type === "range") {
    const i = typeof e.index === "number" ? e.index : +e.id;
    if (i === S.idx) drawWord(wordAt(i, e.start));
  } else if (e.type === "error") {
    S.playing = false; S.buffering = false; setPlayIcon();
    toast("Błąd czytania: " + esc(e.message || "nieznany") + '<br><small>Sprawdź głos w ⚙ ustawieniach.</small>', 7000);
  }
}
function wordAt(i, charPos) {
  let st = S.wordStarts.get(i);
  if (!st) {
    const s = S.doc.sentences[i];
    st = [];
    let c = 0;
    for (const w of s.words) { const k = s.text.indexOf(w[0], c); st.push(k < 0 ? c : k); if (k >= 0) c = k + w[0].length; }
    S.wordStarts.set(i, st);
  }
  let wi = 0;
  while (wi + 1 < st.length && st[wi + 1] <= charPos) wi++;
  return wi;
}

/* ================================================================ notatki */
async function loadNotes() {
  S.notes = (await db.notesOf(S.id)).sort((a, b) => a.created - b.created);
  renderNotes();
}
const groups = () => [...new Set(S.notes.map((n) => n.group))];
function renderNotes() {
  const list = $("#noteList");
  const url = S.meta?.gdocUrl || (S.meta?.gdocId ? gdocs.docUrl(S.meta.gdocId) : null);
  $("#gdocLink").hidden = !url;
  if (url) $("#gdocLink").href = url;
  $("#gdocNone").hidden = !!url || gdocs.isConfigured();
  $("#notesCount").hidden = !S.notes.length;
  $("#notesCount").textContent = S.notes.length;
  if (!S.notes.length) list.innerHTML = `<div class="empty-notes">Brak notatek.<br>Podczas słuchania stuknij „＋ Notatka”.</div>`;
  else {
    const by = new Map();
    for (const n of S.notes) (by.get(n.group) || by.set(n.group, []).get(n.group)).push(n);
    list.innerHTML = [...by].map(([g, ns]) => `<details class="group" open><summary>${esc(g)} <span class="n">${ns.length}</span></summary>
      ${ns.map((n) => `<div class="note" data-id="${n.id}">
        ${n.quote ? `<q data-s="${n.from ?? ""}">${esc(n.quote)}</q>` : ""}${n.thought ? `<p>${esc(n.thought)}</p>` : ""}
        <div class="meta">${n.page != null ? "s. " + (n.page + 1) : ""}<span>${n.synced ? "☁ Google Docs" : "● lokalnie"}</span><span class="spacer"></span>
        <button data-act="edit">edytuj</button><button data-act="del">usuń</button></div></div>`).join("")}</details>`).join("");
  }
  $("#groupList").innerHTML = groups().map((g) => `<option value="${esc(g)}">`).join("");
  const noted = new Set();
  for (const n of S.notes) if (n.from != null) for (let i = n.from; i <= (n.to ?? n.from); i++) noted.add(i);
  $$("#textView .s").forEach((el) => el.classList.toggle("noted", noted.has(+el.dataset.i)));
}
$("#noteList").addEventListener("click", async (e) => {
  const q = e.target.closest("q[data-s]");
  if (q && q.dataset.s !== "") { closeDrawers(); return jumpTo(+q.dataset.s); }
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const n = S.notes.find((x) => x.id === b.closest(".note").dataset.id);
  if (b.dataset.act === "del") {
    if (!confirm("Usunąć notatkę? (W Google Docs: ⋯ → Przebuduj dokument.)")) return;
    await db.del("notes", n.id);
    loadNotes();
  } else openComposer(n);
});

const C = { from: 0, to: 0, wasPlaying: false, editing: null };
function openComposer(editNote = null) {
  if (!S.doc) return toast("Najpierw otwórz dokument");
  C.editing = editNote;
  C.wasPlaying = S.playing;
  if (S.playing) { player.pause(); S.playing = false; setPlayIcon(); }
  if (editNote) {
    C.from = editNote.from ?? S.idx; C.to = editNote.to ?? C.from;
    $("#qText").textContent = editNote.quote || "";
    $("#thought").value = editNote.thought || "";
    $("#group").value = editNote.group || "";
    $("#composerTitle").textContent = "EDYCJA NOTATKI";
  } else {
    const sel = String(getSelection()).trim();
    C.from = C.to = S.idx;
    $("#qText").textContent = sel || S.doc.sentences[S.idx].text;
    $("#thought").value = "";
    $("#group").value = prefs.get("group." + S.id, "");
    $("#composerTitle").textContent = "CYTAT";
  }
  $("#resumeWrap").hidden = !C.wasPlaying;
  const cur = $("#group").value;
  $("#groupChips").innerHTML = groups().slice(-8).map((g) => `<button type="button" class="chip ${g === cur ? "on" : ""}">${esc(g)}</button>`).join("");
  $("#composer").showModal();
  if (!editNote) $("#thought").focus();
}
function extendQuote(d) {
  if (d < 0 && C.from > 0) C.from--;
  if (d > 0 && C.to < S.doc.sentences.length - 1) C.to++;
  $("#qText").textContent = S.doc.sentences.slice(C.from, C.to + 1).map((s) => s.text).join(" ");
}
async function saveNote() {
  const quote = $("#qText").textContent.trim(), thought = $("#thought").value.trim();
  const group = $("#group").value.trim() || "Bez grupy";
  stopDictation();
  if (!quote && !thought) return;
  prefs.set("group." + S.id, group);
  if (C.editing) {
    Object.assign(C.editing, { quote, thought, group, synced: false, edited: true });
    await db.put("notes", C.editing);
    await loadNotes();
    toast(gdocs.isConfigured() ? "Zmieniono. W Google Docs odświeżysz to przez ⋯ → Przebuduj dokument." : "Zmieniono.", 4500);
    if (C.wasPlaying && $("#resumeAfter").checked) resumeAfterNote();
    return;
  }
  const note = { id: uid(), doc: S.id, created: Date.now(), quote, thought, group,
    page: S.pdf ? S.doc.sentences[C.from].page : null, from: C.from, to: C.to, synced: false };
  await db.put("notes", note);
  await loadNotes();
  if (C.wasPlaying && $("#resumeAfter").checked) resumeAfterNote();
  pushNote(note);
}
function resumeAfterNote() {
  if (needsLoad()) playFrom(S.idx);
  else { S.playing = true; setPlayIcon(); player.play(); }
}
async function pushNote(note) {
  if (!gdocs.isConfigured()) {
    toast('Zapisano na telefonie. <button id="toastSetup">Włącz Google Docs</button>', 6000);
    $("#toastSetup").onclick = () => { $("#toast").hidden = true; openGdocsSetup(); };
    return;
  }
  try {
    await gdocs.appendNote(S.meta, note);
    await db.put("meta", S.meta);
    note.synced = true;
    await db.put("notes", note);
    toast(`Zapisano w Google Docs ✓`, 2000);
  } catch (e) {
    toast("Zapisano na telefonie. Google Docs: " + esc(e.message || e), 6000);
  }
  if (note.doc === S.id) loadNotes();
}
async function syncPending() {
  if (!gdocs.isConfigured()) return;
  const pending = (await db.all("notes")).filter((x) => !x.synced && !x.edited);
  for (const n of pending) {
    const m = await db.get("meta", n.doc);
    if (!m) continue;
    try {
      await gdocs.appendNote(m, n);
      await db.put("meta", m);
      if (S.meta?.id === m.id) Object.assign(S.meta, { gdocId: m.gdocId, gdocUrl: m.gdocUrl });
      n.synced = true;
      await db.put("notes", n);
    } catch { break; }
  }
  if (S.id) loadNotes();
}
function notesMarkdown(meta, notes) {
  const by = new Map();
  for (const n of notes) (by.get(n.group) || by.set(n.group, []).get(n.group)).push(n);
  let md = `# Notatki – ${meta?.title || ""}\n\n`;
  for (const [g, ns] of by) {
    md += `## ${g}\n\n`;
    for (const n of ns) { if (n.quote) md += `> „${n.quote}”${n.page != null ? ` — s. ${n.page + 1}` : ""}\n\n`; if (n.thought) md += n.thought + "\n\n"; }
  }
  return md;
}
async function shareNotes(meta) {
  const notes = meta.id === S.id ? S.notes : (await db.notesOf(meta.id)).sort((a, b) => a.created - b.created);
  if (!notes.length) return toast("Brak notatek do udostępnienia");
  try {
    const r = await share({ title: `Notatki – ${meta.title}`, text: notesMarkdown(meta, notes) });
    if (r?.clipboard) toast("Skopiowano do schowka ✓");
  } catch { /* anulowano */ }
}

/* dyktowanie */
let rec = null;
function toggleDictation() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return toast("Użyj mikrofonu na klawiaturze (przycisk 🎤).", 4000);
  if (rec) return stopDictation();
  rec = new SR();
  rec.lang = locale(); rec.continuous = true; rec.interimResults = true;
  const ta = $("#thought"), base = ta.value ? ta.value.replace(/\s*$/, " ") : "";
  let fin = "";
  rec.onresult = (ev) => {
    let tmp = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) ev.results[i].isFinal ? (fin += ev.results[i][0].transcript) : (tmp += ev.results[i][0].transcript);
    ta.value = base + fin + tmp;
  };
  rec.onerror = () => { stopDictation(); toast("Użyj mikrofonu na klawiaturze (przycisk 🎤).", 4000); };
  rec.onend = stopDictation;
  try { rec.start(); $("#dictate").classList.add("on"); } catch { rec = null; }
}
function stopDictation() { if (rec) { rec.onend = null; try { rec.stop(); } catch {} } rec = null; $("#dictate").classList.remove("on"); }

/* ================================================================ Google Docs */
function renderGoogle() {
  const box = $("#googleBox");
  const m = gdocs.mode();
  if (m === "script" && gdocs.isConfigured()) {
    box.innerHTML = `<div class="gstatus"><span class="dot ok"></span>Połączono (skrypt na Twoim koncie Google)
      <span class="spacer"></span><button type="button" class="chip" id="gTest">sprawdź</button><button type="button" class="chip" id="gOut">rozłącz</button></div>`;
  } else if (m === "oauth") {
    box.innerHTML = `<div class="gstatus"><span class="dot ok"></span>Zalogowano do Google (OAuth)<span class="spacer"></span><button type="button" class="chip" id="gOut">rozłącz</button></div>`;
  } else {
    box.innerHTML = `<div class="gstatus"><span class="dot"></span>Nieskonfigurowane<span class="spacer"></span>
      <button type="button" class="accent" id="gSetup">Skonfiguruj (2 min)</button></div>
      <p class="hint">Bez tego notatki zostają tylko na telefonie (możesz je udostępnić jako tekst).</p>`;
  }
  $("#gSetup")?.addEventListener("click", () => { $("#settings").close(); openGdocsSetup(); });
  $("#gOut")?.addEventListener("click", () => { gdocs.disconnect(); renderGoogle(); renderNotes(); });
  $("#gTest")?.addEventListener("click", async () => {
    toast("Sprawdzam…", 0);
    try { const r = await gdocs.ping(); toast(`Działa ✓ ${r.email ? "(" + esc(r.email) + ")" : ""}`); }
    catch (e) { toast("Błąd: " + esc(e.message || e), 7000); }
  });
}
function openGdocsSetup() {
  $("#gsUrl").value = prefs.get("scriptUrl", "");
  $("#gsStatus").textContent = gdocs.isConfigured() ? "Połączono ✓" : "";
  $("#gdocsSetup").showModal();
}
async function connectScript(raw) {
  const url = gdocs.parseScriptUrl(raw);
  if (!url) { toast("To nie wygląda na adres skryptu (powinien kończyć się na /exec).", 5000); return false; }
  const prevMode = gdocs.mode(), prevUrl = prefs.get("scriptUrl", "");
  gdocs.setScript(url);
  $("#gsStatus").textContent = "Sprawdzam…";
  toast("Sprawdzam połączenie…", 0);
  try {
    const r = await gdocs.ping();
    $("#gsStatus").textContent = "Połączono ✓";
    toast(`Połączono z Google Docs ✓${r.email ? " (" + esc(r.email) + ")" : ""}`, 4000);
    renderGoogle(); renderNotes();
    syncPending();
    return true;
  } catch (e) {
    prefs.set("gdocsMode", prevMode); prefs.set("scriptUrl", prevUrl);
    $("#gsStatus").textContent = "";
    toast("Nie udało się połączyć: " + esc(e.message || e) + "<br><small>Sprawdź, czy wdrożenie ma „Kto ma dostęp: Każdy”.</small>", 9000);
    return false;
  }
}
function onAppLink(l) {
  if (!l) return;
  const u = l.u || l.url?.match(/[?&]u=([^&]+)/)?.[1];
  if (l.host === "connect" && u) connectScript(decodeURIComponent(u));
}
async function scriptCode() {
  const r = await fetch("lektor-docs.txt");
  if (!r.ok) throw new Error("brak pliku skryptu");
  return r.text();
}

/* ================================================================ okna pomocnicze */
function ask(title, value = "") {
  return new Promise((res) => {
    const d = $("#askDlg");
    $("#askTitle").textContent = title;
    $("#askInput").value = value;
    const done = () => { d.removeEventListener("close", done); res(d.returnValue === "ok" ? $("#askInput").value.trim() : null); };
    d.addEventListener("close", done);
    d.showModal();
    $("#askInput").focus(); $("#askInput").select();
  });
}
function openDrawer(which) { closeDrawers(); $("#" + which).hidden = false; $("#scrim").hidden = false; }
function closeDrawers() { $("#library").hidden = $("#notes").hidden = $("#scrim").hidden = true; $("#gdocOptions").hidden = true; }

/* ================================================================ UI */
function bindUI() {
  bindPinch();
  $("#playBtn").onclick = toggle;
  $("#nextBtn").onclick = () => jumpTo(S.idx + 1);
  $("#prevBtn").onclick = () => jumpTo(S.idx - 1);
  $("#noteBtn").onclick = () => openComposer();
  $("#rateBtn").onclick = () => { const steps = [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.5, 1.75, 2]; setRate(steps.find((x) => x > S.rate + 0.01) || steps[0]); };
  $("#settingsBtn").onclick = () => { renderSettings(); $("#settings").showModal(); };
  $("#viewToggle").onclick = () => setView(S.view === "pages" ? "text" : "pages");
  $("#libOpen").onclick = () => openDrawer("library");
  $("#notesOpen").onclick = () => openDrawer("notes");
  $("#scrim").onclick = closeDrawers;
  $$(".drawer .close").forEach((b) => (b.onclick = closeDrawers));
  $$(".fileInput").forEach((inp) => (inp.onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) importFile(f); }));
  $$(".pasteBtn").forEach((b) => (b.onclick = () => { closeDrawers(); $("#pasteDlg").showModal(); }));
  $("#welcomeVoices").onclick = () => Lektor ? Lektor.installVoices() : toast("Na telefonie otworzy się pobieranie głosów Google.");
  $("#welcomeDocs").onclick = openGdocsSetup;
  $("#progress").onclick = (e) => {
    if (!S.doc) return;
    const r = e.currentTarget.getBoundingClientRect();
    jumpTo(Math.floor(((e.clientX - r.left) / r.width) * S.doc.sentences.length));
  };
  const vp = $("#viewport");
  ["touchmove", "wheel"].forEach((ev) => vp.addEventListener(ev, () => { if (!pinch) S.userScrollAt = Date.now(); }, { passive: true }));

  // ustawienia
  $("#engineSel").onchange = (e) => onEngineChanged(e.target.value);
  $("#voiceSel").onchange = (e) => { S.voice = e.target.value; onVoiceChanged(); };
  $$("#langSeg button").forEach((b) => (b.onclick = async () => {
    S.lang = b.dataset.lang;
    if (S.meta) { S.meta.lang = S.lang; db.put("meta", S.meta); }
    await loadVoices();
    onVoiceChanged();
  }));
  $("#testVoice").onclick = async () => {
    const t = S.lang === "pl" ? "Dzień dobry. Tak brzmi ten głos podczas czytania książki." : "Hello. This is how this voice sounds while reading a book.";
    S.loadedDoc = null; S.playing = false; setPlayIcon();
    try { await player.load({ items: [{ id: "test", text: t }], index: 0, engine: S.engine, voice: S.voice, locale: locale(), rate: S.rate, title: "Próbka głosu", autoplay: true }); }
    catch (e) { toast("Nie udało się odtworzyć próbki: " + esc(e.message || e), 5000); }
  };
  $("#installVoicesBtn").onclick = () => Lektor?.installVoices();
  $("#ttsSettings").onclick = () => Lektor?.openTtsSettings();
  $("#rate").oninput = (e) => setRate(+e.target.value);
  $("#sleepSel").onchange = (e) => { const m = +e.target.value; player.setSleepTimer(m); S.sleepEndsAt = m ? Date.now() + m * 60000 : 0; updatePos(); toast(m ? `🌙 Czytanie zatrzyma się za ${m} min` : "Timer snu wyłączony"); };
  $("#themeSel").onchange = (e) => { prefs.set("theme", e.target.value); applyTheme(e.target.value); };
  $("#fontSize").oninput = (e) => { prefs.set("fontSize", +e.target.value); document.documentElement.style.setProperty("--fs", e.target.value + "px"); };
  $("#follow").onchange = (e) => { S.follow = e.target.checked; prefs.set("follow", S.follow); };
  $("#uocrUrl").onchange = (e) => prefs.set("uocrUrl", e.target.value.trim());
  $("#elevenKey").onchange = async (e) => { localStorage.setItem("lektor.elevenKey", e.target.value.trim()); if (S.engine === "elevenlabs") await loadVoices(); };
  setInterval(() => { if (S.sleepEndsAt) updatePos(); }, 30000);

  // notatka
  $("#composerForm").onsubmit = (e) => { e.preventDefault(); $("#composer").close(); saveNote(); };
  $("#cancelNote").onclick = () => { stopDictation(); $("#composer").close(); if (C.wasPlaying) resumeAfterNote(); };
  $("#qPrev").onclick = () => extendQuote(-1);
  $("#qNext").onclick = () => extendQuote(1);
  $("#dictate").onclick = toggleDictation;
  $("#groupChips").onclick = (e) => {
    const c = e.target.closest(".chip"); if (!c) return;
    $("#group").value = c.textContent;
    $$("#groupChips .chip").forEach((x) => x.classList.toggle("on", x === c));
  };

  // Google Docs
  $("#gdocMenu").onclick = () => ($("#gdocOptions").hidden = !$("#gdocOptions").hidden);
  $("#rebuildBtn").onclick = async () => {
    if (!S.id) return;
    if (!gdocs.isConfigured()) return openGdocsSetup();
    toast("Przebudowuję dokument…", 0);
    try {
      await gdocs.rebuild(S.meta, S.notes);
      await db.put("meta", S.meta);
      for (const n of S.notes) { n.synced = true; n.edited = false; await db.put("notes", n); }
      toast(`Gotowe ✓ <a href="${S.meta.gdocUrl}" target="_blank">otwórz</a>`, 5000); loadNotes();
    } catch (e) { toast("Błąd: " + esc(e.message || e), 7000); }
  };
  $("#linkBtn").onclick = async () => {
    if (!S.id) return;
    const raw = await ask("Wklej link do dokumentu Google Docs", "");
    if (!raw) return;
    try { await gdocs.link(S.meta, raw); await db.put("meta", S.meta); renderNotes(); toast("Podłączono ✓"); }
    catch (e) { toast("Błąd: " + esc(e.message || e), 6000); }
  };
  $("#shareNotesBtn").onclick = () => S.meta && shareNotes(S.meta);
  $("#gsCopy").onclick = async () => {
    try { await navigator.clipboard.writeText(await scriptCode()); toast("Skopiowano kod skryptu ✓ Wklej go w edytorze Apps Script.", 4000); }
    catch { toast("Nie udało się skopiować – użyj „Wyślij sobie instrukcję”.", 5000); }
  };
  $("#gsShare").onclick = async () => {
    const code = await scriptCode();
    const text = `Lektor → Google Docs: instrukcja\n\n1. Otwórz https://script.google.com/home/projects/create\n2. Usuń przykładowy kod i wklej cały kod poniżej, zapisz.\n3. Wdróż → Nowe wdrożenie → Aplikacja internetowa (Wykonaj jako: Ja; Kto ma dostęp: Każdy) → Wdróż → zezwól na dostęp.\n4. Otwórz „Adres URL aplikacji internetowej” na telefonie i stuknij „Otwórz w Lektorze”.\n\n===== KOD SKRYPTU =====\n\n${code}`;
    try { await share({ title: "Lektor – instrukcja Google Docs", text }); } catch { /* anulowano */ }
  };
  $("#gsOpen").onclick = () => openExternal("https://script.google.com/home/projects/create");
  $("#gsConnect").onclick = async () => { if (await connectScript($("#gsUrl").value)) $("#gdocsSetup").close(); };
  $("#gsClose").onclick = () => $("#gdocsSetup").close();
  $("#gsOauth").onclick = async () => {
    try { await gdocs.connectOAuth(); toast("Zalogowano do Google ✓"); renderGoogle(); renderNotes(); $("#gdocsSetup").close(); syncPending(); }
    catch (e) { toast("Logowanie nieudane: " + esc(e.message || e) + "<br><small>Wymaga klucza OAuth w Google Cloud (zob. README).</small>", 9000); }
  };

  // menu dokumentu
  $("#dmOpen").onclick = () => { $("#docMenu").close(); closeDrawers(); openDoc(menuMeta.id); };
  $("#dmRename").onclick = () => { $("#docMenu").close(); renameDoc(menuMeta); };
  $("#dmShare").onclick = () => { $("#docMenu").close(); shareNotes(menuMeta); };
  $("#dmDelete").onclick = () => { $("#docMenu").close(); deleteDoc(menuMeta); };

  // wklejanie tekstu
  $("#pasteDlg").addEventListener("close", () => {
    if ($("#pasteDlg").returnValue !== "ok") return;
    const text = $("#pasteText").value.trim();
    if (text) importData("Tekst", text, true, $("#pasteTitle").value.trim() || text.slice(0, 40));
    $("#pasteText").value = $("#pasteTitle").value = "";
  });

  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea, select, [contenteditable=true]") || $$("dialog[open]").length) return;
    if (e.key === " ") { e.preventDefault(); toggle(); }
    else if (e.key === "ArrowRight") jumpTo(S.idx + 1);
    else if (e.key === "ArrowLeft") jumpTo(S.idx - 1);
    else if (e.key.toLowerCase() === "n") { e.preventDefault(); openComposer(); }
  });
  document.addEventListener("visibilitychange", () => {
    savePos();
    if (!document.hidden) syncPlayerState();
  });
}

init().catch((e) => {
  console.error(e);
  if (!window.__lektorReady) window.__lektorFatal?.("Błąd startu: " + (e.stack || e.message || e));
  else toast("Błąd startu: " + esc(e.message || e), 10000);
});
