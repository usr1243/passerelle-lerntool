# Passerelle KI-Proxy (Cloudflare Worker)

Server-seitiger Proxy zwischen dem Frontend (`passerelle_lerntool.html`) und der
Groq-API. Hält den Groq-API-Key geheim (nie im Browser), erzwingt Rate-Limit,
Origin-Check und Eingabe-Limits.

- **Produktiv:** `https://passerelle-ai-proxy.questside.workers.dev`
- **Modell:** `llama-3.3-70b-versatile` (Groq), `response_format: json_object`

## Schnittstelle

`POST /` mit JSON-Body. Feld `mode` wählt die Funktion (Default `analyze`).

| mode | Request-Body | Erfolgs-Response | Frontend-Verbraucher |
|------|--------------|------------------|----------------------|
| `analyze` | `{ "mode": "analyze", "text": "<Lernstoff>" }` | `{ "subjects": { … } }` | `mergeAiResults()` |
| `flashcards` | `{ "mode": "flashcards", "subject", "topic", "lernziele": [{text, sub:[{text}]}] }` | `{ "cards": [{front, back}] }` | `startFlashcards()` |
| `quiz` | `{ "mode": "quiz", "subject", "topic", "lernziele": […] }` | `{ "questions": [{type, q, options?, answer, explanation, lernzielRef}] }` | `startQuiz()` |

Die genauen Response-Strukturen sind als JSON-Schema in [`../shared/`](../shared/)
hinterlegt (`schema.analyze.json`, `schema.flashcards.json`, `schema.quiz.json`)
— gemeinsame Quelle der Wahrheit für Worker und Frontend.

**Fehler** (jeder Status ≠ 200) kommen einheitlich als `{ "error": "<Text>" }`.
Das Frontend zeigt `data.error` direkt an.

> ⚠️ **Kompatibilität:** Das Erfolgs-Response-Format darf NICHT verändert werden,
> sonst bricht das ausgelieferte Frontend. Erst Kompatibilität, dann Härtung.

## Deploy

Voraussetzung: Cloudflare-Account, `npx wrangler login`.

```bash
cd worker

# 1) Groq-API-Key als Secret setzen (landet NICHT im Code/Repo):
npx wrangler secret put GROQ_API_KEY
#    → Key bei Aufforderung einfügen

# 2) Erlaubten Origin prüfen/anpassen in wrangler.toml ([vars] ALLOWED_ORIGIN)

# 3) Deployen:
npx wrangler deploy
```

Lokaler Test: `npx wrangler dev` (erlaubt zusätzlich Origin `http://localhost:8080`
und `file://…`).

## Härtungsmassnahmen (umgesetzt)

| Massnahme | Umsetzung | Wie getestet |
|-----------|-----------|--------------|
| **Secret-Schutz** | `GROQ_API_KEY` nur als wrangler-Secret (`env.GROQ_API_KEY`), nie im Code/README/Response | `git grep` nach `gsk_` → keine Treffer; Key erscheint in keiner Antwort |
| **Rate-Limit pro IP** | Token-Bucket: 10 Anfragen / 60 s je `cf-connecting-ip` → `429` | 11 schnelle Requests → 11. Antwort `{error:"Zu viele Anfragen…"}` |
| **Origin-Check** | Nur `ALLOWED_ORIGIN`, `localhost:8080`, `file://` bekommen ihren Origin in `Access-Control-Allow-Origin`; sonst Fallback auf `ALLOWED_ORIGIN` | Request mit fremdem `Origin` → kein passender CORS-Header |
| **Eingabe-Längenlimit** | `text` bzw. zusammengebauter Lernziel-Inhalt ≤ 10 000 Zeichen → `400` | 10 001-Zeichen-Text → `{error:"Text zu lang…"}` |
| **Einheitliche Fehler** | Alle Fehlerpfade liefern `{error}` + passenden Status (400/405/429/502/500) | Methode `GET` → `405`; Groq-401 → `502` mit `{error}` |
| **Methoden-Whitelist** | Nur `POST` (und `OPTIONS`-Preflight); sonst `405` | s. o. |

### Optionale weitere Härtung (dokumentiert, nicht aktiviert)

- **Persistenter Rate-Limit über Cloudflare KV** statt In-Memory-`Map`. Der aktuelle
  Token-Bucket lebt pro Worker-Isolate und wird beim Recycling zurückgesetzt — für
  ein Schüler-Tool ausreichend, aber KV macht das Limit global durchsetzbar.
  KV-Namespace anlegen, in `wrangler.toml` als `RATE_LIMIT` binden (Vorlage dort
  auskommentiert), und `isRateLimited()` auf `env.RATE_LIMIT.get/put` umstellen.
- **Striktere Origin-Allowlist** (Array statt Einzelwert), falls eine Custom-Domain
  dazukommt.
- **Antwort-Schema-Validierung** gegen `../shared/*.json` vor dem Zurückgeben.
  Bewusst nicht aktiviert, um Byte-Kompatibilität zu garantieren — das Frontend
  filtert bereits defensiv (`cards` auf `front && back`, `questions` auf `q && answer`).

## Hinweis

`src/index.js` ist die versionierte Kopie des produktiv laufenden Workers. Änderungen
hier wirken erst nach erneutem `npx wrangler deploy`.
