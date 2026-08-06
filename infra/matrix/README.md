# Prywatny serwer testowy rozmów

Ten katalog przygotowuje bezpłatny, lokalny serwer wyłącznie do testów rozmów. Używa oficjalnego obrazu Synapse, SQLite, szyfrowanych pokoi klienta oraz małej usługi tworzącej konto przy pierwszym logowaniu. Nie jest to konfiguracja produkcyjna.

## Wymagania

- Windows i uruchomiony Docker Desktop;
- PowerShell;
- `cloudflared` do udostępnienia serwera przez stały tunel HTTPS.

Skrypt nie instaluje żadnego oprogramowania systemowego.

## 1. Przygotowanie serwera

W katalogu projektu uruchom:

```powershell
powershell -ExecutionPolicy Bypass -File .\infra\matrix\setup-test-server.ps1
```

Skrypt nie pyta o numery ani PIN-y. Generuje natomiast losowy kod dostępu dla zaufanych osób i pokazuje go w terminalu po uruchomieniu. Numer jest normalizowany do cyfr i wewnętrznie mapowany na konto `phone_<cyfry>` dopiero podczas pierwszego logowania. Użytkownik podaje wtedy kod dostępu oraz sam ustala PIN lub hasło mające co najmniej 8 znaków. Przy kolejnych logowaniach do istniejącego konta używa już numeru i własnego PIN-u, bez kodu dostępu. PIN nie jest zapisywany przez aplikację ani usługę rejestracji.

W tej wersji testowej lista numerów nie jest ograniczona. Kod dostępu blokuje samodzielne tworzenie kont przez osoby spoza testu, ale nie weryfikuje własności numeru. Zaufana osoba znająca kod nadal może jako pierwsza zająć dowolny numer, dlatego rozwiązanie nadaje się wyłącznie do zamkniętych testów. Kodu dostępu ani PIN-u nie wolno umieszczać w adresie URL — taki sekret wycieka do historii przeglądarki, logów i udostępnianych linków.

Wygenerowana konfiguracja, baza SQLite, klucze, kod dostępu i losowy sekret rejestracji trafiają do ignorowanego katalogu `infra/matrix/data/`. Publiczny interfejs rejestracji serwera, statystyki, publiczne pokoje i federacja są wyłączone, a limit mediów wynosi 25 MB. Oddzielna usługa testowa może tworzyć wyłącznie zwykłe konta o nazwach wynikających z numerów telefonu; sekret administracyjny nigdy nie trafia do przeglądarki.

Ponowne uruchomienie:

```powershell
docker compose -f .\infra\matrix\docker-compose.yml up -d
```

Pierwsze uruchomienie po dodaniu powiadomień może potrwać chwilę dłużej, ponieważ Docker buduje małą prywatną bramkę powiadomień. Jej klucze i przypisania telefonów są zapisywane wyłącznie w ignorowanym katalogu `infra/matrix/data/`. Serwer nie wkłada treści zaszyfrowanej wiadomości do powiadomienia.

Zatrzymanie bez usuwania danych:

```powershell
docker compose -f .\infra\matrix\docker-compose.yml stop
```

### Późniejsza zmiana kodu dostępu

W katalogu projektu uruchom:

```powershell
powershell -ExecutionPolicy Bypass -File .\infra\matrix\set-access-code.ps1
```

Skrypt poprosi o nowy kod w niewidocznym polu. Kod nie pojawi się w historii poleceń i zacznie działać od razu dla nowych rejestracji. Zmiana nie wpływa na istniejące konta ani ich PIN-y. Jawna wartość znajduje się wyłącznie w ignorowanym przez Git pliku `infra/matrix/data/registration-access-code` na komputerze z serwerem.

### Zmiana kluczy po przypadkowym ujawnieniu

Jeżeli katalog danych serwera został omyłkowo wysłany do publicznego repozytorium, uruchom w katalogu projektu:

```powershell
powershell -ExecutionPolicy Bypass -File .\infra\matrix\rotate-exposed-secrets.ps1
```

Skrypt tworzy lokalną kopię bezpieczeństwa, zmienia sekrety rejestracji i sesji, kod dostępu, klucz podpisujący serwera oraz klucz powiadomień, a następnie sprawdza ponowne uruchomienie usług. Nie usuwa kont, wiadomości ani załączników. Kopia oraz nowe sekrety pozostają wyłącznie w ignorowanym katalogu `infra/matrix/data/`. Po zmianie klucza powiadomień trzeba ponownie włączyć powiadomienia na każdym telefonie.

