"""Lektor – darmowy czytnik PDF z głosem i notatkami w Google Docs.

Uruchomienie:  python -m server.app   (z katalogu reader/)  ->  http://localhost:8765
"""
from __future__ import annotations

import base64
import json
import os
import re
import shutil
import threading
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_env():
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            m = re.match(r"\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$", line)
            if m and not line.lstrip().startswith("#"):
                os.environ.setdefault(m.group(1), m.group(2).strip().strip('"').strip("'"))


_load_env()

from fastapi import Body, FastAPI, File, HTTPException, Request, UploadFile  # noqa: E402
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse, RedirectResponse, Response  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402

from . import gdocs, ocr, pdf_extract, tts  # noqa: E402

PORT = int(os.environ.get("PORT", "8765"))
DATA = Path(os.environ.get("READER_DATA", ROOT / "data"))
LIB = DATA / "library"
LIB.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Lektor")
_jobs: dict[str, dict] = {}
_lock = threading.Lock()


# ------------------------------------------------------------------ helpers
def _dir(doc_id: str) -> Path:
    if not re.fullmatch(r"[a-f0-9]{12}", doc_id):
        raise HTTPException(404)
    d = LIB / doc_id
    if not d.exists():
        raise HTTPException(404, "Nie ma takiego dokumentu")
    return d


def _read(p: Path, default):
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else default


def _write(p: Path, data) -> None:
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    tmp.replace(p)


def _meta(doc_id: str) -> dict:
    return _read(_dir(doc_id) / "meta.json", {})


def _save_meta(doc_id: str, meta: dict) -> None:
    _write(_dir(doc_id) / "meta.json", meta)


# ------------------------------------------------------------------ status
@app.get("/api/status")
def status():
    return {
        "voices": tts.VOICES,
        "edge_alternatives": tts.EXTRA_EDGE,
        "elevenlabs": bool(os.environ.get("ELEVENLABS_API_KEY")),
        "google_configured": gdocs.configured(),
        "google_connected": gdocs.connected(),
        "uocr_url": ocr.UOCR_URL or None,
        "uocr_online": ocr.uocr_available(),
    }


# ------------------------------------------------------------------ library
@app.get("/api/docs")
def list_docs():
    out = []
    for d in LIB.iterdir():
        m = _read(d / "meta.json", None)
        if m:
            out.append(m)
    out.sort(key=lambda m: m.get("opened", m.get("created", 0)), reverse=True)
    return out


def _process(doc_id: str, src: Path, kind: str):
    job = _jobs[doc_id]
    try:
        if kind == "txt":
            data = pdf_extract.from_plain_text(src.read_text(encoding="utf-8", errors="replace"), src.stem)
        else:
            data = pdf_extract.extract(str(src), progress=lambda m: job.update(msg=m))
        _write(LIB / doc_id / "doc.json", data)
        meta = _read(LIB / doc_id / "meta.json", {})
        meta.update(lang=data["lang"], pages=len(data["pages"]), sentences=len(data["sentences"]), ready=True,
                    ocr_pages=sum(1 for p in data["pages"] if p["source"] != "text"))
        if data.get("title") and meta.get("title_from_file"):
            meta["title"] = data["title"]
        _write(LIB / doc_id / "meta.json", meta)
        job.update(state="done", msg="Gotowe")
    except Exception as e:  # noqa: BLE001
        job.update(state="error", msg=str(e))


@app.post("/api/docs")
async def upload(file: UploadFile = File(...)):
    name = file.filename or "dokument.pdf"
    ext = Path(name).suffix.lower()
    if ext not in (".pdf", ".epub", ".txt", ".md", ".xps", ".fb2", ".mobi"):
        raise HTTPException(400, "Obsługiwane: PDF, EPUB, TXT, MD")
    doc_id = uuid.uuid4().hex[:12]
    d = LIB / doc_id
    d.mkdir()
    src = d / f"source{ext}"
    with src.open("wb") as f:
        shutil.copyfileobj(file.file, f)
    kind = "txt" if ext in (".txt", ".md") else "pdf"
    _write(d / "meta.json", {"id": doc_id, "title": Path(name).stem, "file": src.name, "kind": kind,
                             "created": time.time(), "position": 0, "ready": False, "title_from_file": False})
    _jobs[doc_id] = {"state": "running", "msg": "Wczytywanie…"}
    threading.Thread(target=_process, args=(doc_id, src, kind), daemon=True).start()
    return {"id": doc_id}


