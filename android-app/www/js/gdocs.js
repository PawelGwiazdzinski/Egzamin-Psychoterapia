// Notatki w Google Docs: jeden dokument na czytaną pozycję, grupy = nagłówki 2. stopnia.
import { googleToken, http } from "./native.js";

const API = "https://docs.googleapis.com/v1/documents";
let token = null;

async function call(method, url, data, retry = true) {
  if (!token) token = await googleToken(true);
  try {
    return await http({ url, method, data, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
  } catch (e) {
    if (retry && /HTTP 401/.test(e.message)) { token = await googleToken(true); return call(method, url, data, false); }
    throw e;
  }
}

export async function connect() { token = await googleToken(true); return true; }
export function disconnect() { token = null; }
export const docUrl = (id) => `https://docs.google.com/document/d/${id}/edit`;

const u16 = (s) => s.length; // JS liczy w UTF-16 – tak jak Google Docs

export async function createDoc(title) {
  const d = await call("POST", API, { title: `Notatki – ${title}` });
  const text = `Notatki – ${title}\n`;
  await batch(d.documentId, [
    { insertText: { location: { index: 1 }, text } },
    { updateParagraphStyle: { range: { startIndex: 1, endIndex: 1 + u16(text) }, paragraphStyle: { namedStyleType: "TITLE" }, fields: "namedStyleType" } },
  ]);
  return d.documentId;
}

const batch = (id, requests) => call("POST", `${API}/${id}:batchUpdate`, { requests });

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
      idx = end;
      continue;
    }
    const ps = { namedStyleType: "NORMAL_TEXT", indentStart: { magnitude: 0, unit: "PT" }, indentFirstLine: { magnitude: 0, unit: "PT" } };
    let fields = "namedStyleType,indentStart,indentFirstLine";
    if (kind === "quote") {
      ps.indentStart = ps.indentFirstLine = { magnitude: 18, unit: "PT" };
      ps.borderLeft = { color: grey(0.7), width: { magnitude: 2, unit: "PT" }, padding: { magnitude: 6, unit: "PT" }, dashStyle: "SOLID" };
      fields += ",borderLeft";
    }
    reqs.push({ updateParagraphStyle: { range, paragraphStyle: ps, fields } });
    if (text) {
      reqs.push({ updateTextStyle: { range: { startIndex: idx, endIndex: end - 1 },
        textStyle: { italic: kind === "quote", foregroundColor: kind === "quote" ? grey(0.3) : grey(0) }, fields: "italic,foregroundColor" } });
    }
    idx = end;
  }
  return reqs;
}

/** Dopisuje notatkę na końcu sekcji jej grupy. */
export async function appendNote(docId, note) {
  const doc = await call("GET", `${API}/${docId}`);
  const paras = paragraphs(doc);
  const group = (note.group || "Bez grupy").trim();
  let lines = noteLines(note);
  const hi = paras.findIndex((p) => p.style === "HEADING_2" && p.text.trim() === group);
  let insertAt = null;
  if (hi < 0) lines = [[group, "heading"], ...lines];
  else {
    const nxt = paras.slice(hi + 1).find((p) => ["HEADING_1", "HEADING_2", "TITLE"].includes(p.style));
    insertAt = nxt ? nxt.start : null;
  }
  let start, reqs;
  if (insertAt == null) {
    const last = paras[paras.length - 1];
    if (last.text === "") { start = last.start; reqs = [{ insertText: { location: { index: start }, text: lines.map((l) => l[0]).join("\n") } }]; }
    else { start = last.end; reqs = [{ insertText: { location: { index: last.end - 1 }, text: "\n" + lines.map((l) => l[0]).join("\n") } }]; }
  } else {
    start = insertAt;
    reqs = [{ insertText: { location: { index: start }, text: lines.map((l) => l[0] + "\n").join("") } }];
  }
  await batch(docId, [...reqs, ...styleRequests(start, lines)]);
}

/** Odtwarza cały dokument z notatek. */
export async function rebuild(docId, title, notes) {
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

export function parseDocLink(raw) {
  const m = raw.match(/\/d\/([A-Za-z0-9_-]{20,})/) || raw.trim().match(/^([A-Za-z0-9_-]{20,})$/);
  return m ? m[1] : null;
}
