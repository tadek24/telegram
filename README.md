# Komunikator PWA

Markowy komunikator React/Vite z niewidocznym dla użytkownika silnikiem wiadomości, szyfrowaniem Rust Crypto i logowaniem OIDC Authorization Code Flow z PKCE.

## Bezpłatny tryb lokalny

Przy `VITE_ENABLE_DEMO_MODE=true` aplikacja zapisuje profil, kontakty, grupy, tekstowe rozmowy i wybrane avatary w IndexedDB bieżącego urządzenia. Dane nie są wysyłane do Google ani do zewnętrznej bazy. Każdy numer telefonu otrzymuje oddzielny lokalny profil.

Ten tryb nie synchronizuje danych pomiędzy telefonami. Służy do bezpłatnych testów interfejsu przed uruchomieniem prywatnego serwera.

Kontakty i rozmowy widoczne w demonstracji są wyłącznie lokalnymi danymi przykładowymi. Nie oznaczają kont istniejących na serwerze i nie można przez nie kontaktować się z innym telefonem.

## Import archiwum z Telegrama

W lewym menu znajduje się pozycja **Archiwum Telegrama**. Użytkownik może w Telegram Desktop wyeksportować rozmowy w formacie JSON, a następnie wskazać plik `result.json` w komunikatorze. Import jest jednokierunkowy i służy wyłącznie do odczytu: aplikacja nie loguje się do Telegrama, nie wysyła do niego danych i nie pozwala Telegramowi pobierać nowych rozmów.

Plik jest analizowany w osobnym Web Workerze i zapisywany w IndexedDB tylko na bieżącym urządzeniu, osobno dla każdego konta. Import przyjmuje pliki JSON do 100 MB, ogranicza liczbę i długość przetwarzanych elementów oraz nigdy nie renderuje treści jako HTML. Zdjęcia i inne media nie są zawarte w samym pliku JSON — obecna wersja pokazuje ich bezpieczne odwołania z eksportu, ale nie przesyła plików multimedialnych na serwer.

Rozmowy komunikatora można archiwizować pojedynczo albo hurtowo. Tryb zaznaczania pozwala także przywrócić rozmowy z archiwum lub usunąć wiele z nich ze swojego konta. Usunięcie nie kasuje kopii należących do innych uczestników.

## Test prawdziwej rozmowy telefon + PIN

Flaga `VITE_ENABLE_PHONE_MATRIX_LOGIN=true` włącza prosty formularz numeru telefonu i PIN-u. Numer jest normalizowany do cyfr i wewnętrznie mapowany na bezpieczną nazwę `phone_<cyfry>`. Techniczne identyfikatory i adresy nie są prezentowane użytkownikowi. PIN służy wyłącznie do bieżącego żądania logowania i nie jest zapisywany w `localStorage` ani IndexedDB.

Projekt nie zawiera logowania SMS ani integracji z dostawcą SMS. W konfiguracji testowej konto jest tworzone przy pierwszym logowaniu, a użytkownik ustala wtedy własny PIN lub hasło mające minimum 8 znaków. Przy tworzeniu nowego konta trzeba dodatkowo podać wspólny kod dostępu wygenerowany na komputerze właściciela serwera. Istniejące konto loguje się później samym numerem i swoim PIN-em. Sam numer telefonu nigdy nie jest sekretem.

Kod dostępu ogranicza tworzenie kont do zaproszonych osób, ale nie potwierdza własności numeru telefonu. Nie należy wkładać kodu ani PIN-u do adresu URL: adresy są zapisywane w historii, logach, analityce i mogą zostać przypadkowo udostępnione. Ten przepływ jest przeznaczony wyłącznie do zamkniętych testów.

W tym trybie nową prywatną rozmowę rozpoczyna się przez podanie numeru telefonu drugiej osoby. Pokój, wiadomości i media nadal korzystają z istniejącego szyfrowania end-to-end.

Osoba, która utworzyła grupę, zostaje jej administratorem. Tylko administrator może zmieniać nazwę i avatar grupy, zapraszać osoby zapisane w lokalnych kontaktach oraz włączyć krótki kod umożliwiający dołączenie. Kod ma format `XXXX-XXXX`, nie ujawnia technicznego adresu pokoju i nie jest publikowany w katalogu. Osoba wpisująca kod musi mieć konto na tym samym prywatnym serwerze. Wyłączenie kodu przywraca tryb wyłącznie na zaproszenie. Każdy członek grupy może zobaczyć listę uczestników, ale nie otrzymuje dostępu do ustawień administratora.

Usunięcie rozmowy prywatnej lub opuszczenie grupy usuwa ją tylko z konta wykonującego tę operację. Nie kasuje kopii rozmowy ani grupy pozostałym uczestnikom.

