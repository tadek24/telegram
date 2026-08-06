# Komunikatr E-Prom — bezpłatna wersja testowa

## Co zostało dodane

- trwałe lokalne kontakty rozdzielone według numeru telefonu;
- dodawanie, edycja i usuwanie kontaktów;
- avatar kontaktu, profilu i grupy;
- ustawienia konta: nazwa, opis, powiadomienia i podgląd wiadomości;
- zmiana lokalnej nazwy kontaktu oraz nazwy grupy;
- trwały zapis grup, tekstowych rozmów i załączników w IndexedDB;
- automatyczny jasny lub ciemny motyw systemowy;
- bezpłatny tryb produkcyjny bez przekierowania do publicznego Matrixa;
- brak integracji z Google.

## Jak uruchomić

1. Rozpakuj paczkę.
2. Otwórz terminal w rozpakowanym folderze.
3. Uruchom `npm install`.
4. Uruchom `npm run dev`.
5. Zaloguj się dowolnym numerem i użyj kodu testowego `246810`.

## Jak wgrać na Vercel

Wgraj zawartość folderu do repozytorium GitHub połączonego z projektem Vercel. Konfiguracja budowania znajduje się w `vercel.json`, a bezpłatny tryb lokalny w `.env.production`.

## Ograniczenia wersji bezpłatnej

- dane są przechowywane tylko w przeglądarce konkretnego telefonu lub komputera;
- wyczyszczenie danych witryny usuwa lokalne kontakty i rozmowy;
- dane nie synchronizują się pomiędzy urządzeniami;
- PIN `246810` służy wyłącznie do lokalnego trybu demonstracyjnego;
- dwóch użytkowników na różnych telefonach nie wymienia jeszcze prawdziwych wiadomości.

Prawdziwe rozmowy między telefonami wymagają uruchomienia prywatnego serwera. Konta testowe używają PIN-ów lub haseł ustawianych ręcznie; projekt nie wdraża kodów ani integracji SMS.
