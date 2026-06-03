// ============================================================
// Passerelle KI-Proxy — Cloudflare Worker
// ============================================================
// Versionierte Kopie des produktiven Workers, der unter
//   https://passerelle-ai-proxy.questside.workers.dev
// läuft und vom Frontend (passerelle_lerntool.html) angesprochen wird.
//
// Drei Modi (Body-Feld "mode"):
//   "analyze"     → Lernstoff-Text  → { subjects: {...} }
//   "flashcards"  → Lernziele       → { cards: [...] }
//   "quiz"        → Lernziele       → { questions: [...] }
// Default (kein/unbekanntes mode) = "analyze" (rückwärtskompatibel).
//
// Härtung (siehe README.md):
//   - Rate-Limit pro IP (Token-Bucket, 10 Anfragen / 60 s)
//   - Origin-Check (nur erlaubte Domains erhalten ihren Origin zurück)
//   - Eingabe-Längenlimit (10 000 Zeichen)
//   - Einheitliches Fehlerformat { "error": "…" }
//   - GROQ_API_KEY ausschliesslich als wrangler-Secret (nie im Code)
//
// WICHTIG: Das Response-Format ist byte-kompatibel zum Frontend. Erst
// Kompatibilität, dann Härtung — Erfolgsantworten NICHT umformen.
// ============================================================

const ANALYZE_PROMPT = `Du bist ein Lernstoff-Analyst für Schweizer Passerelle-Prüfungen.
Analysiere den folgenden Text und extrahiere eine verschachtelte Lernziel-Hierarchie.
Ordne alles den 8 Passerelle-Fächern zu:
Deutsch, Englisch, Mathematik, Biologie, Chemie, Physik, Geografie, Geschichte.

Erkenne pro Fach die Struktur Thema → Lernziel → Unter-Lernziel:
- "name"     = das übergeordnete Thema/Kapitel (z.B. "Zellatmung")
- "lernziele"= konkrete Lernziele zum Thema (z.B. "Glykolyse erklären")
- "sub"      = optionale Unter-Lernziele/Teilschritte (z.B. "ATP-Bilanz angeben")

Klassifiziere jedes Thema nach Wichtigkeit:
- A = Pflicht (in SBFI-Richtlinien explizit genannt, prüfungsrelevant)
- B = Wichtig (in Richtlinien erwähnt, aber nicht jährlich geprüft)
- C = Optional (im Lehrmittel, aber nicht in Richtlinien)

Antworte ausschliesslich mit validem JSON in diesem Format:
{
  "subjects": {
    "Biologie": [
      { "name": "Zellatmung", "level": "A",
        "lernziele": [
          { "text": "Glykolyse erklären", "sub": [ { "text": "ATP-Bilanz angeben" } ] },
          { "text": "Citratzyklus beschreiben", "sub": [] }
        ] }
    ]
  }
}

Regeln:
- Nur die 8 genannten Fächer verwenden
- Themennamen kurz und präzise (max 60 Zeichen), Lernziele max 100 Zeichen
- Wenn der Text keine Unter-Lernziele hergibt: "sub": [] (leeres Array)
- Wenn der Text keine Lernziele hergibt: "lernziele": [] und nur das Thema behalten
- Fächer ohne erkannte Themen weglassen
- Keine Erklärungen, nur JSON`;

const FLASHCARDS_PROMPT = `Du bist Lerncoach für Schweizer Passerelle-Prüfungen.
Erstelle Karteikarten (Frage/Antwort) AUSSCHLIESSLICH aus den vom Lernenden erfassten Lernzielen.
Erfinde keine Themen, die nicht aus den Lernzielen ableitbar sind.

Niveau: Schweizer Passerelle (Ergänzungsprüfung Berufsmaturität → Universität), deutsche Fachsprache.
- Jede Karte prüft GENAU ein Lernziel oder Unter-Lernziel.
- "front" = präzise Frage/Aufgabe; "back" = korrekte, knappe Fachantwort (1–4 Sätze).
- Decke alle übergebenen Lernziele ab; pro Lernziel 1–2 Karten.

Antworte ausschliesslich mit validem JSON:
{ "cards": [ { "front": "...", "back": "..." } ] }
Keine Erklärungen ausserhalb des JSON.`;

const QUIZ_PROMPT = `Du bist Prüfungsexperte für Schweizer Passerelle-Prüfungen.
Erstelle prüfungsnahe Testfragen AUSSCHLIESSLICH aus den vom Lernenden erfassten Lernzielen.
Erfinde keine Themen ausserhalb der Lernziele.

Niveau: Schweizer Passerelle (Universitäts-Zugang), deutsche Fachsprache, realistische Prüfungsschwierigkeit.
- Mische Fragetypen: "mc" (Multiple Choice, 4 Optionen, genau eine richtig) und "open" (Kurzantwort).
- Jede Frage verankert an einem Lernziel ("lernzielRef" = der Lernziel-Text).
- Bei "mc": "options" = Array mit 4 Strings, "answer" = exakter Text der richtigen Option.
- Bei "open": "options" weglassen, "answer" = Musterlösung (knapp).
- "explanation" = kurze Begründung (1–2 Sätze).

Antworte ausschliesslich mit validem JSON:
{ "questions": [
  { "type": "mc", "q": "...", "options": ["A","B","C","D"], "answer": "B", "explanation": "...", "lernzielRef": "..." },
  { "type": "open", "q": "...", "answer": "...", "explanation": "...", "lernzielRef": "..." }
] }
Keine Erklärungen ausserhalb des JSON.`;