Wiadomości, pokoje i zaszyfrowane media są synchronizowane przez prywatny serwer. Treść zaszyfrowanych rozmów jest odszyfrowywana w przeglądarce. Serwer nadal widzi metadane potrzebne do działania usługi, np. konta, uczestników pokoju, czasy zdarzeń, adresy IP oraz rozmiary danych. Klucze szyfrowania, token sesji urządzenia i zaszyfrowana pamięć synchronizacji pozostają w IndexedDB danej aplikacji, dzięki czemu zamknięcie jej okna nie wylogowuje użytkownika, a lista rozmów nie musi być za każdym razem pobierana od zera. Lokalne nazwy i avatary kontaktów, opis profilu oraz wybrany motyw są zapisane w IndexedDB i nie synchronizują się między przeglądarkami. Nazwa konta i avatar profilu są zapisywane na serwerze. Opcjonalne powiadomienia push przekazują tylko ogólną informację o nowej wiadomości, bez treści rozmowy, i są włączane osobno na każdym urządzeniu.

Gotowa konfiguracja lokalnego serwera testowego, rejestracja przy pierwszym logowaniu oraz instrukcja tymczasowego tunelu HTTPS znajdują się w [`infra/matrix/README.md`](infra/matrix/README.md).

## Uruchomienie lokalne

1. Skopiuj `.env.example` do `.env.local`.
2. Uzupełnij publiczną konfigurację środowiska.
3. Uruchom `npm install`, a następnie `npm run dev`.

Zmienne `VITE_*` trafiają do publicznego pakietu aplikacji. Nie wolno umieszczać w nich client secretów, tokenów, haseł ani kluczy prywatnych.

Przy pierwszym uruchomieniu aplikacja pokazuje instrukcję dodania jej do ekranu głównego telefonu w Chrome na Androidzie lub Safari na iPhonie/iPadzie. Instrukcję można później otworzyć ponownie z ekranu logowania.

Specjalny link instalacyjny ma postać `https://adres-aplikacji/?install=1`. Na Androidzie w Chrome pokazuje przycisk instalacji, gdy przeglądarka potwierdzi gotowość aplikacji. Na iPhonie otwiera instrukcję Safari: Udostępnij → Do ekranu początkowego. Systemy mobilne wymagają jednego potwierdzenia użytkownika, dlatego instalacji nie można rozpocząć całkowicie automatycznie bez dotknięcia przycisku. Z poziomu instrukcji można skopiować lub udostępnić aktualny link instalacyjny.

## Konfiguracja produkcyjna

- `VITE_MATRIX_HOMESERVER_URL` — publiczny adres homeservera.
- `VITE_AUTH_ISSUER` — issuer prywatnego Matrix Authentication Service.
- `VITE_AUTH_CLIENT_ID` — identyfikator publicznego klienta SPA zarejestrowanego w MAS, bez client secretu.
- `VITE_AUTH_REDIRECT_URI` — dokładny HTTPS callback zarejestrowany w MAS, np. ścieżka `/auth/callback` w domenie aplikacji.
- `VITE_ENABLE_DEV_LOGIN` — w produkcji zawsze `false`.
- `VITE_ENABLE_PHONE_MATRIX_LOGIN` — testowe logowanie numerem telefonu i PIN-em do prywatnego serwera.

MAS musi zezwalać na Authorization Code Flow z PKCE (`S256`), dokładny redirect URI aplikacji oraz zakresy wymagane przez SDK. Synapse musi delegować uwierzytelnianie do tego samego issuera. Docelowe domeny należą do konfiguracji środowiska, nie do kodu.

## Uwierzytelnianie i sesja

Aplikacja korzysta z oficjalnych funkcji `matrix-js-sdk` do discovery OIDC, utworzenia żądania PKCE/state/nonce, obsługi callbacku, walidacji tokenu i odświeżania sesji. Token urządzenia jest przechowywany w IndexedDB aplikacji i usuwany przy świadomym wylogowaniu. PIN ani hasło nie są zapisywane.

Gdy konfiguracja produkcyjna jest niepełna, aplikacja pokazuje „Logowanie jest obecnie konfigurowane” i nie rozpoczyna pozornego przepływu.

## Tryb deweloperski

Techniczny formularz testowy jest ładowany dynamicznie tylko przy `VITE_ENABLE_DEV_LOGIN=true`. Ustawienie służy wyłącznie lokalnym testom z kompatybilnym serwerem. Domyślna i produkcyjna konfiguracja pozostawia je wyłączone.

## Wdrożenie

`vercel.json` zawiera fallback SPA i CSP zgodne z OIDC, WebAssembly, Web Workers oraz połączeniami do konfigurowalnego homeservera. Publiczne zmienne środowiskowe ustaw osobno w panelu Vercela. Publiczny klient SPA z PKCE nie korzysta z client secretu.

## Obecny zakres

Działa logowanie numerem telefonu i PIN-em, przywracanie i czyszczenie sesji, synchronizacja szyfrowanych pokoi, wiadomości tekstowe, media i załączniki, lokalne kontakty, ustawienia profilu, motywy, tworzenie grup, zmiana ich nazwy i avatara przez administratora, lista członków, zapraszanie kontaktów, krótkie kody dołączenia, opuszczanie i usuwanie rozmów ze swojego konta oraz bezpieczne powiadomienia push bez podglądu treści. Rozmowy głosowe i wideo pozostają poza obecnym zakresem.
