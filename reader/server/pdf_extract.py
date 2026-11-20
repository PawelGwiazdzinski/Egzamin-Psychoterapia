"""Ekstrakcja tekstu z PDF (warstwa tekstowa + OCR dla skanów) do modelu zdań."""
from __future__ import annotations

import re
from collections import Counter
from typing import Callable

import pymupdf

from . import ocr
from .textproc import build_sentences, detect_lang

MARGIN = 0.07  # górne/dolne 7% strony – strefa nagłówków i stopek


def _norm(s: str) -> str:
    return re.sub(r"\d+", "#", s.strip().lower())


def _page_words(page) -> list[tuple]:
    return page.get_text("words", sort=False)  # kolejność strumienia – lepsza dla układu kolumnowego


def extract(path: str, progress: Callable[[str], None] = lambda m: None, skip_headers: bool = True) -> dict:
    doc = pymupdf.open(path)
    pages_meta = []
    raw_pages: list[list[tuple]] = []
    margin_counter: Counter = Counter()

    for page in doc:
        words = _page_words(page)
        raw_pages.append(words)
        pages_meta.append({"w": page.rect.width, "h": page.rect.height, "source": "text"})
        H = page.rect.height
        blocks: dict[int, list[str]] = {}
        for x0, y0, x1, y1, t, b, *_ in words:
            if y1 < H * MARGIN or y0 > H * (1 - MARGIN):
                blocks.setdefault(b, []).append(t)
        for txt in {_norm(" ".join(v)) for v in blocks.values()}:
            margin_counter[txt] += 1

    n_pages = len(doc)
    repeated = {k for k, c in margin_counter.items() if n_pages >= 3 and c >= max(2, n_pages * 0.4)}

    all_words: list[dict] = []
    for pno, page in enumerate(doc):
        progress(f"Strona {pno + 1}/{n_pages}")
        words = raw_pages[pno]
        text_len = sum(len(w[4]) for w in words)
        if text_len < 30 and page.get_images():
            png = page.get_pixmap(dpi=200).tobytes("png")
            progress(f"OCR strony {pno + 1}/{n_pages}…")
            ocr_words, engine = ocr.ocr_page_words(page, png)
            pages_meta[pno]["source"] = engine
            all_words.extend(ocr_words)
            continue
        H = page.rect.height
        skip_blocks = set()
        if skip_headers and repeated:
            groups: dict[int, list[tuple]] = {}
            for w in words:
                groups.setdefault(w[5], []).append(w)
            for b, ws in groups.items():
                in_margin = all(w[3] < H * MARGIN or w[1] > H * (1 - MARGIN) for w in ws)
                if in_margin and _norm(" ".join(w[4] for w in ws)) in repeated:
                    skip_blocks.add(b)
        last_block = None
        for x0, y0, x1, y1, t, b, _l, _w in words:
            if b in skip_blocks:
                continue
            all_words.append({"t": t, "page": pno, "box": [round(x0, 1), round(y0, 1), round(x1, 1), round(y1, 1)],
                              "brk": b != last_block})
            last_block = b

    sentences = build_sentences(all_words)
    full_text = " ".join(s["text"] for s in sentences)
    title = (doc.metadata or {}).get("title") or ""
    doc.close()
    return {
        "title": title,
        "lang": detect_lang(full_text),
        "pages": pages_meta,
        "sentences": [_compact(s) for s in sentences],
    }


def _compact(s: dict) -> dict:
    """Zmniejsza JSON: słowa jako [tekst, strona, x0, y0, x1, y1] (+ druga część przeniesienia)."""
    ws = []
    for w in s["words"]:
        item = [w["t"], w["page"], *(w.get("box") or [None] * 4)]
        if w.get("box2"):
            item += [w["page2"], *w["box2"]]
        ws.append(item)
    out = {"text": s["text"], "page": s["page"], "words": ws}
    if s.get("par"):
        out["par"] = 1
    return out


def from_plain_text(text: str, title: str = "Tekst") -> dict:
    words = []
    for para in re.split(r"\n\s*\n", text):
        for k, t in enumerate(para.split()):
            words.append({"t": t, "page": 0, "box": None, "brk": k == 0})
    sentences = build_sentences(words)
    return {"title": title, "lang": detect_lang(text), "pages": [], "sentences": [_compact(s) for s in sentences]}


def render_page(path: str, pno: int, zoom: float = 2.0) -> bytes:
    doc = pymupdf.open(path)
    try:
        pix = doc[pno].get_pixmap(matrix=pymupdf.Matrix(zoom, zoom))
        return pix.tobytes("png")
    finally:
        doc.close()
