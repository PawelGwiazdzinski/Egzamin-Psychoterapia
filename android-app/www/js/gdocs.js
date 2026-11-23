// Notatki w Google Docs. Dwie drogi:
//  * "script"  – skrypt Google Apps Script na koncie użytkownika (polecane: bez konsoli Google Cloud, bez SHA-1),
//  * "oauth"   – bezpośrednio Google Docs API z tokenem OAuth (zaawansowane).
import { googleToken, http } from "./native.js";
import { prefs } from "./db.js";

const API = "https://docs.googleapis.com/v1/documents";
let token = null;

export const docUrl = (id) => `https://docs.google.com/document/d/${id}/edit`;
export function parseDocLink(raw) {
  const m = String(raw || "").match(/\/d\/([A-Za-z0-9_-]{20,})/) || String(raw || "").trim().match(/^([A-Za-z0-9_-]{20,})$/);
  return m ? m[1] : null;
}
export function parseScriptUrl(raw) {
  const m = String(raw || "").match(/https:\/\/script\.google\.com\/(?:a\/[^/]+\/)?macros\/s\/[A-Za-z0-9_-]+\/exec/);
  return m ? m[0] : null;
}

export const mode = () => prefs.get("gdocsMode", null); // 'script' | 'oauth' | null
export const isConfigured = () => mode() === "script" ? !!prefs.get("scriptUrl", "") : mode() === "oauth";

export function setScript(url) {
  prefs.set("scriptUrl", url);
  prefs.set("gdocsMode", "script");
}
export function disconnect() {
  prefs.set("gdocsMode", null);
  prefs.set("scriptUrl", "");
  token = null;
}
export async function connectOAuth() {
  token = await googleToken(true);
  prefs.set("gdocsMode", "oauth");
  return true;
}

/* ------------------------------------------------------------------ Apps Script */
async function script(action, payload = {}) {
  const url = prefs.get("scriptUrl", "");
  if (!url) throw new Error("Nie skonfigurowano Google Docs");
  const r = await http({ url, method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
    data: JSON.stringify({ action, ...payload }), responseType: "json", timeout: 90000 });
  if (!r || typeof r !== "object") throw new Error("Skrypt odpowiedział niezrozumiale. Sprawdź, czy wdrożenie ma dostęp „Każdy”.");
  if (r.error) throw new Error(r.error);
  return r;
}

