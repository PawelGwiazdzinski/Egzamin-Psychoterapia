// Wczytywanie PDF (pdf.js): słowa z pozycjami, pomijanie nagłówków/stopek, OCR skanów, renderowanie stron.
import * as pdfjsLib from "../vendor/pdf.min.mjs";
import { buildSentences, detectLang } from "./textproc.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdf.worker.min.mjs", import.meta.url).href;
const OPTS = {
  cMapUrl: new URL("../vendor/cmaps/", import.meta.url).href,
  cMapPacked: true,
  standardFontDataUrl: new URL("../vendor/standard_fonts/", import.meta.url).href,
  wasmUrl: new URL("../vendor/wasm/", import.meta.url).href,
  iccUrl: new URL("../vendor/iccs/", import.meta.url).href,
};
const MARGIN = 0.07;

export async function openPdf(bytes) {
  return pdfjsLib.getDocument({ data: bytes, ...OPTS }).promise;
}

const norm = (s) => s.trim().toLowerCase().replace(/\d+/g, "#");

/** Słowa jednej strony: [{t, page, box, brk}] w punktach PDF, początek w lewym górnym rogu. */
async function pageWords(page, pno) {
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const words = [];
  let prev = null; // {y, h, x1}
  let block = 0;
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) { continue; }
    const tx = pdfjsLib.Util.transform(vp.transform, it.transform);
    const h = Math.hypot(tx[2], tx[3]) || 10;
    const x = tx[4], base = tx[5];
    const top = base - h * 0.85, bottom = base + h * 0.2;
    const width = it.width * vp.scale;
    let brk = false;
    if (!prev) brk = true;
    else {
      const newLine = Math.abs(base - prev.y) > h * 0.5;
      if (newLine) {
        const gap = base - prev.y;
        if (gap > Math.max(h, prev.h) * 1.75 || gap < -h || Math.abs(h - prev.h) > prev.h * 0.25) brk = true;
      }
    }
    if (brk) block++;
    // dzielimy element na słowa proporcjonalnie do liczby znaków
    const str = it.str;
    const cw = width / Math.max(1, str.length);
    const re = /\S+/g;
    let m, first = true;
    while ((m = re.exec(str))) {
      const x0 = x + m.index * cw, x1 = x + (m.index + m[0].length) * cw;
      // kontynuacja słowa rozbitego na kilka elementów (bez spacji)
      const last = words[words.length - 1];
      if (first && m.index === 0 && last && !brk && prev && !prev.sp && last.block === block && Math.abs(last.box[3] - bottom) < h * 0.3
          && x0 - last.box[2] < h * 0.12 && x0 >= last.box[2] - 1) {
        last.t += m[0];
        last.box[2] = x1;
      } else {
        words.push({ t: m[0], page: pno, box: [x0, top, x1, bottom], brk: brk && first, block });
      }
      first = false;
    }
    prev = { y: base, h, sp: /\s$/.test(str) || it.hasEOL };
  }
  return { words, w: vp.width, h: vp.height };
}

/**
 * Zwraca {title, lang, pages:[{w,h,source}], sentences}.
 * ocr(page, pno, pdfPage) -> Promise<{words, engine}> wywoływane dla stron bez tekstu.
 */
export async function extract(pdf, { progress = () => {}, ocr = null } = {}) {
  const n = pdf.numPages;
  const raw = [];
  const counter = new Map();
  for (let p = 1; p <= n; p++) {
    progress(`Czytam stronę ${p}/${n}`);
    const page = await pdf.getPage(p);
    const pw = await pageWords(page, p - 1);
    raw.push(pw);
    const groups = new Map();
    for (const w of pw.words) {
      if (w.box[3] < pw.h * MARGIN || w.box[1] > pw.h * (1 - MARGIN)) (groups.get(w.block) || groups.set(w.block, []).get(w.block)).push(w.t);
    }
    for (const t of new Set([...groups.values()].map((v) => norm(v.join(" "))))) counter.set(t, (counter.get(t) || 0) + 1);
    page.cleanup();
  }
  const repeated = new Set([...counter].filter(([, c]) => n >= 3 && c >= Math.max(2, n * 0.4)).map(([k]) => k));

  const pages = [];
  const all = [];
  for (let i = 0; i < n; i++) {
    const pw = raw[i];
    pages.push({ w: pw.w, h: pw.h, source: "text" });
    const textLen = pw.words.reduce((a, w) => a + w.t.length, 0);
    if (textLen < 30 && ocr) {
      progress(`OCR strony ${i + 1}/${n}…`);
      try {
        const page = await pdf.getPage(i + 1);
        const r = await ocr(page, i, pw);
        pages[i].source = r.engine;
        all.push(...r.words);
        continue;
      } catch (e) {
        console.warn("OCR", e);
        pages[i].source = "ocr-błąd";
      }
    }
    // pomijanie nagłówków/stopek i samotnych numerów stron
    const blocks = new Map();
    for (const w of pw.words) (blocks.get(w.block) || blocks.set(w.block, []).get(w.block)).push(w);
    const skip = new Set();
    for (const [b, ws] of blocks) {
      const inMargin = ws.every((w) => w.box[3] < pw.h * MARGIN || w.box[1] > pw.h * (1 - MARGIN));
      if (!inMargin) continue;
      const txt = ws.map((w) => w.t).join(" ");
      if (repeated.has(norm(txt)) || /^[\divxlc.\-–— ]{1,9}$/i.test(txt.trim())) skip.add(b);
    }
    for (const w of pw.words) {
      if (skip.has(w.block)) continue;
      all.push({ t: w.t, page: w.page, box: w.box.map((v) => Math.round(v * 10) / 10), brk: w.brk });
    }
  }
  const sentences = buildSentences(all);
  let title = "";
  try { title = (await pdf.getMetadata())?.info?.Title || ""; } catch {}
  return { title, lang: detectLang(sentences.slice(0, 400).map((s) => s.text).join(" ")), pages, sentences };
}

/** Renderuje stronę do canvasa w szerokości cssWidth. */
export async function renderPage(pdf, pno, canvas, cssWidth) {
  const page = await pdf.getPage(pno + 1);
  const base = page.getViewport({ scale: 1 });
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const scale = (cssWidth / base.width) * dpr;
  const vp = page.getViewport({ scale });
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp, canvas }).promise;
  page.cleanup();
}

/** Strona jako PNG (base64, bez prefiksu) do OCR. */
export async function pagePng(page, dpi = 220) {
  const vp = page.getViewport({ scale: dpi / 72 });
  const c = document.createElement("canvas");
  c.width = Math.floor(vp.width);
  c.height = Math.floor(vp.height);
  await page.render({ canvasContext: c.getContext("2d"), viewport: vp, canvas: c }).promise;
  const url = c.toDataURL("image/png");
  return { b64: url.slice(url.indexOf(",") + 1), scale: dpi / 72, width: c.width, height: c.height };
}
