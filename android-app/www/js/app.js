// Lektor (Android) – logika aplikacji
import { db, uid, prefs } from "./db.js";
import { openPdf, extract, renderPage } from "./pdfdoc.js";
import { fromPlainText, detectLang } from "./textproc.js";
import { ocrPage } from "./ocr.js";
import { ENGINES, ENGINE_LABEL, availableEngines, onSpeech, pickDefault, setRate as engineRate } from "./speech.js";
import * as gdocs from "./gdocs.js";
import { Lektor, isNative } from "./native.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let toastT;
function toast(html, ms = 3000) {
  const t = $("#toast");
  t.innerHTML = html;
  t.hidden = false;
  clearTimeout(toastT);
  if (ms) toastT = setTimeout(() => (t.hidden = true), ms);
}

const BATCH = 25;
const S = {
  id: null, meta: null, doc: null, pdf: null, notes: [],
  view: prefs.get("view", "pages"),
  idx: 0, playing: false, queuedTo: -1, session: 0,
  engines: [], engine: prefs.get("engine", null),
  lang: "pl", voices: [], voice: "",
  rate: prefs.get("rate", 1),
  follow: prefs.get("follow", true),
  userScrollAt: 0, wordStarts: new Map(),
};

/* ================================================================ start */
async function init() {
  document.documentElement.style.setProperty("--fs", prefs.get("fontSize", 19) + "px");
  bindUI();
  S.engines = await availableEngines();
  if (!S.engines.includes(S.engine)) S.engine = S.engines[0];
  onSpeech(onSpeechEvent);
  await renderLibrary();
  const last = prefs.get("lastDoc", null);
  if (last && (await db.get("meta", last))) await openDoc(last);
  else openDrawer("library");
  if (Lektor) {
    Lektor.addListener("sharedFile", (f) => importShared(f));
    Lektor.addListener("media", (e) => (e.action === "pause" ? pause() : e.action === "play" ? toggle() : null));
    window.Capacitor.Plugins.App?.addListener("backButton", onBack);
  }
}

function onBack() {
  const open = $$("dialog[open]");
  if (open.length) return open.at(-1).close();
  if (!$("#library").hidden || !$("#notes").hidden) return closeDrawers();
  window.Capacitor.Plugins.App.minimizeApp();
}

/* ================================================================ biblioteka */
async function renderLibrary() {
  const metas = (await db.all("meta")).sort((a, b) => (b.opened || b.created) - (a.opened || a.created));
  const ul = $("#docList");
  if (!metas.length) { ul.innerHTML = `<li class="muted small">Biblioteka jest pusta.</li>`; return; }
  ul.innerHTML = metas.map((m) => {
    const pct = m.sentences ? Math.round((100 * (m.position || 0)) / m.sentences) : 0;
    return `<li data-id="${m.id}" class="${m.id === S.id ? "on" : ""}"><div class="t"><b>${esc(m.title)}</b>
      <span>${(m.lang || "").toUpperCase()} · ${m.pages ? m.pages + " str." : "tekst"} · ${pct}%</span><div class="bar"><i style="width:${pct}%"></i></div></div>
      <button class="icon-btn del" aria-label="Usuń">✕</button></li>`;
  }).join("");
}

$("#docList").addEventListener("click", async (e) => {
  const li = e.target.closest("li[data-id]");
  if (!li) return;
  if (e.target.closest(".del")) {
    const m = await db.get("meta", li.dataset.id);
    if (!confirm(`Usunąć „${m.title}” i jego lokalne notatki? (Dokument w Google Docs zostaje.)`)) return;
    if (S.id === m.id) { stopAll(); S.id = null; S.doc = null; showEmpty(); }
    await db.removeDoc(m.id);
    return renderLibrary();
  }
  closeDrawers();
  openDoc(li.dataset.id);
});

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
  if (f.error) return toast("Nie udało się otworzyć pliku: " + esc(f.error), 6000);
  if (f.text) return importData(f.name || "Udostępniony tekst", f.text, true);
  if (f.data) return importData(f.name || "dokument.pdf", b64ToBytes(f.data), false);
}

