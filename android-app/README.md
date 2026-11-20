# Lektor na Androida

Darmowy czytnik PDF z głosem, w stylu Natural Reader, bez subskrypcji. Działa na telefonie, w tym na Galaxy S26+.

* Otwierasz PDF w aplikacji albo z innej aplikacji: **Udostępnij → Lektor** lub **Otwórz za pomocą → Lektor** (Pliki, Gmail, Dysk).
* Na stronie podświetla się czytane **zdanie** i bieżące **słowo**. Stuknięcie w zdanie zaczyna czytanie od tego miejsca. Przycisk ¶ przełącza na widok samego tekstu.
* Czytanie trwa przy **wygaszonym ekranie**. W powiadomieniu jest przycisk „Pauza”.
* **＋ Notatka** zatrzymuje czytanie i otwiera notatkę: cytat (możesz go rozszerzyć o sąsiednie zdania), twoja myśl i grupa.
  Notatka zapisuje się na telefonie i w **Google Docs**: jeden dokument na czytaną pozycję, grupy to nagłówki.
* Strony skanowane przechodzą przez OCR **ML Kit** na telefonie (offline). Opcjonalnie możesz użyć serwera **Unlimited-OCR**.
* Lektor pamięta miejsce, w którym skończyłeś, w każdym dokumencie.

## Głosy

Lektor korzysta z głosów telefonu, czyli z **Usług Google do zamiany mowy**. Są darmowe, działają offline i mają dobrą jakość.
Domyślnie wybiera głosy **męskie**: polski `pl-pl-x-bmg` (zapasowo `jmk`) i angielski `en-us-x-iom` (zapasowo `tpd`, `iol`).
Inny głos wybierzesz w ⚙ (przycisk „▶ posłuchaj” pozwala go przesłuchać).

Na Samsungu domyślnym silnikiem jest Samsung TTS. Żeby mieć najlepsze głosy:
1. Zainstaluj ze Sklepu Play **„Usługi Google do zamiany mowy”** („Speech Services by Google”), jeśli ich nie ma.
2. W Lektorze otwórz ⚙ → **Pobierz / zmień głosy telefonu…**, wybierz silnik Google i pobierz **polski** oraz **angielski (USA)**.

Opcjonalnie możesz użyć **ElevenLabs**: wpisz w ⚙ swój klucz API. Powyżej darmowego limitu to usługa płatna.
Ten silnik czyta tylko przy włączonym ekranie.

## Instalacja na telefonie

APK buduje się automatycznie na GitHubie (workflow `.github/workflows/android.yml`) po każdej zmianie w `android-app/`.

1. Na telefonie otwórz stronę **Releases** repozytorium. Najnowsze wydanie znajdziesz pod linkiem
   `https://github.com/PawelGwiazdzinski/Egzamin-Psychoterapia/releases/latest`.
   Pobierz **Lektor.apk**. Przy prywatnym repozytorium musisz być zalogowany do GitHuba w przeglądarce.
2. Otwórz pobrany plik. Za pierwszym razem Android poprosi o zgodę na **instalowanie nieznanych aplikacji** z przeglądarki, więc ją wyraź.
3. Kolejne wersje instalujesz tak samo, na starą. Biblioteka i notatki zostają.

## Google Docs: jednorazowa konfiguracja (ok. 5 minut)

1. Wejdź na https://console.cloud.google.com/ i utwórz projekt, np. „Lektor”.
2. W **APIs & Services → Library** włącz **Google Docs API** i **Google Drive API**.
3. W **OAuth consent screen** wybierz typ *External*, wpisz nazwę i swój e-mail, a w **Test users** dodaj swój adres Gmail.
   Żeby Google nie wylogowywał co 7 dni, kliknij później **Publish app**. Do własnego użytku weryfikacja nie jest potrzebna.
4. W **Credentials** wybierz **Create credentials → OAuth client ID → Android**:
   * Package name: `pl.lektor.app`
   * SHA-1: `90:C4:8D:52:4B:2E:A6:FE:3E:91:83:24:72:FB:66:8F:2B:14:C5:2A`
5. W Lektorze otwórz ⚙ → **Połącz z Google Docs** i wybierz swoje konto.

### Klucz podpisu (jednorazowo, przed pierwszym budowaniem)

Logowanie Google wymaga, żeby aplikacja była zawsze podpisana **tym samym kluczem**, bo Google sprawdza jego odcisk SHA-1.
Klucz nie może leżeć w repozytorium, dlatego trzymamy go w **sekrecie GitHuba**:

1. W repozytorium otwórz **Settings → Secrets and variables → Actions → New repository secret**.
2. Dodaj dwa sekrety:
   * `LEKTOR_KEYSTORE_B64`: cała zawartość pliku `LEKTOR_KEYSTORE_B64.txt` (klucz zakodowany w base64),
   * `LEKTOR_KEYSTORE_PASSWORD`: hasło do klucza.
3. Uruchom ponownie workflow **Lektor – Android APK** (zakładka Actions → Run workflow).

Odcisk SHA-1 tego klucza to `90:C4:8D:52:4B:2E:A6:FE:3E:91:83:24:72:FB:66:8F:2B:14:C5:2A` (wpisz go w kroku 4 powyżej).
Własny klucz możesz też wygenerować poleceniem
`keytool -genkeypair -keystore lektor.jks -alias lektor -keyalg RSA -validity 10000` (to samo hasło dla magazynu i klucza),
a potem zakodować go: `base64 -w0 lektor.jks`.
Bez sekretu APK też się zbuduje, ale logowanie Google nie zadziała, a każdą nową wersję trzeba będzie instalować od nowa.

## OCR: Unlimited-OCR (opcjonalnie)

[Unlimited-OCR 2](https://github.com/baidu/Unlimited-OCR) wymaga karty NVIDIA, więc nie uruchomisz go na telefonie.
Możesz postawić go na komputerze z GPU w tej samej sieci Wi-Fi (instrukcja w `reader/README.md`) i wpisać w ⚙ adres,
np. `http://192.168.1.10:10000`. Bez tego skany odczytuje ML Kit na telefonie.

## Budowanie lokalnie (dla programisty)

```bash
cd android-app
npm install
npm run sync              # kopiuje pdf.js i www/ do projektu Androida
cd android && ./gradlew assembleRelease
# test w przeglądarce (bez funkcji natywnych):
npx http-server www -p 8080
```

Struktura:

```
www/js/app.js        interfejs, odtwarzanie, notatki
www/js/pdfdoc.js     pdf.js: słowa z pozycjami, nagłówki/stopki, render stron
www/js/textproc.js   podział na zdania (PL/EN, skróty), wykrywanie języka
www/js/speech.js     silniki mowy (Android TTS / ElevenLabs / przeglądarka), wybór głosu męskiego
www/js/gdocs.js      zapis notatek w Google Docs
www/js/ocr.js        ML Kit + Unlimited-OCR
android/app/src/main/java/pl/lektor/app/LektorPlugin.java   TTS, OCR, logowanie Google, udostępnianie
android/app/src/main/java/pl/lektor/app/TtsService.java     czytanie w tle (powiadomienie)
```