@app.post("/api/docs/text")
def paste_text(payload: dict = Body(...)):
    text = payload.get("text", "").strip()
    if not text:
        raise HTTPException(400, "Pusty tekst")
    doc_id = uuid.uuid4().hex[:12]
    d = LIB / doc_id
    d.mkdir()
    (d / "source.txt").write_text(text, encoding="utf-8")
    title = payload.get("title") or text[:40].split("\n")[0]
    _write(d / "meta.json", {"id": doc_id, "title": title, "file": "source.txt", "kind": "txt",
                             "created": time.time(), "position": 0, "ready": False})
    _jobs[doc_id] = {"state": "running", "msg": ""}
    _process(doc_id, d / "source.txt", "txt")
    return {"id": doc_id}


@app.get("/api/docs/{doc_id}/job")
def job(doc_id: str):
    j = _jobs.get(doc_id)
    if j:
        return j
    return {"state": "done" if _meta(doc_id).get("ready") else "error", "msg": ""}


@app.get("/api/docs/{doc_id}")
def get_doc(doc_id: str):
    d = _dir(doc_id)
    meta = _meta(doc_id)
    meta["opened"] = time.time()
    _save_meta(doc_id, meta)
    return {"meta": meta, "doc": _read(d / "doc.json", None)}


@app.patch("/api/docs/{doc_id}")
def patch_doc(doc_id: str, payload: dict = Body(...)):
    meta = _meta(doc_id)
    for k in ("title", "lang", "position", "gdoc_id", "voice", "engine"):
        if k in payload:
            meta[k] = payload[k]
    _save_meta(doc_id, meta)
    return meta


@app.delete("/api/docs/{doc_id}")
def delete_doc(doc_id: str):
    shutil.rmtree(_dir(doc_id))
    return {"ok": True}


@app.get("/api/docs/{doc_id}/page/{pno}.png")
def page_png(doc_id: str, pno: int, zoom: float = 2.0):
    d = _dir(doc_id)
    meta = _meta(doc_id)
    cache = d / "pages" / f"{pno}_{zoom:.1f}.png"
    if not cache.exists():
        cache.parent.mkdir(exist_ok=True)
        cache.write_bytes(pdf_extract.render_page(str(d / meta["file"]), pno, min(max(zoom, 0.5), 4)))
    return FileResponse(cache, media_type="image/png", headers={"Cache-Control": "max-age=86400"})


# ------------------------------------------------------------------ TTS
@app.post("/api/tts")
def speak(payload: dict = Body(...)):
    text = (payload.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "Brak tekstu")
    try:
        r = tts.synthesize(text, payload.get("lang", "pl"), payload.get("engine", "edge"), payload.get("voice") or None)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Błąd syntezy mowy ({payload.get('engine', 'edge')}): {e}") from e
    return {"mime": r["mime"], "marks": r["marks"], "audio": base64.b64encode(r["audio"]).decode()}


# ------------------------------------------------------------------ notes
def _notes_path(doc_id: str) -> Path:
    return _dir(doc_id) / "notes.json"


@app.get("/api/docs/{doc_id}/notes")
def get_notes(doc_id: str):
    return _read(_notes_path(doc_id), [])


def _push_note(doc_id: str, note: dict) -> str | None:
    """Wysyła notatkę do Google Docs. Zwraca komunikat błędu albo None."""
    if not gdocs.connected():
        return "Google Docs niepołączone – notatka zapisana lokalnie."
    meta = _meta(doc_id)
    try:
        if not meta.get("gdoc_id"):
            meta["gdoc_id"] = gdocs.create_doc(meta.get("title", "Dokument"))
            _save_meta(doc_id, meta)
        gdocs.append_note(meta["gdoc_id"], note)
        return None
    except Exception as e:  # noqa: BLE001
        return f"Nie udało się zapisać w Google Docs: {e}"


@app.post("/api/docs/{doc_id}/notes")
def add_note(doc_id: str, payload: dict = Body(...)):
    with _lock:
        notes = _read(_notes_path(doc_id), [])
        note = {"id": uuid.uuid4().hex[:10], "created": time.time(),
                "quote": payload.get("quote", "").strip(), "thought": payload.get("thought", "").strip(),
                "group": (payload.get("group") or "Bez grupy").strip(),
                "page": payload.get("page"), "sentence": payload.get("sentence"), "synced": False}
        err = _push_note(doc_id, note)
        note["synced"] = err is None
        notes.append(note)
        _write(_notes_path(doc_id), notes)
    return {"note": note, "warning": err, "gdoc_url": gdocs.doc_url(_meta(doc_id)["gdoc_id"]) if _meta(doc_id).get("gdoc_id") else None}