/* ------------------------------------------------------------------ OAuth (REST) */
async function call(method, url, data, retry = true) {
  if (!token) token = await googleToken(true);
  try {
    return await http({ url, method, data, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
  } catch (e) {
    if (retry && /HTTP 401/.test(e.message)) { token = await googleToken(true); return call(method, url, data, false); }
    throw e;
  }
}
const batch = (id, requests) => call("POST", `${API}/${id}:batchUpdate`, { requests });
const u16 = (s) => s.length;

async function oauthCreateDoc(title) {
  const d = await call("POST", API, { title: `Notatki – ${title}` });
  const text = `Notatki – ${title}\n`;
  await batch(d.documentId, [
    { insertText: { location: { index: 1 }, text } },
    { updateParagraphStyle: { range: { startIndex: 1, endIndex: 1 + u16(text) }, paragraphStyle: { namedStyleType: "TITLE" }, fields: "namedStyleType" } },
  ]);
  return d.documentId;
}
function paragraphs(doc) {
  const out = [];
  for (const el of doc.body?.content || []) {
    if (!el.paragraph) continue;
    const text = (el.paragraph.elements || []).map((r) => r.textRun?.content || "").join("");
    out.push({ start: el.startIndex, end: el.endIndex, text: text.replace(/\n$/, ""), style: el.paragraph.paragraphStyle?.namedStyleType || "NORMAL_TEXT" });
  }
  return out;
}
function noteLines(n) {
  const lines = [];
  if (n.quote) lines.push([`„${n.quote.trim()}”${n.page != null ? ` — s. ${n.page + 1}` : ""}`, "quote"]);
  if (n.thought) n.thought.trim().split("\n").filter((p) => p.trim()).forEach((p, i) => lines.push([(i ? "   " : "→ ") + p.trim(), "thought"]));
  lines.push(["", "spacer"]);
  return lines;
}
const grey = (v) => ({ color: { rgbColor: { red: v, green: v, blue: v } } });
function styleRequests(start, lines) {
  const reqs = [];
  let idx = start;
  for (const [text, kind] of lines) {
    const end = idx + u16(text) + 1;
    const range = { startIndex: idx, endIndex: end };
    if (kind === "heading" || kind === "title") {
      reqs.push({ updateParagraphStyle: { range, paragraphStyle: { namedStyleType: kind === "title" ? "TITLE" : "HEADING_2" }, fields: "namedStyleType" } });
      idx = end; continue;
    }
    const ps = { namedStyleType: "NORMAL_TEXT", indentStart: { magnitude: 0, unit: "PT" }, indentFirstLine: { magnitude: 0, unit: "PT" } };
    let fields = "namedStyleType,indentStart,indentFirstLine";
    if (kind === "quote") {
      ps.indentStart = ps.indentFirstLine = { magnitude: 18, unit: "PT" };
      ps.borderLeft = { color: grey(0.7), width: { magnitude: 2, unit: "PT" }, padding: { magnitude: 6, unit: "PT" }, dashStyle: "SOLID" };
      fields += ",borderLeft";
    }
    reqs.push({ updateParagraphStyle: { range, paragraphStyle: ps, fields } });
    if (text) reqs.push({ updateTextStyle: { range: { startIndex: idx, endIndex: end - 1 },
      textStyle: { italic: kind === "quote", foregroundColor: kind === "quote" ? grey(0.3) : grey(0) }, fields: "italic,foregroundColor" } });
    idx = end;
  }
  return reqs;
}
async function oauthAppend(docId, note) {
  const doc = await call("GET", `${API}/${docId}`);
  const paras = paragraphs(doc);
  const group = (note.group || "Bez grupy").trim();
  let lines = noteLines(note);
  const hi = paras.findIndex((p) => p.style === "HEADING_2" && p.text.trim() === group);
  let insertAt = null;
  if (hi < 0) lines = [[group, "heading"], ...lines];
  else { const nxt = paras.slice(hi + 1).find((p) => ["HEADING_1", "HEADING_2", "TITLE"].includes(p.style)); insertAt = nxt ? nxt.start : null; }
  let start, reqs;
  if (insertAt == null) {
    const last = paras[paras.length - 1];
    if (last.text === "") { start = last.start; reqs = [{ insertText: { location: { index: start }, text: lines.map((l) => l[0]).join("\n") } }]; }
    else { start = last.end; reqs = [{ insertText: { location: { index: last.end - 1 }, text: "\n" + lines.map((l) => l[0]).join("\n") } }]; }
  } else { start = insertAt; reqs = [{ insertText: { location: { index: start }, text: lines.map((l) => l[0] + "\n").join("") } }]; }
  await batch(docId, [...reqs, ...styleRequests(start, lines)]);
}
async function oauthRebuild(docId, title, notes) {
  const doc = await call("GET", `${API}/${docId}`);
  const end = doc.body.content[doc.body.content.length - 1].endIndex;
  const reqs = [];
  if (end > 2) reqs.push({ deleteContentRange: { range: { startIndex: 1, endIndex: end - 1 } } });
  const lines = [[`Notatki – ${title}`, "title"]];
  const groups = new Map();
  for (const n of notes) { const g = (n.group || "Bez grupy").trim(); (groups.get(g) || groups.set(g, []).get(g)).push(n); }
  for (const [g, ns] of groups) { lines.push([g, "heading"]); for (const n of ns) lines.push(...noteLines(n)); }
  reqs.push({ insertText: { location: { index: 1 }, text: lines.map((l) => l[0] + "\n").join("") } });
  await batch(docId, [...reqs, ...styleRequests(1, lines)]);
}

/* ------------------------------------------------------------------ wspólne API dla app.js
   meta = {id, title, gdocId?, gdocUrl?}; funkcje zwracają {url} i mogą zaktualizować meta.gdocId / gdocUrl. */
export async function ping() {
  if (mode() === "script") return script("ping");
  if (mode() === "oauth") { token = await googleToken(true); return { ok: true }; }
  throw new Error("Nie skonfigurowano Google Docs");
}

export async function appendNote(meta, note) {
  if (mode() === "script") {
    const r = await script("append", { docKey: meta.id, title: meta.title, note });
    meta.gdocUrl = r.url; meta.gdocId = r.docId || meta.gdocId;
    return r;
  }
  if (mode() === "oauth") {
    if (!meta.gdocId) meta.gdocId = await oauthCreateDoc(meta.title);
    await oauthAppend(meta.gdocId, note);
    meta.gdocUrl = docUrl(meta.gdocId);
    return { url: meta.gdocUrl };
  }
  throw new Error("Nie skonfigurowano Google Docs");
}

export async function rebuild(meta, notes) {
  if (mode() === "script") {
    const r = await script("rebuild", { docKey: meta.id, title: meta.title, notes });
    meta.gdocUrl = r.url; meta.gdocId = r.docId || meta.gdocId;
    return r;
  }
  if (mode() === "oauth") {
    if (!meta.gdocId) meta.gdocId = await oauthCreateDoc(meta.title);
    await oauthRebuild(meta.gdocId, meta.title, notes);
    meta.gdocUrl = docUrl(meta.gdocId);
    return { url: meta.gdocUrl };
  }
  throw new Error("Nie skonfigurowano Google Docs");
}

export async function link(meta, raw) {
  const id = parseDocLink(raw);
  if (!id) throw new Error("To nie jest link do dokumentu Google Docs");
  if (mode() === "script") {
    const r = await script("link", { docKey: meta.id, docId: id });
    meta.gdocUrl = r.url; meta.gdocId = id;
    return r;
  }
  meta.gdocId = id; meta.gdocUrl = docUrl(id);
  return { url: meta.gdocUrl };
}