async function importData(name, data, isText, title) {
  closeDrawers();
  stopAll();
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
    if (!doc.sentences.length) throw new Error("Nie znaleziono tekstu (skan bez OCR?)");
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
  $("#empty").hidden = false; $("#pages").hidden = true; $("#textView").hidden = true;
  $("#docTitle").textContent = "Lektor";
}

async function openDoc(id) {
  stopAll();
  const meta = await db.get("meta", id);
  const doc = await db.get("docs", id);
  if (!meta || !doc) return showEmpty();
  S.pdf?.destroy();
  S.pdf = null;
  if (meta.kind === "pdf") S.pdf = await openPdf(new Uint8Array(await db.get("files", id)));
  S.id = id; S.meta = meta; S.doc = doc;
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
  renderLibrary();
}

/* ================================================================ widok stron */
let pageObs, renderObs;
function buildPages() {
  const box = $("#pages");
  box.innerHTML = "";
  pageObs?.disconnect();
  if (!S.pdf) return;
  pageObs = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const div = e.target;
      if (e.isIntersecting && !div.dataset.rendered) {
        div.dataset.rendered = "1";
        const c = div.querySelector("canvas");
        renderPage(S.pdf, +div.dataset.p, c, div.clientWidth).catch(() => { div.dataset.rendered = ""; });
      }
    }
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
let lastWidth = innerWidth;
addEventListener("resize", () => {
  if (Math.abs(innerWidth - lastWidth) < 40 || !S.pdf) return; // klawiatura nie zmienia szerokości
  lastWidth = innerWidth;
  $$(".page").forEach((d) => (d.dataset.rendered = ""));
  buildPages();
  highlight(true);
});

