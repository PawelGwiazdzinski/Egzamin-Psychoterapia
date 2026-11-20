"""Podział tekstu na zdania (PL + EN) z zachowaniem pozycji słów na stronie."""
from __future__ import annotations

import re

# Skróty, po których kropka NIE kończy zdania (małe litery, bez kropki końcowej).
ABBREVIATIONS = {
    # polskie
    "np", "tzw", "tj", "itd", "itp", "m.in", "dr", "prof", "mgr", "inż", "hab",
    "r", "w", "s", "str", "tab", "rys", "ryc", "nr", "ok", "wg", "ww", "jw",
    "pt", "zob", "por", "cyt", "red", "wyd", "tłum", "oprac", "przyp", "godz",
    "min", "tys", "mln", "mld", "zł", "gr", "ul", "al", "pl", "św", "im", "tzn",
    "b", "ust", "art", "pkt", "poz", "lek", "med", "kol", "ds", "jr", "sp", "tel",
    "n.p.m", "p.n.e", "n.e", "ang", "łac", "gr", "niem", "franc", "wyd", "t",
    # angielskie
    "e.g", "i.e", "etc", "vs", "cf", "al", "mr", "mrs", "ms", "dr", "st", "jr",
    "sr", "fig", "figs", "eq", "eqs", "vol", "no", "pp", "p", "ch", "sec", "ed",
    "eds", "approx", "inc", "ltd", "co", "corp", "dept", "univ", "u.s", "u.k",
    "a.m", "p.m", "ph.d", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep",
    "sept", "oct", "nov", "dec",
}

END_PUNCT = re.compile(r"[.!?…]+[\"'”’»)\]]*$")
OPENING = re.compile(r"^[\"'“„«(\[]*")


def _is_sentence_end(word: str, next_word: str | None) -> bool:
    if not END_PUNCT.search(word):
        return False
    core = word.rstrip("\"'”’»)]")
    if core.endswith(("!", "?", "…", "...")):
        return True
    # kropka – sprawdzamy skróty, inicjały, liczby porządkowe
    stem = OPENING.sub("", core[:-1]).lower()
    if stem in ABBREVIATIONS:
        return False
    if len(stem) == 1 and stem.isalpha():  # inicjał: "J. Kowalski"
        return False
    if next_word is None:
        return True
    nxt = OPENING.sub("", next_word)
    if not nxt:
        return True
    first = nxt[0]
    if stem.isdigit() and (first.islower() or first.isdigit()):
        return False  # "5. rozdział", "z 12. roku"
    return first.isupper() or first.isdigit() or not first.isalpha()


def join_hyphenated(prev: str, nxt: str) -> str | None:
    """Łączy wyraz przeniesiony między liniami ("psycho-" + "terapia")."""
    if prev.endswith(("-", "­")) and len(prev) > 2 and nxt[:1].islower():
        return prev.rstrip("-­") + nxt
    return None


def build_sentences(words: list[dict]) -> list[dict]:
    """words: [{t, page, box:[x0,y0,x1,y1] | None, brk: bool}] -> zdania.

    `brk` = True oznacza, że słowo zaczyna nowy blok (akapit / nagłówek),
    więc poprzednie zdanie trzeba zamknąć.
    Zwraca: [{text, page, words:[{t, page, box}]}]
    """
    sentences: list[dict] = []
    cur: list[dict] = []
    cur_par = True

    def flush():
        nonlocal cur, cur_par
        if not cur:
            return
        parts: list[str] = []
        for w in cur:
            parts.append(w["t"])
        text = " ".join(parts)
        text = re.sub(r"\s+([,.;:!?…%)\]])", r"\1", text)
        text = re.sub(r"([(\[„])\s+", r"\1", text)
        if re.search(r"\w", text):
            sentences.append({"text": text.strip(), "page": cur[0]["page"], "words": cur, "par": cur_par})
        cur = []
        cur_par = False

    i = 0
    n = len(words)
    while i < n:
        w = dict(words[i])
        if w.get("brk"):
            flush()
            cur_par = True
        # łączenie przeniesień
        if i + 1 < n and not words[i + 1].get("brk"):
            joined = join_hyphenated(w["t"], words[i + 1]["t"])
            if joined:
                nxt = words[i + 1]
                w = {"t": joined, "page": w["page"], "box": w.get("box"),
                     "box2": nxt.get("box"), "page2": nxt["page"]}
                i += 1
        cur.append({k: v for k, v in w.items() if k != "brk"})
        nxt_word = words[i + 1]["t"] if i + 1 < n else None
        nxt_brk = words[i + 1].get("brk") if i + 1 < n else True
        if _is_sentence_end(w["t"], None if nxt_brk else nxt_word):
            flush()
        elif len(cur) > 80 and w["t"].endswith((";", ":")):
            flush()  # bardzo długie "zdania" (np. listy) – dzielimy na średnikach
        i += 1
    flush()
    return sentences


LANG_PL = set("ąćęłńóśźż")
PL_WORDS = {"i", "w", "z", "na", "się", "nie", "jest", "że", "do", "to", "jak", "oraz", "przez", "dla", "od", "jego", "jej"}
EN_WORDS = {"the", "and", "of", "to", "in", "is", "that", "for", "it", "with", "as", "was", "are", "this", "by"}


def detect_lang(text: str) -> str:
    sample = text[:20000].lower()
    diacritics = sum(1 for c in sample if c in LANG_PL)
    tokens = re.findall(r"[a-ząćęłńóśźż]+", sample)
    pl = sum(1 for t in tokens if t in PL_WORDS) + diacritics * 0.5
    en = sum(1 for t in tokens if t in EN_WORDS)
    return "pl" if pl >= en else "en"
