// Podział tekstu na zdania (PL + EN) z zachowaniem pozycji słów.

const ABBR = new Set(`np tzw tj itd itp m.in dr prof mgr inż hab r w s str tab rys ryc nr ok wg ww jw pt zob por cyt red
wyd tłum oprac przyp godz min tys mln mld zł gr ul al pl św im tzn b ust art pkt poz lek med kol ds jr sp tel n.p.m p.n.e
n.e ang łac niem franc t e.g i.e etc vs cf mr mrs ms st sr fig figs eq eqs vol no pp p ch sec ed eds approx inc ltd co
corp dept univ u.s u.k a.m p.m ph.d jan feb mar apr jun jul aug sep sept oct nov dec`.split(/\s+/));

const END = /[.!?…]+["'”’»)\]]*$/;
const OPEN = /^["'“„«(\[]*/;
const TRAIL = /["'”’»)\]]+$/;

function isEnd(word, next) {
  if (!END.test(word)) return false;
  const core = word.replace(TRAIL, "");
  if (/[!?…]$/.test(core) || core.endsWith("...")) return true;
  const stem = core.slice(0, -1).replace(OPEN, "").toLowerCase();
  if (ABBR.has(stem)) return false;
  if (stem.length === 1 && /\p{L}/u.test(stem)) return false; // inicjał
  if (next == null) return true;
  const nx = next.replace(OPEN, "");
  if (!nx) return true;
  const f = nx[0];
  const isUpper = f !== f.toLowerCase();
  const isLower = f !== f.toUpperCase();
  const isDigit = /\d/.test(f);
  if (/^\d+$/.test(stem) && (isLower || isDigit)) return false;
  return isUpper || isDigit || !/\p{L}/u.test(f);
}

function joinHyphen(prev, next) {
  if (/[-­]$/.test(prev) && prev.length > 2 && /^\p{Ll}/u.test(next)) return prev.replace(/[-­]+$/, "") + next;
  return null;
}

/**
 * words: [{t, page, box:[x0,y0,x1,y1]|null, brk}]
 * -> [{text, page, par, words:[[t, page, x0,y0,x1,y1, (page2,x0,y0,x1,y1)]]}]
 */
export function buildSentences(words) {
  const out = [];
  let cur = [];
  let par = true;
  const flush = () => {
    if (!cur.length) return;
    let text = cur.map((w) => w.t).join(" ");
    text = text.replace(/\s+([,.;:!?…%)\]])/g, "$1").replace(/([(\[„])\s+/g, "$1").trim();
    if (/[\p{L}\p{N}]/u.test(text)) {
      const ws = cur.map((w) => {
        const a = [w.t, w.page, ...(w.box || [null, null, null, null])];
        if (w.box2) a.push(w.page2, ...w.box2);
        return a;
      });
      const s = { text, page: cur[0].page, words: ws };
      if (par) s.par = 1;
      out.push(s);
    }
    cur = [];
    par = false;
  };
  for (let i = 0; i < words.length; i++) {
    let w = { ...words[i] };
    if (w.brk) { flush(); par = true; }
    if (i + 1 < words.length && !words[i + 1].brk) {
      const j = joinHyphen(w.t, words[i + 1].t);
      if (j) {
        const n = words[i + 1];
        w = { t: j, page: w.page, box: w.box, box2: n.box, page2: n.page };
        i++;
      }
    }
    cur.push(w);
    const nxt = i + 1 < words.length ? words[i + 1] : null;
    if (isEnd(w.t, nxt && !nxt.brk ? nxt.t : null)) flush();
    else if (cur.length > 80 && /[;:]$/.test(w.t)) flush();
  }
  flush();
  return out;
}

const PL_W = new Set("i w z na się nie jest że do to jak oraz przez dla od jego jej".split(" "));
const EN_W = new Set("the and of to in is that for it with as was are this by".split(" "));
export function detectLang(text) {
  const s = text.slice(0, 20000).toLowerCase();
  const dia = (s.match(/[ąćęłńóśźż]/g) || []).length;
  const toks = s.match(/[a-ząćęłńóśźż]+/g) || [];
  let pl = dia * 0.5, en = 0;
  for (const t of toks) { if (PL_W.has(t)) pl++; if (EN_W.has(t)) en++; }
  return pl >= en ? "pl" : "en";
}

export function fromPlainText(text) {
  const words = [];
  for (const para of text.split(/\n\s*\n/)) {
    para.split(/\s+/).filter(Boolean).forEach((t, k) => words.push({ t, page: 0, box: null, brk: k === 0 }));
  }
  return buildSentences(words);
}