$("#pages").addEventListener("click", (e) => {
  const div = e.target.closest(".page");
  if (!div) return;
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
  const span = $(`#textView .s.cur`);
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
  let y = null;
  if (S.view === "pages" && hit) y = hit.div.offsetTop + (hit.b[1] / S.doc.pages[hit.p].h) * hit.div.offsetHeight;
  else if (S.view === "text" && tEl) y = tEl.offsetTop;
  if (y == null) return;
  const top = vp.scrollTop, h = vp.clientHeight;
  if (force || y < top + h * 0.1 || y > top + h * 0.7) vp.scrollTo({ top: y - h * 0.3, behavior: force ? "auto" : "smooth" });
}

function setView(v, silent) {
  S.view = v;
  if (!silent && S.pdf) prefs.set("view", v);
  $("#pages").hidden = v !== "pages";
  $("#textView").hidden = v !== "text";
  $("#viewToggle").textContent = v === "pages" ? "¶" : "▤";
  highlight(true);
}

function updatePos() {
  if (!S.doc) return;
  const n = S.doc.sentences.length, s = S.doc.sentences[S.idx];
  $("#posLabel").textContent = S.pdf ? `s. ${s.page + 1}/${S.doc.pages.length}` : `${Math.round((100 * (S.idx + 1)) / n)}%`;
  $("#progressFill").style.width = `${(100 * (S.idx + 1)) / n}%`;
  if (updatePos.t) return; // zapis co najwyżej raz na 1,5 s
  updatePos.t = setTimeout(async () => {
    updatePos.t = null;
    if (!S.meta) return;
    S.meta.position = S.idx;
    await db.put("meta", S.meta);
  }, 1500);
}

/* ================================================================ głosy */
async function loadVoices() {
  try { S.voices = await ENGINES[S.engine].voices(S.lang); } catch { S.voices = []; }
  const saved = prefs.get(`voice.${S.engine}.${S.lang}`, "");
  S.voice = S.voices.some((v) => v.id === saved) ? saved : pickDefault(S.voices, S.lang);
  renderSettings();
}

function renderSettings() {
  $("#engineSel").innerHTML = S.engines.map((e) => `<option value="${e}" ${e === S.engine ? "selected" : ""}>${ENGINE_LABEL[e]}</option>`).join("");
  $("#voiceSel").innerHTML = S.voices.length
    ? S.voices.map((v) => `<option value="${esc(v.id)}" ${v.id === S.voice ? "selected" : ""}>${esc(v.label)}</option>`).join("")
    : `<option value="">${S.engine === "elevenlabs" ? "(wpisz klucz API)" : "(brak głosów – pobierz w ustawieniach telefonu)"}</option>`;
  $$("#langSeg button").forEach((b) => b.classList.toggle("on", b.dataset.lang === S.lang));
  $("#rate").value = S.rate;
  $("#rateOut").textContent = S.rate.toFixed(2) + "×";
  $("#rateBtn").textContent = +S.rate.toFixed(2) + "×";
  $("#fontSize").value = prefs.get("fontSize", 19);
  $("#follow").checked = S.follow;
  $("#uocrUrl").value = prefs.get("uocrUrl", "");
  $("#elevenKey").value = localStorage.getItem("lektor.elevenKey") || "";
  $("#ttsSettings").hidden = !isNative;
  renderGoogle();
}

/* ================================================================ odtwarzanie */
const engine = () => ENGINES[S.engine];
const opts = () => ({ voice: S.voice, lang: S.lang, rate: S.rate, title: S.meta?.title || "" });
const items = (from, to) => S.doc.sentences.slice(from, to + 1).map((s, k) => ({ id: String(from + k), text: s.text }));

function setPlayIcon(loading = false) {
  $("#playBtn").textContent = S.playing ? "⏸" : "▶";
  $("#playBtn").classList.toggle("loading", loading);
}

async function playFrom(i) {
  if (!S.doc) return;
  S.idx = Math.max(0, Math.min(i, S.doc.sentences.length - 1));
  S.playing = true;
  S.session++;
  S.userScrollAt = 0;
  S.queuedTo = Math.min(S.doc.sentences.length - 1, S.idx + BATCH - 1);
  setPlayIcon(true);
  highlight();
  updatePos();
  try { await engine().play(items(S.idx, S.queuedTo), opts()); }
  catch (e) { pause(); toast("Błąd mowy: " + esc(e.message || e), 6000); }
}

function onSpeechEvent(e) {
  if (!S.playing || !S.doc) return;
  const i = +e.id;
  if (e.type === "start") {
    setPlayIcon(false);
    if (i !== S.idx) { S.idx = i; highlight(); updatePos(); }
  } else if (e.type === "range") {
    if (i !== S.idx) { S.idx = i; highlight(); updatePos(); }
    drawWord(wordAt(i, e.start));
  } else if (e.type === "done") {
    if (i >= S.doc.sentences.length - 1) { pause(); toast("Koniec dokumentu"); return; }
    if (i >= S.queuedTo - 8 && S.queuedTo < S.doc.sentences.length - 1) {
      const from = S.queuedTo + 1;
      S.queuedTo = Math.min(S.doc.sentences.length - 1, from + BATCH - 1);
      engine().enqueue(items(from, S.queuedTo), opts());
    }
  } else if (e.type === "error") {
    pause();
    toast("Błąd mowy: " + esc(e.message || "nieznany") + "<br><small>Sprawdź głosy w ⚙ ustawieniach.</small>", 7000);
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

function pause() {
  S.playing = false;
  S.session++;
  try { engine()?.stop(); } catch {}
  setPlayIcon(false);
}
const stopAll = () => { if (S.playing) pause(); };
function toggle() { if (!S.doc) return; S.playing ? pause() : playFrom(S.idx); }
function jumpTo(i, play = false) {
  if (!S.doc) return;
  if (S.playing || play) return playFrom(i);
  S.idx = Math.max(0, Math.min(i, S.doc.sentences.length - 1));
  highlight(true);
  updatePos();
}

function setRate(r) {
  S.rate = Math.round(Math.min(3, Math.max(0.5, r)) * 100) / 100;
  prefs.set("rate", S.rate);
  renderSettings();
  engineRate(S.engine, S.rate);
  if (S.playing && S.engine !== "elevenlabs") { clearTimeout(setRate.t); setRate.t = setTimeout(() => playFrom(S.idx), 350); }
}

/* ================================================================ notatki */
async function loadNotes() {
  S.notes = (await db.notesOf(S.id)).sort((a, b) => a.created - b.created);
  renderNotes();
}
const groups = () => [...new Set(S.notes.map((n) => n.group))];

function renderNotes() {
  const list = $("#noteList");
  const gd = S.meta?.gdocId;
  $("#gdocLink").hidden = !gd;
  if (gd) $("#gdocLink").href = gdocs.docUrl(gd);
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
  for (const n of S.notes) if (n.from != null) for (let i = n.from; i <= n.to; i++) noted.add(i);
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
  } else {
    const thought = prompt("Twoja myśl:", n.thought); if (thought === null) return;
    const group = prompt("Grupa:", n.group); if (group === null) return;
    Object.assign(n, { thought: thought.trim(), group: group.trim() || "Bez grupy", synced: false });
    await db.put("notes", n);
    toast("Zmieniono. Aby odświeżyć Google Docs: ⋯ → Przebuduj.", 4000);
  }
  loadNotes();
});

const C = { from: 0, to: 0, wasPlaying: false };
function openComposer() {
  if (!S.doc) return toast("Najpierw otwórz dokument");
  C.wasPlaying = S.playing;
  pause();
  const sel = String(getSelection()).trim();
  C.from = C.to = S.idx;
  $("#qText").textContent = sel || S.doc.sentences[S.idx].text;
  $("#thought").value = "";
  const lg = prefs.get("group." + S.id, "");
  $("#group").value = lg;
  $("#groupChips").innerHTML = groups().slice(-8).map((g) => `<button type="button" class="chip ${g === lg ? "on" : ""}">${esc(g)}</button>`).join("");
  $("#composer").showModal();
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
  const note = { id: uid(), doc: S.id, created: Date.now(), quote, thought, group,
    page: S.pdf ? S.doc.sentences[C.from].page : null, from: C.from, to: C.to, synced: false };
  await db.put("notes", note);
  await loadNotes();
  if (C.wasPlaying && $("#resumeAfter").checked) playFrom(S.idx);
  pushNote(note);
}

async function ensureGdoc() {
  if (!S.meta.gdocId) { S.meta.gdocId = await gdocs.createDoc(S.meta.title); await db.put("meta", S.meta); }
  return S.meta.gdocId;
}
async function pushNote(note) {
  if (!prefs.get("google", false)) { toast("Zapisano lokalnie. Połącz Google Docs w ⚙ ustawieniach."); return; }
  try {
    await gdocs.appendNote(await ensureGdoc(), note);
    note.synced = true;
    await db.put("notes", note);
    toast(`Zapisano w Google Docs ✓`, 2000);
  } catch (e) {
    toast("Zapisano lokalnie. Google Docs: " + esc(e.message || e), 6000);
  }
  if (note.doc === S.id) loadNotes();
}

/* dyktowanie (Chrome/WebView z rozpoznawaniem mowy Google) */
let rec = null;
function toggleDictation() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return toast("Użyj mikrofonu na klawiaturze (Gboard / Samsung) – przycisk 🎤.", 4000);
  if (rec) return stopDictation();
  rec = new SR();
  rec.lang = S.lang === "en" ? "en-US" : "pl-PL";
  rec.continuous = true; rec.interimResults = true;
  const ta = $("#thought"), base = ta.value ? ta.value.replace(/\s*$/, " ") : "";
  let fin = "";
  rec.onresult = (ev) => {
    let tmp = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) ev.results[i].isFinal ? (fin += ev.results[i][0].transcript) : (tmp += ev.results[i][0].transcript);
    ta.value = base + fin + tmp;
  };
  rec.onerror = () => { stopDictation(); toast("Użyj mikrofonu na klawiaturze – przycisk 🎤.", 4000); };
  rec.onend = stopDictation;
  rec.start();
  $("#dictate").classList.add("on");
}
function stopDictation() { if (rec) { rec.onend = null; try { rec.stop(); } catch {} } rec = null; $("#dictate").classList.remove("on"); }

