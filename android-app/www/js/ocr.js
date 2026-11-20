// OCR stron skanowanych:
//  1. Unlimited-OCR 2 (baidu/Unlimited-OCR) – jeśli w ustawieniach podano adres serwera (wymaga GPU NVIDIA, działa poza telefonem)
//  2. ML Kit Text Recognition – na telefonie, offline, z ramkami słów
import { http, mlkitOcr, isNative } from "./native.js";
import { pagePng } from "./pdfdoc.js";
import { prefs } from "./db.js";

const BLOCK_RE = /<BLOCK>([a-z_]+)(?:<LEVEL\d>)?\s*(?:\[([\d.,\s]+)\])?\s*<FORK>([\s\S]*?)(?=<BLOCK>|<PAGE>|$)/g;
const SKIP = new Set(["image", "figure", "chart", "seal", "table", "cross_table", "append_table"]);

export function parseUocr(raw) {
  const blocks = [];
  for (const m of raw.matchAll(BLOCK_RE)) {
    if (SKIP.has(m[1])) continue;
    const text = m[3].replace(/<[^>]+>/g, " ").replace(/[#*_`]+/g, " ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    let box = null;
    if (m[2]) { const n = m[2].split(",").map(Number); if (n.length === 4 && n.every(isFinite)) box = n.map((v) => v / 1000); }
    blocks.push({ text, box });
  }
  if (!blocks.length && raw.trim()) {
    for (const p of raw.replace(/<[^>]+>/g, " ").split(/\n\s*\n/)) { const t = p.replace(/\s+/g, " ").trim(); if (t) blocks.push({ text: t, box: null }); }
  }
  return blocks;
}

async function unlimitedOcr(url, b64) {
  const r = await http({
    url: url.replace(/\/$/, "") + "/v1/chat/completions", method: "POST",
    headers: { "Content-Type": "application/json" },
    data: {
      model: prefs.get("uocrModel", "Unlimited-OCR-2"),
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64," + b64 } },
                                          { type: "text", text: "<PAGE><image>Multi page parsing." }] }],
      max_tokens: 8000, temperature: 0, skip_special_tokens: false, images_config: { crop_mode: true }, stream: false,
    },
  });
  return r.choices[0].message.content || "";
}

/** Funkcja przekazywana do pdfdoc.extract(). */
export async function ocrPage(page, pno, pw) {
  const img = await pagePng(page);
  const uurl = prefs.get("uocrUrl", "");
  if (uurl) {
    try {
      const words = [];
      for (const b of parseUocr(await unlimitedOcr(uurl, img.b64))) {
        const box = b.box ? [b.box[0] * pw.w, b.box[1] * pw.h, b.box[2] * pw.w, b.box[3] * pw.h] : null;
        b.text.split(/\s+/).forEach((t, k) => words.push({ t, page: pno, box, brk: k === 0 }));
      }
      return { words, engine: "unlimited-ocr" };
    } catch (e) {
      console.warn("Unlimited-OCR niedostępny, używam ML Kit", e);
    }
  }
  if (!isNative) throw new Error("brak OCR");
  const r = await mlkitOcr(img.b64);
  const k = 1 / img.scale; // piksele -> punkty PDF
  const words = [];
  for (const b of r.blocks) {
    let first = true;
    for (const line of b.lines) for (const w of line.words) {
      words.push({ t: w.text, page: pno, box: w.box.map((v) => v * k), brk: first });
      first = false;
    }
  }
  return { words, engine: "ML Kit" };
}