## 2. Stały tunel HTTPS Cloudflare

W skonfigurowanym środowisku tunel `eprom-serwer` działa jako automatyczna usługa Windows i udostępnia serwer pod stałym adresem:

```text
https://serwer.webspanner.pl
```

Tunel kieruje ruch do `http://127.0.0.1:8008`. Nie trzeba zmieniać adresu w Vercel po ponownym uruchomieniu komputera. Docker Desktop, kontenery serwera i usługa `cloudflared` nadal muszą działać, a komputer musi pozostać włączony podczas rozmowy.

Jeśli stały tunel nie został jeszcze skonfigurowany, do krótkiej diagnostyki można awaryjnie użyć `cloudflared tunnel --url http://127.0.0.1:8008`. Adres `trycloudflare.com` jest jednak tymczasowy i nie powinien być wpisywany jako docelowa konfiguracja aplikacji.

## 3. Zmienne środowiskowe Vercel

Ustaw dokładnie:

```text
VITE_MATRIX_HOMESERVER_URL=https://serwer.webspanner.pl
VITE_ENABLE_PHONE_MATRIX_LOGIN=true
VITE_ENABLE_DEMO_MODE=false
VITE_ENABLE_MATRIX_SSO=false
VITE_ENABLE_DEV_LOGIN=false
```

Następnie wykonaj ponowne wdrożenie aplikacji. W żadnej zmiennej `VITE_*` nie umieszczaj PIN-u, hasła, tokenu, shared secretu ani innego sekretu — wartości `VITE_*` są publiczne w kodzie przeglądarki.

## 4. Powiadomienia na telefonie

Po ponownym uruchomieniu serwera i wdrożeniu aktualnej aplikacji użytkownik wchodzi w **Ustawienia konta** i wybiera **Włącz powiadomienia**. System telefonu pokaże własne pytanie o zgodę. Ustawienie trzeba wykonać osobno na każdym urządzeniu; wylogowanie wyłącza powiadomienia na danym urządzeniu.

- Android: powiadomienia działają w obsługiwanej przeglądarce i w zainstalowanej aplikacji PWA.
- iPhone/iPad: aplikację trzeba najpierw dodać z Safari do ekranu początkowego, uruchomić z ikony, a następnie włączyć powiadomienia w ustawieniach konta. Wymagany jest iOS/iPadOS 16.4 lub nowszy.
- Komputer z Dockerem, prywatny serwer i tunel Cloudflare muszą pozostać uruchomione, aby serwer mógł wykryć nową wiadomość.

Na ekranie blokady pojawia się wyłącznie ogólny tekst „Masz nową wiadomość”. PIN, treść rozmowy ani klucze szyfrowania nie są wysyłane w powiadomieniu. Dostarczenie korzysta z systemowej usługi Web Push producenta przeglądarki lub telefonu, a ładunek powiadomienia jest szyfrowany dla konkretnego urządzenia.

Nie trzeba dodawać żadnej nowej zmiennej w Vercel. Klucz publiczny powiadomień aplikacja pobiera z prywatnego serwera, a klucz prywatny pozostaje na komputerze w ignorowanym katalogu danych.

## Ważne ograniczenia testu

- stały adres tunelu nie zmienia się po ponownym uruchomieniu komputera;
- przy pierwszym logowaniu trzeba podać kod dostępu wyświetlony przez skrypt; konto zostaje wtedy utworzone, a podany PIN lub hasło staje się jego stałym hasłem;
- kod dostępu przekazuj wyłącznie zaufanym osobom i nie umieszczaj go w zmiennych `VITE_*` ani w adresie URL;
- PIN lub hasło musi mieć minimum 8 znaków i nie wolno używać samego numeru jako sekretu;
- kod dostępu ogranicza rejestrację, ale bez weryfikacji numeru pierwsza zaufana osoba rejestrująca dany numer przejmuje konto testowe;
- komputer, Docker Desktop, kontener i tunel muszą działać podczas rozmowy;
- konfiguracja z SQLite i tunelem na komputerze użytkownika służy wyłącznie do testów, a nie do zastosowań produkcyjnych.