// Baut den User-Inhalt für flashcards/quiz aus den übergebenen Lernzielen.
function buildLernzielContent(subject, topic, lernziele) {
  const lines = [];
  (lernziele || []).forEach((lz) => {
    const t = typeof lz === 'string' ? lz : (lz && lz.text);
    if (!t) return;
    lines.push('- ' + t);
    const subs = (lz && lz.sub) || [];
    subs.forEach((s) => {
      const st = typeof s === 'string' ? s : (s && s.text);
      if (st) lines.push('  · ' + st);
    });
  });
  return `Fach: ${subject || '–'}\nThema: ${topic || '–'}\nLernziele:\n${lines.join('\n')}`;
}

const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 10;
const MAX_TEXT_LENGTH = 10000;

const rateLimitMap = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.start > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(ip, { start: now, count: 1 });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

function corsHeaders(origin, allowed) {
  const isAllowed = origin === allowed || origin === 'http://localhost:8080' || origin?.startsWith('file://');
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const headers = corsHeaders(origin, env.ALLOWED_ORIGIN);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405, headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    if (isRateLimited(ip)) {
      return new Response(JSON.stringify({ error: 'Zu viele Anfragen. Bitte 1 Minute warten.' }), {
        status: 429, headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    try {
      const body = await request.json();
      const mode = (body.mode === 'flashcards' || body.mode === 'quiz') ? body.mode : 'analyze';

      let systemPrompt, userContent, maxTokens;

      if (mode === 'analyze') {
        const text = body.text;
        if (!text || typeof text !== 'string' || text.trim().length === 0) {
          return new Response(JSON.stringify({ error: 'Kein Text angegeben.' }), {
            status: 400, headers: { ...headers, 'Content-Type': 'application/json' },
          });
        }
        if (text.length > MAX_TEXT_LENGTH) {
          return new Response(JSON.stringify({ error: `Text zu lang (max ${MAX_TEXT_LENGTH} Zeichen).` }), {
            status: 400, headers: { ...headers, 'Content-Type': 'application/json' },
          });
        }
        systemPrompt = ANALYZE_PROMPT;
        userContent = text;
        maxTokens = 4096;
      } else {
        // flashcards | quiz
        const lernziele = Array.isArray(body.lernziele) ? body.lernziele : [];
        if (lernziele.length === 0) {
          return new Response(JSON.stringify({ error: 'Keine Lernziele angegeben.' }), {
            status: 400, headers: { ...headers, 'Content-Type': 'application/json' },
          });
        }
        userContent = buildLernzielContent(body.subject, body.topic, lernziele);
        if (userContent.length > MAX_TEXT_LENGTH) {
          return new Response(JSON.stringify({ error: `Zu viele Lernziele (max ${MAX_TEXT_LENGTH} Zeichen).` }), {
            status: 400, headers: { ...headers, 'Content-Type': 'application/json' },
          });
        }
        systemPrompt = mode === 'flashcards' ? FLASHCARDS_PROMPT : QUIZ_PROMPT;
        maxTokens = mode === 'flashcards' ? 3072 : 4096;
      }

      const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
          response_format: { type: 'json_object' },
          temperature: mode === 'analyze' ? 0.1 : 0.4,
          max_tokens: maxTokens,
        }),
      });

      if (!groqResponse.ok) {
        const status = groqResponse.status;
        if (status === 401) {
          return new Response(JSON.stringify({ error: 'KI-Dienst Authentifizierung fehlgeschlagen.' }), {
            status: 502, headers: { ...headers, 'Content-Type': 'application/json' },
          });
        }
        if (status === 429) {
          return new Response(JSON.stringify({ error: 'KI-Dienst überlastet. Bitte später versuchen.' }), {
            status: 429, headers: { ...headers, 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ error: 'KI-Dienst vorübergehend nicht erreichbar.' }), {
          status: 502, headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }

      const groqData = await groqResponse.json();
      const content = groqData.choices?.[0]?.message?.content;

      if (!content) {
        return new Response(JSON.stringify({ error: 'Leere Antwort vom KI-Dienst.' }), {
          status: 502, headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }

      const parsed = JSON.parse(content);

      return new Response(JSON.stringify(parsed), {
        status: 200, headers: { ...headers, 'Content-Type': 'application/json' },
      });

    } catch (e) {
      return new Response(JSON.stringify({ error: 'Verarbeitungsfehler. Bitte erneut versuchen.' }), {
        status: 500, headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }
  },
};
