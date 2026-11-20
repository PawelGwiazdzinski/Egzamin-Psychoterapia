"""Integracja z Google Docs: notatki (cytat + własna myśl) grupowane pod nagłówkami.

Struktura dokumentu Google (jeden dokument na czytaną książkę/PDF):

    Notatki – <tytuł>                     (Tytuł)
    <Grupa A>                             (Nagłówek 2)
      „cytat…” — s. 12                    (kursywa, wcięcie, szara linia z lewej)
      → moja myśl                         (zwykły tekst)
    <Grupa B>
      …

Nowe notatki są wstawiane na końcu sekcji swojej grupy, więc ręczne zmiany w dokumencie
zostają nienaruszone. Przycisk „Przebuduj” odtwarza cały dokument z lokalnych notatek.
"""
from __future__ import annotations

import os
from pathlib import Path

os.environ.setdefault("OAUTHLIB_INSECURE_TRANSPORT", "1")  # localhost bez HTTPS
os.environ.setdefault("OAUTHLIB_RELAX_TOKEN_SCOPE", "1")

DATA = Path(os.environ.get("READER_DATA", Path(__file__).resolve().parent.parent / "data"))
CLIENT_SECRET = DATA / "google_client_secret.json"
TOKEN = DATA / "google_token.json"
SCOPES = ["https://www.googleapis.com/auth/documents", "https://www.googleapis.com/auth/drive.file"]

_pending_flow = None


def configured() -> bool:
    return CLIENT_SECRET.exists()


def _creds():
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials

    if not TOKEN.exists():
        return None
    creds = Credentials.from_authorized_user_file(str(TOKEN), SCOPES)
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        TOKEN.write_text(creds.to_json())
    return creds if creds.valid else None


def connected() -> bool:
    try:
        return _creds() is not None
    except Exception:  # noqa: BLE001
        return False


def login_url(redirect_uri: str) -> str:
    global _pending_flow
    from google_auth_oauthlib.flow import Flow

    _pending_flow = Flow.from_client_secrets_file(str(CLIENT_SECRET), scopes=SCOPES, redirect_uri=redirect_uri)
    url, _ = _pending_flow.authorization_url(access_type="offline", prompt="consent", include_granted_scopes="true")
    return url


def finish_login(authorization_response: str) -> None:
    global _pending_flow
    if _pending_flow is None:
        raise RuntimeError("Brak rozpoczętego logowania – kliknij „Połącz z Google” jeszcze raz.")
    _pending_flow.fetch_token(authorization_response=authorization_response)
    TOKEN.write_text(_pending_flow.credentials.to_json())
    _pending_flow = None


def logout() -> None:
    TOKEN.unlink(missing_ok=True)


def _service():
    from googleapiclient.discovery import build

    creds = _creds()
    if not creds:
        raise RuntimeError("Nie połączono z Google.")
    return build("docs", "v1", credentials=creds, cache_discovery=False)


def doc_url(doc_id: str) -> str:
    return f"https://docs.google.com/document/d/{doc_id}/edit"


def create_doc(title: str) -> str:
    svc = _service()
    d = svc.documents().create(body={"title": f"Notatki – {title}"}).execute()
    doc_id = d["documentId"]
    text = f"Notatki – {title}\n"
    svc.documents().batchUpdate(documentId=doc_id, body={"requests": [
        {"insertText": {"location": {"index": 1}, "text": text}},
        {"updateParagraphStyle": {"range": {"startIndex": 1, "endIndex": 1 + len(text)},
                                  "paragraphStyle": {"namedStyleType": "TITLE"}, "fields": "namedStyleType"}},
    ]}).execute()
    return doc_id


def _u16(s: str) -> int:
    """Indeksy Google Docs liczone są w jednostkach UTF-16."""
    return len(s.encode("utf-16-le")) // 2


def _paragraphs(doc: dict) -> list[dict]:
    out = []
    for el in doc.get("body", {}).get("content", []):
        p = el.get("paragraph")
        if not p:
            continue
        text = "".join(r.get("textRun", {}).get("content", "") for r in p.get("elements", []))
        out.append({"start": el["startIndex"], "end": el["endIndex"], "text": text.rstrip("\n"),
                    "style": p.get("paragraphStyle", {}).get("namedStyleType", "NORMAL_TEXT")})
    return out


def _note_lines(note: dict) -> list[tuple[str, str]]:
    """[(tekst akapitu, rodzaj)] – rodzaj: quote | thought | spacer"""
    lines = []
    if note.get("quote"):
        src = f" — s. {note['page'] + 1}" if note.get("page") is not None else ""
        lines.append((f"„{note['quote'].strip()}”{src}", "quote"))
    if note.get("thought"):
        for i, para in enumerate(note["thought"].strip().split("\n")):
            if para.strip():
                lines.append((("→ " if i == 0 else "   ") + para.strip(), "thought"))
    lines.append(("", "spacer"))
    return lines


