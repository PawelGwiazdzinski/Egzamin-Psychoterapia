"""Silniki mowy.

Domyślne (darmowe, bez klucza, bez subskrypcji) – neuronowe głosy Microsoft Edge (edge-tts):
  * PL: pl-PL-MarekNeural               – męski, naturalny polski głos
  * EN: en-US-AndrewMultilingualNeural  – męski, bardzo naturalny głos angielski
Zwracają też znaczniki czasu słów, więc podświetlamy na bieżąco aktualne słowo.

Offline (bez internetu): Piper – pl_PL-darkman-medium / en_US-ryan-high (pobierane przy 1. użyciu).
Opcjonalnie: ElevenLabs (własny klucz API, płatne powyżej darmowego limitu).
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import os
import re
import wave
from pathlib import Path

import requests

DATA = Path(os.environ.get("READER_DATA", Path(__file__).resolve().parent.parent / "data"))
CACHE = DATA / "tts_cache"
VOICES_DIR = DATA / "voices"
CACHE.mkdir(parents=True, exist_ok=True)

VOICES = {
    "edge": {"pl": "pl-PL-MarekNeural", "en": "en-US-AndrewMultilingualNeural"},
    "piper": {"pl": "pl_PL-darkman-medium", "en": "en_US-ryan-high"},
    "elevenlabs": {
        "pl": os.environ.get("ELEVENLABS_VOICE_PL", ""),
        "en": os.environ.get("ELEVENLABS_VOICE_EN", ""),
    },
}
EXTRA_EDGE = {  # alternatywy do wyboru w ustawieniach
    "pl": ["pl-PL-MarekNeural", "pl-PL-ZofiaNeural"],
    "en": ["en-US-AndrewMultilingualNeural", "en-US-BrianMultilingualNeural", "en-GB-RyanNeural",
           "en-US-AvaMultilingualNeural"],
}


def _clean(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    return text


# ---------------------------------------------------------------- Edge
async def _edge(text: str, voice: str) -> tuple[bytes, list[dict]]:
    import edge_tts

    comm = edge_tts.Communicate(text, voice, boundary="WordBoundary")
    audio = bytearray()
    marks = []
    async for chunk in comm.stream():
        if chunk["type"] == "audio":
            audio.extend(chunk["data"])
        elif chunk["type"] == "WordBoundary":
            marks.append({"t": chunk["text"], "start": chunk["offset"] / 10_000,
                          "end": (chunk["offset"] + chunk["duration"]) / 10_000})
    if not audio:
        raise RuntimeError("Edge TTS nie zwrócił dźwięku")
    return bytes(audio), marks


# ---------------------------------------------------------------- Piper (offline)
_piper_cache: dict = {}
PIPER_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main"


def _piper_paths(name: str) -> tuple[Path, Path]:
    lang_full, speaker, quality = name.split("-")
    lang = lang_full.split("_")[0]
    VOICES_DIR.mkdir(parents=True, exist_ok=True)
    onnx = VOICES_DIR / f"{name}.onnx"
    cfg = VOICES_DIR / f"{name}.onnx.json"
    for p in (onnx, cfg):
        if not p.exists():
            url = f"{PIPER_BASE}/{lang}/{lang_full}/{speaker}/{quality}/{p.name}"
            r = requests.get(url, timeout=300)
            r.raise_for_status()
            p.write_bytes(r.content)
    return onnx, cfg


def _piper(text: str, name: str) -> tuple[bytes, list[dict]]:
    from piper import PiperVoice

    if name not in _piper_cache:
        onnx, cfg = _piper_paths(name)
        _piper_cache[name] = PiperVoice.load(onnx, config_path=cfg)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        _piper_cache[name].synthesize_wav(text, wf)
    return buf.getvalue(), []  # Piper nie podaje czasów słów – podświetlamy całe zdanie


# ---------------------------------------------------------------- ElevenLabs (opcjonalnie)
def _elevenlabs(text: str, voice_id: str, lang: str) -> tuple[bytes, list[dict]]:
    key = os.environ.get("ELEVENLABS_API_KEY")
    if not key or not voice_id:
        raise RuntimeError("Ustaw ELEVENLABS_API_KEY i ELEVENLABS_VOICE_PL / _EN w pliku .env")
    r = requests.post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/with-timestamps",
        headers={"xi-api-key": key, "Content-Type": "application/json"},
        json={"text": text, "model_id": os.environ.get("ELEVENLABS_MODEL", "eleven_multilingual_v2"),
              "language_code": lang},
        timeout=120,
    )
    r.raise_for_status()
    data = r.json()
    al = data.get("alignment") or {}
    chars, starts, ends = al.get("characters", []), al.get("character_start_times_seconds", []), al.get("character_end_times_seconds", [])
    marks, word, ws = [], "", None
    for c, s, e in zip(chars, starts, ends):
        if c.isspace():
            if word:
                marks.append({"t": word, "start": ws * 1000, "end": prev_e * 1000})
            word, ws = "", None
        else:
            if ws is None:
                ws = s
            word += c
        prev_e = e
    if word:
        marks.append({"t": word, "start": ws * 1000, "end": prev_e * 1000})
    return base64.b64decode(data["audio_base64"]), marks


# ---------------------------------------------------------------- API
def synthesize(text: str, lang: str, engine: str = "edge", voice: str | None = None) -> dict:
    text = _clean(text)
    voice = voice or VOICES.get(engine, {}).get(lang) or VOICES["edge"][lang]
    key = hashlib.sha1(json.dumps([engine, voice, text]).encode()).hexdigest()
    meta_p, audio_p = CACHE / f"{key}.json", CACHE / f"{key}.bin"
    if meta_p.exists() and audio_p.exists():
        meta = json.loads(meta_p.read_text())
        return {**meta, "audio": audio_p.read_bytes()}

    if engine == "edge":
        audio, marks = asyncio.run(_edge(text, voice))
        mime = "audio/mpeg"
    elif engine == "piper":
        audio, marks = _piper(text, voice)
        mime = "audio/wav"
    elif engine == "elevenlabs":
        audio, marks = _elevenlabs(text, voice, lang)
        mime = "audio/mpeg"
    else:
        raise ValueError(f"Nieznany silnik: {engine}")

    meta = {"mime": mime, "marks": marks, "engine": engine, "voice": voice}
    audio_p.write_bytes(audio)
    meta_p.write_text(json.dumps(meta))
    return {**meta, "audio": audio}
