# Lektor: darmowy czytnik PDF z głosem i notatkami w Google Docs

Lektor działa jak Natural Reader, ale jest darmowy i bez subskrypcji. Wgrywasz PDF (albo EPUB lub TXT), a aplikacja czyta go na głos.
Na stronie podświetla czytane **zdanie** i bieżące **słowo**. W każdej chwili możesz nacisnąć **N**:
zapiszesz wtedy cytat i swoją myśl, przypisane do grupy. Notatki trafiają od razu do **Google Docs**.

## Głosy

| Język | Głos (domyślny) | Silnik | Koszt |
|---|---|---|---|
| polski | **Marek** (`pl-PL-MarekNeural`), męski | Microsoft Edge Neural (`edge-tts`) | darmowy, bez klucza |
| angielski | **Andrew Multilingual** (`en-US-AndrewMultilingualNeural`), męski | Microsoft Edge Neural | darmowy, bez klucza |

To najlepsze darmowe głosy męskie w obu językach. Podają też czas każdego słowa, więc
podświetlanie słowo po słowie działa płynnie. W ustawieniach są też inne głosy: Brian, Ryan (GB), Zofia, Ava.

Pozostałe silniki do wyboru w odtwarzaczu:
* **Piper (offline)**: `pl_PL-darkman-medium` i `en_US-ryan-high`. Działa bez internetu, głos pobiera się przy pierwszym użyciu.
* **ElevenLabs**: najwyższa jakość, ale na własnym kluczu API (darmowy limit to ok. 10 tys. znaków miesięcznie, więcej jest płatne).
  Wpisz `ELEVENLABS_API_KEY` i ID głosów w pliku `.env`.
* **Przeglądarka**: głosy systemowe (Web Speech API), awaryjnie.

Tempo od 0,5× do 3× zmieniasz bez ponownego generowania dźwięku. Wygenerowane zdania są zapisywane w pamięci podręcznej na dysku.

## Uruchomienie

Potrzebny jest Python 3.10 lub nowszy.

* **Windows**: kliknij dwukrotnie `start.bat`.
* **macOS / Linux**: uruchom `./start.sh`.

Za pierwszym razem skrypt utworzy środowisko `.venv` i zainstaluje zależności. Potem otworzy się
przeglądarka z adresem **http://localhost:8765**. Wszystkie dane (biblioteka, notatki, cache) leżą lokalnie w `reader/data/`.

### Skróty

| Klawisz | Akcja |
|---|---|
| `Spacja` | czytaj / pauza |
| `←` / `→` | poprzednie / następne zdanie |
| `N` | notatka z bieżącego zdania (czytanie się zatrzymuje) |
| `Ctrl+Enter` | zapisz notatkę (i wznów czytanie) |
| `+` / `−` | tempo |
| klik w zdanie | czytaj od tego miejsca |

Działają też przyciski multimedialne na słuchawkach i klawiaturze.

## Notatki i Google Docs

Każda notatka to **cytat**, **twoja myśl** i **grupa** (np. „Mechanizmy obronne”, „Pytania na egzamin”).
* Do cytatu możesz dołączyć poprzednie lub następne zdanie. Możesz też zaznaczyć fragment w widoku „Tekst” i dopiero potem nacisnąć `N`.
* Myśl możesz **podyktować** przyciskiem 🎙 (działa w Chrome i Edge).
* Dla każdego czytanego dokumentu Lektor zakłada jeden dokument Google „Notatki – <tytuł>”.
  Każda grupa to w nim nagłówek. Nowa notatka trafia na koniec sekcji swojej grupy, więc **ręczne zmiany w Google Docs zostają**.
* Menu `⋯` w panelu notatek daje trzy opcje: **Przebuduj dokument** (odtwarza go z notatek, przydaje się po edycji lub usunięciu notatki),
  **Podłącz istniejący dokument** (np. wspólny zeszyt notatek) oraz **Pobierz .md**.
* Bez połączenia z Google notatki zapisują się lokalnie. „Przebuduj” wyśle je później.

### Jednorazowa konfiguracja Google (ok. 5 minut)

1. Wejdź na https://console.cloud.google.com/ i utwórz projekt, np. „Lektor”.
2. W **APIs & Services → Library** włącz **Google Docs API** i **Google Drive API**.
3. W **APIs & Services → OAuth consent screen** wybierz typ *External*, wpisz nazwę aplikacji i swój e-mail.
   W sekcji **Test users** dodaj swój adres Gmail.
4. W **APIs & Services → Credentials** wybierz **Create credentials → OAuth client ID**:
   * Application type: **Web application**
   * Authorized redirect URIs: `http://localhost:8765/api/google/callback`
5. Pobierz JSON i zapisz go jako `reader/data/google_client_secret.json`.
6. W Lektorze kliknij **Połącz z Google** (lewy dolny róg).

> W trybie „Testing” Google co 7 dni prosi o ponowne zalogowanie. Żeby tego uniknąć, kliknij na ekranie zgody
> **Publish app**. Do własnego użytku nie trzeba przechodzić weryfikacji, wystarczy zaakceptować ostrzeżenie przy logowaniu.

## OCR skanów: Unlimited-OCR

Zwykłe PDF-y mają warstwę tekstową i czytają się od razu. Strony **skanowane** (same obrazy) przechodzą przez OCR:

1. **[Unlimited-OCR 2](https://github.com/baidu/Unlimited-OCR)** (Baidu, licencja MIT) daje najlepszą jakość. Model wymaga
   karty **NVIDIA z CUDA**. Uruchamia się go jako serwer SGLang, na swoim komputerze z GPU, na drugiej maszynie albo w chmurze z GPU:
   ```bash
   git clone https://github.com/baidu/Unlimited-OCR && cd Unlimited-OCR
   uv venv --python 3.10 && source .venv/bin/activate
   uv pip install wheel/sglang-*.whl pymupdf fastokens
   python -m sglang.launch_server --model-path baidu/Unlimited-OCR-2 \
       --served-model-name Unlimited-OCR-2 --chat-template unlimited-ocr \
       --enable-custom-logit-processor --port 10000 --host 0.0.0.0
   ```
   (Pełna lista zalecanych flag i zmiennych `SGLANG_UOCR_*` jest w README repozytorium Unlimited-OCR.)
   Potem w pliku `reader/.env` wpisz `UOCR_URL=http://<adres>:10000`. Lektor wyśle każdą skanowaną stronę do serwera.
   Unlimited-OCR podaje ramki **bloków**, nie pojedynczych słów, więc na skanach podświetlany jest akapit, a nie zdanie.
   W widoku „Tekst” podświetlanie zdań i słów działa normalnie.
2. **Tesseract** to zapasowe rozwiązanie bez GPU. Jeśli masz go zainstalowanego z językiem polskim (`pol`), Lektor użyje go
   automatycznie i podświetli słowa dokładnie.

## Struktura

```
reader/
  server/app.py          API (FastAPI): biblioteka, strony PNG, TTS, notatki, OAuth Google
  server/pdf_extract.py  tekst + pozycje słów z PDF (PyMuPDF), pomijanie nagłówków i stopek, OCR skanów
  server/textproc.py     podział na zdania (PL/EN, skróty typu „np.”, „m.in.”, „prof.”, „e.g.”), wykrywanie języka
  server/tts.py          Edge Neural / Piper / ElevenLabs + cache
  server/ocr.py          klient Unlimited-OCR 2 (SGLang) + Tesseract
  server/gdocs.py        zapis notatek w Google Docs (grupy = nagłówki)
  web/                   interfejs (bez bibliotek zewnętrznych)
```
