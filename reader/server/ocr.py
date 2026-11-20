"""OCR stron skanowanych.

1. Unlimited-OCR 2 (baidu/Unlimited-OCR) – serwer SGLang z API zgodnym z OpenAI.
   Najlepsza jakość, wymaga GPU NVIDIA (można go uruchomić na innej maszynie / w chmurze
   i podać adres w ustawieniach: UOCR_URL).
2. Zapasowo: Tesseract przez PyMuPDF (jeśli zainstalowany, `pol+eng`).
"""
from __future__ import annotations

import base64
import json
import os
import re

import requests

UOCR_URL = os.environ.get("UOCR_URL", "").rstrip("/")  # np. http://127.0.0.1:10000
UOCR_MODEL = os.environ.get("UOCR_MODEL", "Unlimited-OCR-2")

try:  # procesor anty-powtórzeniowy z repo (dostępny tylko gdy zainstalowany jest ich SGLang)
    from sglang.srt.sampling.custom_logit_processor import DeepseekOCRNoRepeatNGramLogitProcessor

    _NGRAM = DeepseekOCRNoRepeatNGramLogitProcessor.to_str()
except Exception:  # noqa: BLE001
    _NGRAM = None


def uocr_available() -> bool:
    if not UOCR_URL:
        return False
    try:
        r = requests.get(f"{UOCR_URL}/v1/models", timeout=3)
        return r.ok
    except requests.RequestException:
        return False


def uocr_page(png_bytes: bytes, crop_mode: bool = True) -> str:
    """Zwraca surowy wynik Unlimited-OCR dla jednej strony."""
    img = {"type": "image_url",
           "image_url": {"url": "data:image/png;base64," + base64.b64encode(png_bytes).decode()}}
    payload = {
        "model": UOCR_MODEL,
        "messages": [{"role": "user", "content": [img, {"type": "text", "text": "<PAGE><image>Multi page parsing."}]}],
        "max_tokens": 8000,
        "temperature": 0,
        "skip_special_tokens": False,
        "images_config": {"crop_mode": crop_mode},
        "stream": False,
    }
    if _NGRAM:
        payload["custom_logit_processor"] = _NGRAM
        payload["custom_params"] = {"ngram_size": 35, "window_size": 128, "page_token_id": 128827,
                                    "eos_token_id": 1, "max_page_tokens": 20000}
    s = requests.Session()
    s.trust_env = False
    r = s.post(f"{UOCR_URL}/v1/chat/completions", data=json.dumps(payload),
               headers={"Content-Type": "application/json"}, timeout=600)
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"] or ""


BLOCK_RE = re.compile(r"<BLOCK>(?P<kind>[a-z_]+)(?:<LEVEL(?P<lvl>\d)>)?\s*(?:\[(?P<box>[\d.,\s]+)\])?\s*<FORK>(?P<body>.*?)(?=<BLOCK>|<PAGE>|$)", re.S)
SKIP_KINDS = {"image", "figure", "chart", "seal", "table", "cross_table", "append_table"}


def parse_uocr(raw: str) -> list[dict]:
    """Surowy format `<PAGE><BLOCK>text[x1,y1,x2,y2]<FORK>treść...` -> bloki tekstu.

    Zwraca [{kind, text, box:[x0,y0,x1,y1] w skali 0–1 względem strony}]."""
    blocks = []
    for m in BLOCK_RE.finditer(raw):
        kind = m.group("kind")
        if kind in SKIP_KINDS:
            continue
        body = re.sub(r"<[^>]+>", " ", m.group("body"))  # resztki tagów / tokenów specjalnych
        body = re.sub(r"[#*_`]+", " ", body)
        body = re.sub(r"\s+", " ", body).strip()
        if not body:
            continue
        box = None
        if m.group("box"):
            try:
                nums = [float(x) for x in m.group("box").split(",")]
                if len(nums) == 4:
                    box = [v / 1000.0 for v in nums]
            except ValueError:
                pass
        blocks.append({"kind": kind, "text": body, "box": box})
    if not blocks and raw.strip():  # nieznany format – traktujemy jako czysty tekst
        txt = re.sub(r"<[^>]+>", " ", raw)
        for para in re.split(r"\n\s*\n", txt):
            para = re.sub(r"\s+", " ", para).strip()
            if para:
                blocks.append({"kind": "text", "text": para, "box": None})
    return blocks


def ocr_page_words(page, png_bytes: bytes) -> tuple[list[dict], str]:
    """OCR strony PyMuPDF -> (lista słów jak w pdf_extract, nazwa silnika)."""
    pno = page.number
    W, H = page.rect.width, page.rect.height
    if uocr_available():
        words = []
        for b in parse_uocr(uocr_page(png_bytes)):
            box = [b["box"][0] * W, b["box"][1] * H, b["box"][2] * W, b["box"][3] * H] if b["box"] else None
            for k, t in enumerate(b["text"].split()):
                # Unlimited-OCR podaje ramkę bloku, nie słowa – słowa dziedziczą ramkę bloku
                words.append({"t": t, "page": pno, "box": box, "brk": k == 0, "approx": True})
        return words, "unlimited-ocr"
    try:
        tp = page.get_textpage_ocr(language="pol+eng", dpi=300, full=True)
        return _words_from_textpage(page, tp), "tesseract"
    except Exception:  # noqa: BLE001 – brak Tesseracta
        return [], "none"


def _words_from_textpage(page, tp) -> list[dict]:
    out, last_block = [], None
    for x0, y0, x1, y1, t, b, _l, _w in page.get_text("words", textpage=tp, sort=True):
        out.append({"t": t, "page": page.number, "box": [x0, y0, x1, y1], "brk": b != last_block})
        last_block = b
    return out
