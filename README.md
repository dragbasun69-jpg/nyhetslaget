# Nyhetsläget

Nyheter från Sverige, Skåne och världen samlade på ett ställe. Sajten uppdateras automatiskt varje timme, kan sorteras på ämne och källa, har sökfält, uppläsning och ett nyhetsquiz varje måndag.

Sajten: https://dragbasun69-jpg.github.io/nyhetslaget/

## Källor och ämnen

Källorna står i `sources.json`. Varje källa har ett ämne (`category`): Sverige, Världen, Lokalt, Ekonomi, Vetenskap eller Sport. `"paywall": true` ger en 🔒 vid länken. Sätt `"enabled": false` för att pausa en källa.

Längst ner på sajten står vilka källor som inte gick att hämta.

## Hur det fungerar

- `scripts/fetch-news.mjs` hämtar flödena varje timme (GitHub Actions) och skriver `data/news.json` (de senaste 3 dagarna) och `data/archive.json` (en vecka, för quizet).
- `scripts/make-quiz.mjs` gör veckans quiz. Utan API-nyckel görs det av en schemalagd Claude-uppgift på måndagar.
- Sidan publiceras med GitHub Pages (Settings → Pages → Source: GitHub Actions).

## Filer

| Fil | Vad den gör |
|---|---|
| `index.html`, `style.css`, `app.js` | Nyhetssidan |
| `quiz.html`, `quiz-render.js` | Quizsidan, elev- och lärarversion |
| `about.html` | Om sidan |
| `sources.json` | Källor och ämnen |
| `.github/workflows/update-news.yml` | Hämtning varje timme och publicering |