@app.put("/api/docs/{doc_id}/notes/{note_id}")
def edit_note(doc_id: str, note_id: str, payload: dict = Body(...)):
    with _lock:
        notes = _read(_notes_path(doc_id), [])
        for n in notes:
            if n["id"] == note_id:
                for k in ("quote", "thought", "group"):
                    if k in payload:
                        n[k] = payload[k].strip()
                n["edited"] = True
        _write(_notes_path(doc_id), notes)
    return {"ok": True}


@app.delete("/api/docs/{doc_id}/notes/{note_id}")
def delete_note(doc_id: str, note_id: str):
    with _lock:
        notes = [n for n in _read(_notes_path(doc_id), []) if n["id"] != note_id]
        _write(_notes_path(doc_id), notes)
    return {"ok": True}


@app.get("/api/docs/{doc_id}/notes.md")
def notes_md(doc_id: str):
    meta = _meta(doc_id)
    notes = _read(_notes_path(doc_id), [])
    groups: dict[str, list] = {}
    for n in notes:
        groups.setdefault(n.get("group") or "Bez grupy", []).append(n)
    out = [f"# Notatki – {meta.get('title', '')}", ""]
    for g, ns in groups.items():
        out += [f"## {g}", ""]
        for n in ns:
            if n.get("quote"):
                page = f" — s. {n['page'] + 1}" if n.get("page") is not None else ""
                out.append(f"> „{n['quote']}”{page}")
                out.append("")
            if n.get("thought"):
                out += [n["thought"], ""]
    return PlainTextResponse("\n".join(out), media_type="text/markdown; charset=utf-8",
                             headers={"Content-Disposition": f'attachment; filename="notatki-{doc_id}.md"'})


# ------------------------------------------------------------------ Google
@app.get("/api/google/login")
def google_login(request: Request):
    if not gdocs.configured():
        return HTMLResponse("<p>Brak pliku <code>data/google_client_secret.json</code>. Zobacz README.</p>", 400)
    redirect = f"http://localhost:{PORT}/api/google/callback"
    return RedirectResponse(gdocs.login_url(redirect))


@app.get("/api/google/callback")
def google_callback(request: Request):
    try:
        gdocs.finish_login(str(request.url).replace("127.0.0.1", "localhost"))
    except Exception as e:  # noqa: BLE001
        return HTMLResponse(f"<p>Logowanie nieudane: {e}</p><p><a href='/'>Wróć</a></p>", 400)
    return HTMLResponse("<script>window.opener&&window.opener.postMessage('google-ok','*');window.close();"
                        "setTimeout(()=>location.href='/',500)</script>Połączono z Google. Możesz zamknąć to okno.")


@app.post("/api/google/logout")
def google_logout():
    gdocs.logout()
    return {"ok": True}


@app.post("/api/docs/{doc_id}/gdoc/link")
def gdoc_link(doc_id: str, payload: dict = Body(...)):
    """Podłącz istniejący dokument Google (URL albo ID)."""
    raw = payload.get("url", "")
    m = re.search(r"/d/([A-Za-z0-9_-]{20,})", raw) or re.fullmatch(r"([A-Za-z0-9_-]{20,})", raw.strip())
    if not m:
        raise HTTPException(400, "Nieprawidłowy link do Google Docs")
    meta = _meta(doc_id)
    meta["gdoc_id"] = m.group(1)
    _save_meta(doc_id, meta)
    return {"gdoc_url": gdocs.doc_url(meta["gdoc_id"])}


@app.post("/api/docs/{doc_id}/gdoc/rebuild")
def gdoc_rebuild(doc_id: str):
    meta = _meta(doc_id)
    notes = _read(_notes_path(doc_id), [])
    try:
        if not meta.get("gdoc_id"):
            meta["gdoc_id"] = gdocs.create_doc(meta.get("title", "Dokument"))
            _save_meta(doc_id, meta)
        gdocs.rebuild(meta["gdoc_id"], meta.get("title", ""), notes)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, str(e)) from e
    for n in notes:
        n["synced"] = True
    _write(_notes_path(doc_id), notes)
    return {"gdoc_url": gdocs.doc_url(meta["gdoc_id"])}


# ------------------------------------------------------------------ frontend
app.mount("/", StaticFiles(directory=ROOT / "web", html=True), name="web")


def main():
    import uvicorn
    import webbrowser

    print(f"\n  Lektor działa:  http://localhost:{PORT}\n")
    if os.environ.get("NO_BROWSER") != "1":
        threading.Timer(1.2, lambda: webbrowser.open(f"http://localhost:{PORT}")).start()
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
