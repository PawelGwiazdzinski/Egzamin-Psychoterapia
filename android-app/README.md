# Lektor na Androida

Darmowy czytnik PDF z głosem, w stylu Natural Reader, bez subskrypcji. Działa na telefonie, w tym na Galaxy S26+.

## Instalacja

1. Na telefonie otwórz https://github.com/PawelGwiazdzinski/Egzamin-Psychoterapia/releases/latest i pobierz **Lektor.apk**.
2. Otwórz plik i zezwól przeglądarce na instalowanie aplikacji.
3. Przy pierwszym uruchomieniu zezwól na powiadomienia. Dzięki nim czytanie trwa przy wygaszonym ekranie.

Nowe wersje instalujesz tak samo, na starą. Biblioteka i notatki zostają.

## Co umie

* **PDF z telefonu:** otwierasz go w Lektorze albo przez *Udostępnij / Otwórz za pomocą → Lektor* (Pliki, Gmail, Dysk). Działa też wklejony tekst.
* **Czytanie z podświetlaniem:** na stronie widać czytane **zdanie** i bieżące **słowo**. Stuknięcie w zdanie zaczyna czytanie od tego miejsca.
  Strony powiększasz dwoma palcami, a przycisk ¶ przełącza na widok samego tekstu.
* **Głosy męskie:**
  * domyślnie **Marek** (PL) i **Andrew** (EN), neuronowe głosy Microsoft Edge. Są darmowe, ale wymagają internetu;
  * bez internetu Lektor sam przełącza się na **głos telefonu** (Google: `bmg` po polsku, `iom` po angielsku), który działa offline.
    Głosy pobierzesz w ⚙ → *Pobierz głosy offline*;
  * opcjonalnie **ElevenLabs** na Twoim kluczu API (płatne powyżej darmowego limitu).
* **Czytanie w tle:** przy wygaszonym ekranie. Sterujesz nim z ekranu blokady, z powiadomienia i przyciskami słuchawek.
  Czytanie zatrzymuje się, gdy wyjmiesz słuchawki albo zadzwoni telefon.
* **Ustawienia czytania:** tempo od 0,5× do 3×, timer snu, motywy (jasny, sepia, ciemny), rozmiar tekstu.
* **Notatki:** stuknij **＋ Notatka**, a czytanie się zatrzyma. Dodajesz cytat (można go rozszerzyć o sąsiednie zdania), swoją myśl i grupę.
  Notatki możesz edytować, usuwać i udostępniać jako tekst.
* **Google Docs:** każda czytana pozycja dostaje dokument „Notatki – tytuł”, a grupy są w nim nagłówkami. Twoje ręczne zmiany w dokumencie zostają.
* **Skany:** odczytuje je OCR **ML Kit** na telefonie, offline. Opcjonalnie możesz użyć serwera [Unlimited-OCR](https://github.com/baidu/Unlimited-OCR).
* **Pamięć miejsca:** Lektor pamięta, gdzie skończyłeś, w każdym dokumencie.

## Google Docs: jednorazowa konfiguracja (ok. 2 minuty)

Notatki zapisuje mały skrypt **Google Apps Script** na Twoim koncie. Nie potrzebujesz Google Cloud Console ani kluczy.
Najwygodniej zrobić to na komputerze:

1. W Lektorze stuknij ⚙ → **Google Docs → Skonfiguruj** i wybierz **Wyślij sobie instrukcję z kodem** (np. na e-mail).
   Kod skryptu jest też w repozytorium: [`www/lektor-docs.txt`](www/lektor-docs.txt).
2. Na komputerze otwórz https://script.google.com/home/projects/create, usuń przykładowy kod, wklej skrypt i zapisz.
3. Kliknij **Wdróż → Nowe wdrożenie → Aplikacja internetowa**. Ustaw *Wykonaj jako:* **Ja** i *Kto ma dostęp:* **Każdy**, potem **Wdróż**.
   Zezwól na dostęp: przy ostrzeżeniu „Google nie zweryfikował tej aplikacji” wybierz *Zaawansowane → Otwórz*. To Twój własny skrypt.
4. Skopiuj **adres aplikacji internetowej** i otwórz go na telefonie, a potem stuknij **Otwórz w Lektorze**.
   Możesz też wkleić adres w Lektorze: ⚙ → Google Docs.

Adres skryptu działa jak hasło do Twoich notatek, więc nikomu go nie udostępniaj.
Notatki zrobione przed konfiguracją wyślą się same po połączeniu.

### Alternatywa: logowanie OAuth (zaawansowane)

Zamiast skryptu możesz się zalogować kluczem OAuth z Google Cloud Console. Utwórz klient typu **Android**: pakiet `pl.lektor.app`,
SHA-1 `D7:83:43:62:64:00:F6:5F:AF:86:75:6D:8B:9F:A4:43:64:0D:20:94`. Włącz też *Google Docs API*.

## Budowanie (dla programisty)

APK buduje się automatycznie na GitHubie (`.github/workflows/android.yml`) po każdej zmianie w `android-app/`.
Wynik trafia do *Releases*. Klucz podpisu jest w sekretach `LEKTOR_KEYSTORE_B64` i `LEKTOR_KEYSTORE_PASSWORD`.

```bash
cd android-app
npm install
npm run sync                     # kopiuje pdf.js i www/ do projektu Androida
cd android && ./gradlew assembleRelease
```

Struktura:

```
www/js/app.js        interfejs: biblioteka, widok stron/tekstu, zoom, notatki, ustawienia
www/js/pdfdoc.js     pdf.js: słowa z pozycjami, nagłówki/stopki, render stron
www/js/textproc.js   podział na zdania (PL/EN, skróty), wykrywanie języka
www/js/speech.js     fasada odtwarzacza (natywny / ElevenLabs / przeglądarka), wybór głosu męskiego
www/js/gdocs.js      notatki w Google Docs (Apps Script albo OAuth)
www/lektor-docs.txt  skrypt Apps Script do wdrożenia na koncie Google
www/js/ocr.js        ML Kit + Unlimited-OCR
android/.../Playback.java          kolejka zdań, fokus audio, MediaSession, powiadomienie
android/.../EdgeTts.java           klient głosów Edge (WebSocket), SecMsGec.java – token
android/.../EdgeSpeaker.java       odtwarzanie MP3 z wyprzedzeniem, pamięć podręczna, podświetlanie słów
android/.../SystemTtsSpeaker.java  głosy telefonu (TextToSpeech)
android/.../LektorPlugin.java      most JS ↔ Android, OCR, logowanie Google, pliki z zewnątrz
android/.../TtsService.java        usługa pierwszoplanowa (czytanie w tle)
```

Głosy Edge korzystają z nieoficjalnego interfejsu przeglądarki Microsoft Edge („Czytaj na głos”), tak jak biblioteka
[edge-tts](https://github.com/rany2/edge-tts). Microsoft może go kiedyś zmienić. Wtedy Lektor czyta dalej głosem telefonu,
a naprawa wymaga aktualizacji aplikacji.