def _style_requests(start: int, lines: list[tuple[str, str]]) -> list[dict]:
    reqs = []
    idx = start
    for text, kind in lines:
        end = idx + _u16(text) + 1
        rng = {"startIndex": idx, "endIndex": end}
        if kind == "heading":
            reqs.append({"updateParagraphStyle": {"range": rng, "paragraphStyle": {"namedStyleType": "HEADING_2"},
                                                  "fields": "namedStyleType"}})
            continue
        ps = {"namedStyleType": "NORMAL_TEXT", "indentStart": {"magnitude": 0, "unit": "PT"},
              "indentFirstLine": {"magnitude": 0, "unit": "PT"}}
        fields = "namedStyleType,indentStart,indentFirstLine"
        if kind == "quote":
            ps.update({"indentStart": {"magnitude": 18, "unit": "PT"}, "indentFirstLine": {"magnitude": 18, "unit": "PT"},
                       "borderLeft": {"color": {"color": {"rgbColor": {"red": .7, "green": .7, "blue": .7}}},
                                      "width": {"magnitude": 2, "unit": "PT"}, "padding": {"magnitude": 6, "unit": "PT"},
                                      "dashStyle": "SOLID"}})
            fields += ",borderLeft"
        reqs.append({"updateParagraphStyle": {"range": rng, "paragraphStyle": ps, "fields": fields}})
        if text:
            trange = {"startIndex": idx, "endIndex": end - 1}
            ts = {"italic": kind == "quote", "foregroundColor": {"color": {"rgbColor":
                  ({"red": .3, "green": .3, "blue": .3} if kind == "quote" else {"red": 0, "green": 0, "blue": 0})}}}
            reqs.append({"updateTextStyle": {"range": trange, "textStyle": ts, "fields": "italic,foregroundColor"}})
        idx = end
    return reqs


def append_note(doc_id: str, note: dict) -> None:
    """Wstawia notatkę na końcu sekcji jej grupy (tworzy sekcję, jeśli trzeba)."""
    svc = _service()
    doc = svc.documents().get(documentId=doc_id).execute()
    paras = _paragraphs(doc)
    group = (note.get("group") or "Bez grupy").strip()
    lines = _note_lines(note)

    head_i = next((i for i, p in enumerate(paras) if p["style"] == "HEADING_2" and p["text"].strip() == group), None)
    if head_i is None:
        lines = [(group, "heading")] + lines
        insert_at = None  # koniec dokumentu
    else:
        nxt = next((p for p in paras[head_i + 1:] if p["style"] in ("HEADING_1", "HEADING_2", "TITLE")), None)
        insert_at = nxt["start"] if nxt else None

    if insert_at is None:
        last = paras[-1]
        if last["text"] == "":  # pusty ostatni akapit – piszemy w nim
            start = last["start"]
            reqs = [{"insertText": {"location": {"index": start}, "text": "\n".join(t for t, _ in lines)}}]
        else:  # nowy akapit po ostatnim
            start = last["end"]
            reqs = [{"insertText": {"location": {"index": last["end"] - 1},
                                    "text": "\n" + "\n".join(t for t, _ in lines)}}]
    else:
        start = insert_at
        text = "".join(t + "\n" for t, _ in lines)
        reqs = [{"insertText": {"location": {"index": start}, "text": text}}]
    reqs += _style_requests(start, lines)
    svc.documents().batchUpdate(documentId=doc_id, body={"requests": reqs}).execute()


def rebuild(doc_id: str, title: str, notes: list[dict]) -> None:
    """Czyści dokument i zapisuje wszystkie notatki od nowa (pogrupowane)."""
    svc = _service()
    doc = svc.documents().get(documentId=doc_id).execute()
    end = doc["body"]["content"][-1]["endIndex"]
    reqs = []
    if end > 2:
        reqs.append({"deleteContentRange": {"range": {"startIndex": 1, "endIndex": end - 1}}})
    lines: list[tuple[str, str]] = [(f"Notatki – {title}", "title")]
    groups: dict[str, list[dict]] = {}
    for n in notes:
        groups.setdefault((n.get("group") or "Bez grupy").strip(), []).append(n)
    for g, ns in groups.items():
        lines.append((g, "heading"))
        for n in ns:
            lines += _note_lines(n)
    text = "".join(t + "\n" for t, _ in lines)
    reqs.append({"insertText": {"location": {"index": 1}, "text": text}})
    style = []  # tytuł
    t_end = 1 + _u16(lines[0][0]) + 1
    style.append({"updateParagraphStyle": {"range": {"startIndex": 1, "endIndex": t_end},
                                           "paragraphStyle": {"namedStyleType": "TITLE"}, "fields": "namedStyleType"}})
    style += _style_requests(t_end, lines[1:])
    reqs += style
    svc.documents().batchUpdate(documentId=doc_id, body={"requests": reqs}).execute()