/* ================================================================ Google */
function renderGoogle() {
  const on = prefs.get("google", false);
  $("#googleBox").innerHTML = on
    ? `<div class="gstatus"><span class="dot ok"></span>Połączono z Google Docs<span class="spacer"></span><button type="button" class="chip" id="gOut">rozłącz</button></div>`
    : `<button type="button" class="accent" id="gIn">Połącz z Google Docs</button>
       <p class="hint">Notatki trafią do dokumentu „Notatki – &lt;tytuł&gt;” na Twoim Dysku Google.</p>`;
  $("#gIn")?.addEventListener("click", async () => {
    try { await gdocs.connect(); prefs.set("google", true); toast("Połączono z Google ✓"); renderGoogle(); syncPending(); }
    catch (e) { toast("Logowanie Google nieudane: " + esc(e.message || e), 8000); }
  });
  $("#gOut")?.addEventListener("click", () => { prefs.set("google", false); gdocs.disconnect(); renderGoogle(); });
}
async function syncPending() {
  for (const n of (await db.all("notes")).filter((x) => !x.synced)) {
    const m = await db.get("meta", n.doc);
    if (!m) continue;
    try {
      if (!m.gdocId) { m.gdocId = await gdocs.createDoc(m.title); await db.put("meta", m); if (S.meta?.id === m.id) S.meta.gdocId = m.gdocId; }
      await gdocs.appendNote(m.gdocId, n);
      n.synced = true;
      await db.put("notes", n);
    } catch { break; }
  }
  if (S.id) loadNotes();
}

/* ================================================================ UI */
function openDrawer(which) {
  closeDrawers();
  $("#" + which).hidden = false;
  $("#scrim").hidden = false;
}
function closeDrawers() { $("#library").hidden = $("#notes").hidden = $("#scrim").hidden = true; $("#gdocOptions").hidden = true; }

function bindUI() {
  $("#playBtn").onclick = toggle;
  $("#nextBtn").onclick = () => jumpTo(S.idx + 1);
  $("#prevBtn").onclick = () => jumpTo(S.idx - 1);
  $("#noteBtn").onclick = openComposer;
  $("#rateBtn").onclick = () => { const steps = [0.8, 1, 1.2, 1.4, 1.6, 1.8, 2, 2.5]; setRate(steps.find((x) => x > S.rate + 0.01) || steps[0]); };
  $("#settingsBtn").onclick = () => { renderSettings(); $("#settings").showModal(); };
  $("#viewToggle").onclick = () => setView(S.view === "pages" ? "text" : "pages");
  $("#libOpen").onclick = () => openDrawer("library");
  $("#notesOpen").onclick = () => openDrawer("notes");
  $("#scrim").onclick = closeDrawers;
  $$(".drawer .close").forEach((b) => (b.onclick = closeDrawers));
  $$(".fileInput").forEach((inp) => (inp.onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) importFile(f); }));
  $("#progress").onclick = (e) => {
    if (!S.doc) return;
    const r = e.currentTarget.getBoundingClientRect();
    jumpTo(Math.floor(((e.clientX - r.left) / r.width) * S.doc.sentences.length));
  };
  const vp = $("#viewport");
  ["touchmove", "wheel"].forEach((ev) => vp.addEventListener(ev, () => (S.userScrollAt = Date.now()), { passive: true }));

  // ustawienia
  $("#engineSel").onchange = async (e) => { pause(); S.engine = e.target.value; prefs.set("engine", S.engine); await loadVoices(); };
  $("#voiceSel").onchange = (e) => { S.voice = e.target.value; prefs.set(`voice.${S.engine}.${S.lang}`, S.voice); if (S.playing) playFrom(S.idx); };
  $$("#langSeg button").forEach((b) => (b.onclick = async () => {
    S.lang = b.dataset.lang;
    if (S.meta) { S.meta.lang = S.lang; db.put("meta", S.meta); }
    await loadVoices();
    if (S.playing) playFrom(S.idx);
  }));
  $("#testVoice").onclick = () => {
    const t = S.lang === "pl" ? "Dzień dobry. Tak brzmi ten głos podczas czytania." : "Hello. This is how this voice sounds while reading.";
    pause();
    engine().play([{ id: "-1", text: t }], opts());
  };
  $("#rate").oninput = (e) => setRate(+e.target.value);
  $("#fontSize").oninput = (e) => { prefs.set("fontSize", +e.target.value); document.documentElement.style.setProperty("--fs", e.target.value + "px"); };
  $("#follow").onchange = (e) => { S.follow = e.target.checked; prefs.set("follow", S.follow); };
  $("#ttsSettings").onclick = () => Lektor?.openTtsSettings();
  $("#uocrUrl").onchange = (e) => prefs.set("uocrUrl", e.target.value.trim());
  $("#elevenKey").onchange = async (e) => { localStorage.setItem("lektor.elevenKey", e.target.value.trim()); if (S.engine === "elevenlabs") await loadVoices(); };

  // notatka
  $("#composerForm").onsubmit = (e) => { e.preventDefault(); $("#composer").close(); saveNote(); };
  $("#cancelNote").onclick = () => { stopDictation(); $("#composer").close(); if (C.wasPlaying) playFrom(S.idx); };
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
    if (!prefs.get("google", false)) return toast("Najpierw połącz Google Docs w ⚙ ustawieniach.");
    toast("Przebudowuję dokument…", 0);
    try {
      await gdocs.rebuild(await ensureGdoc(), S.meta.title, S.notes);
      for (const n of S.notes) { n.synced = true; await db.put("notes", n); }
      toast("Gotowe ✓"); loadNotes();
    } catch (e) { toast("Błąd: " + esc(e.message || e), 7000); }
  };
  $("#linkBtn").onclick = async () => {
    const raw = prompt("Wklej link do dokumentu Google Docs. Nowe notatki będą dopisywane pod nagłówkami grup:");
    const id = raw && gdocs.parseDocLink(raw);
    if (!id) return raw && toast("To nie jest link do Google Docs");
    S.meta.gdocId = id; await db.put("meta", S.meta); renderNotes(); toast("Podłączono ✓");
  };
  $("#mdExport").onclick = async () => {
    const by = new Map();
    for (const n of S.notes) (by.get(n.group) || by.set(n.group, []).get(n.group)).push(n);
    let md = `# Notatki – ${S.meta?.title || ""}\n\n`;
    for (const [g, ns] of by) { md += `## ${g}\n\n`; for (const n of ns) { if (n.quote) md += `> „${n.quote}”${n.page != null ? ` — s. ${n.page + 1}` : ""}\n\n`; if (n.thought) md += n.thought + "\n\n"; } }
    try { await navigator.clipboard.writeText(md); toast("Skopiowano do schowka ✓"); } catch { prompt("Skopiuj:", md); }
  };

  // wklejanie tekstu
  $("#pasteBtn").onclick = () => $("#pasteDlg").showModal();
  $("#pasteDlg").addEventListener("close", () => {
    if ($("#pasteDlg").returnValue !== "ok") return;
    const text = $("#pasteText").value.trim();
    if (text) importData("Tekst", text, true, $("#pasteTitle").value.trim() || text.slice(0, 40));
    $("#pasteText").value = $("#pasteTitle").value = "";
  });

  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea, select, [contenteditable=true]")) return;
    if (e.key === " ") { e.preventDefault(); toggle(); }
    else if (e.key === "ArrowRight") jumpTo(S.idx + 1);
    else if (e.key === "ArrowLeft") jumpTo(S.idx - 1);
    else if (e.key.toLowerCase() === "n") { e.preventDefault(); openComposer(); }
  });
}

document.addEventListener("visibilitychange", () => {
  if (S.meta) { S.meta.position = S.idx; db.put("meta", S.meta); }
  // w tle WebView może zostać uśpiony – dokładamy do kolejki telefonu dużo zdań naraz
  if (document.hidden && S.playing && S.engine === "android" && S.queuedTo < S.doc.sentences.length - 1) {
    const from = S.queuedTo + 1;
    S.queuedTo = Math.min(S.doc.sentences.length - 1, from + 400);
    engine().enqueue(items(from, S.queuedTo), opts());
  }
});

init().catch((e) => toast("Błąd startu: " + esc(e.message || e), 10000));
