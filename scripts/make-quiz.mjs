// Skapar veckans nyhetsquiz med Claude (Anthropics API) utifrån data/archive.json.
// Resultat: data/quiz/<id>.json, data/quiz/index.json och PDF:er i quiz/.
//
// Körs av GitHub Actions. Ett nytt quiz skapas en gång per vecka, från måndag kl. 06.
//
//   node scripts/make-quiz.mjs                 skapar veckans quiz om det saknas
//   FORCE_QUIZ=1 node scripts/make-quiz.mjs    skapar om veckans quiz
//   node scripts/make-quiz.mjs --input fil.json   använder färdiga frågor i stället för AI
//   node scripts/make-quiz.mjs --render 2026-v47  gör om PDF:erna för ett quiz
//
// Kräver miljövariabeln ANTHROPIC_API_KEY (läggs som hemlighet i GitHub).

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const QUIZ_DATA = path.join(DATA, "quiz");
const QUIZ_OUT = path.join(ROOT, "quiz");
const MODEL = process.env.QUIZ_MODEL || "claude-sonnet-5-5";
const MONTHS = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];

// ---------- Datum och veckor (svensk tid) ----------

function stockholmNow() {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", weekday: "short", hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { y: +get("year"), m: +get("month"), d: +get("day"), h: +get("hour"), wd: get("weekday") };
}

function isoWeek(y, m, d) {
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return { year: date.getUTCFullYear(), week: Math.ceil(((date - yearStart) / 864e5 + 1) / 7) };
}

function periodText(from, to) {
  const f = new Date(from), t = new Date(to);
  if (f.getMonth() === t.getMonth()) return `${f.getDate()}–${t.getDate()} ${MONTHS[t.getMonth()]} ${t.getFullYear()}`;
  return `${f.getDate()} ${MONTHS[f.getMonth()]} – ${t.getDate()} ${MONTHS[t.getMonth()]} ${t.getFullYear()}`;
}

// ---------- Hjälp ----------

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; }
}

// Enkel slumpgenerator med frö, så att samma quiz alltid blandas likadant
function seeded(seedStr) {
  let h = 2166136261;
  for (const c of seedStr) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
    return ((h >>> 0) % 100000) / 100000;
  };
}

function shuffleOptions(q, rnd) {
  const order = q.options.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return { ...q, options: order.map((i) => q.options[i]), answer: order.indexOf(q.answer) };
}

// ---------- AI ----------

const QUESTION = (n) => ({
  type: "object",
  properties: {
    q: { type: "string" },
    options: { type: "array", items: { type: "string" }, minItems: n, maxItems: n },
    answer: { type: "integer", description: "Index (0-baserat) för rätt alternativ" },
    explanation: { type: "string", description: "Kort förklaring till läraren, med stöd i nyhetstexten" },
    news: { type: "integer", description: "Numret på nyheten i quizet (1–6)" },
  },
  required: ["q", "options", "answer", "explanation", "news"],
});

const WORD = (n) => ({
  type: "object",
  properties: {
    word: { type: "string" },
    context: { type: "string", description: "Meningen där ordet används, gärna från nyheten" },
    options: { type: "array", items: { type: "string" }, minItems: n, maxItems: n },
    answer: { type: "integer" },
    explanation: { type: "string" },
  },
  required: ["word", "context", "options", "answer", "explanation"],
});

const TOOL = {
  name: "skapa_quiz",
  description: "Sparar veckans nyhetsquiz.",
  input_schema: {
    type: "object",
    properties: {
      teacherIntro: { type: "string", description: "2–3 meningar till läraren om veckans nyheter och quizet" },
      lessonTips: { type: "array", items: { type: "string" }, description: "3–4 korta förslag på hur quizet kan användas på lektionen" },
      news: {
        type: "array", minItems: 6, maxItems: 6,
        items: {
          type: "object",
          properties: {
            sourceIndex: { type: "integer", description: "Numret på nyheten i listan du fick" },
            title: { type: "string", description: "Kort, saklig rubrik" },
            studentSummary: { type: "string", description: "2–3 korta meningar som sammanfattar nyheten för läraren" },
            teacherBackground: { type: "string", description: "2–4 meningar bakgrund till läraren" },
          },
          required: ["sourceIndex", "title", "studentSummary", "teacherBackground"],
        },
      },
      questions: {
        type: "object",
        properties: {
          mc: { type: "array", items: QUESTION(4), minItems: 6, maxItems: 6 },
          words: { type: "array", items: WORD(4), minItems: 4, maxItems: 4 },
          discussion: {
            type: "array", minItems: 4, maxItems: 4,
            items: {
              type: "object",
              properties: { q: { type: "string" }, tips: { type: "string" }, news: { type: "integer" } },
              required: ["q", "tips", "news"],
            },
          },
        },
        required: ["mc", "words", "discussion"],
      },
    },
    required: ["teacherIntro", "lessonTips", "news", "questions"],
  },
};

function buildPrompt(items, period) {
  const list = items
    .map((x, i) => `[${i + 1}] ${x.source}${x.category ? " (" + x.category + ")" : ""}, ${x.date ? x.date.slice(0, 10) : "okänt datum"}\nRubrik: ${x.title}\nIngress: ${x.summary}`)
    .join("\n\n");

  return `Du skriver ett nyhetsquiz om veckans nyheter, ${period}. Det ska passa gymnasieelever (t.ex. i samhällskunskap eller på mentorstid) och vuxna som vill testa sin nyhetskoll.

Här är veckans nyheter:

${list}

Gör så här:

1. Välj 6 nyheter. Välj olika ämnen (t.ex. samhälle, världen, vardag, natur, sport, kultur). Välj nyheter som passar i skolan. Undvik grova brott, död och olyckor med detaljer. Välj inte två nyheter om samma sak.

2. Skriv för varje nyhet:
   - title: en kort, saklig rubrik.
   - studentSummary: 2–3 meningar som sammanfattar nyheten för läraren. Använd bara fakta som står i nyhetstexten.
   - teacherBackground: 2–4 meningar som ger läraren sammanhang. Använd bara välkänd, säker allmänkunskap. Hitta inte på siffror, namn, datum eller citat. Är du osäker, skriv allmänt och föreslå vad läraren kan kontrollera.

3. Frågor (nivå B1–B2):
   - 6 flervalsfrågor, en per vald nyhet, i samma ordning som nyheterna. 4 svarsalternativ. Frågorna ska kräva att eleven förstår och drar slutsatser, inte bara hittar ett ord.
   - 4 ordfrågor med ord från nyheterna som kan vara svåra för eleverna. Skriv meningen där ordet finns i fältet context. 4 alternativ.
   - 4 diskussionsfrågor som är öppna och knyter an till elevernas vardag eller samhället. Ge läraren tips på vad samtalet kan handla om.

Viktiga regler:
- Eleverna får inte nyhetstexterna på papper. De ska leta upp nyheterna själva på sajten, där bara rubriken och ingressen syns. Därför måste varje flervalsfråga gå att besvara med hjälp av rubriken och ingressen ovan, inte med fakta som bara står i hela artikeln eller i din bakgrundstext.
- Skriv frågorna så att det framgår vilken nyhet de handlar om, men ge inte bort svaret i frågan. Fältet news är nyhetens nummer i quizet (1–6).
- Det ska finnas exakt ett rätt svar. Felaktiga alternativ ska vara rimliga men tydligt fel.
- Skriv inte "alla ovanstående" eller "inget av alternativen".
- Ange rätt svar med index (0 = första alternativet).
- Var neutral i politiska frågor. Ta inte ställning.
- Skriv på korrekt svenska.

Spara quizet med verktyget skapa_quiz.`;
}

async function askClaude(items, period) {
  const key = process.env.ANTHROPIC_API_KEY;
  const res = await fetch(`${process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com"}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 12000,
      tools: [TOOL],
      tool_choice: { type: "tool", name: TOOL.name },
      messages: [{ role: "user", content: buildPrompt(items, period) }],
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Claude API svarade ${res.status}: ${body?.error?.message || JSON.stringify(body).slice(0, 300)}`);
  const block = body.content?.find((b) => b.type === "tool_use");
  if (!block) throw new Error("Svaret innehöll inget quiz.");
  console.log(`Tokens: ${body.usage?.input_tokens} in, ${body.usage?.output_tokens} ut`);
  return block.input;
}

// ---------- Kontroll av quizet ----------

function validate(raw, items) {
  const errs = [];
  const checkQ = (q, n, where) => {
    if (!q?.q && !q?.word) errs.push(`${where}: fråga saknas`);
    if (!Array.isArray(q.options) || q.options.length !== n) errs.push(`${where}: ska ha ${n} alternativ`);
    if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= n) errs.push(`${where}: ogiltigt facit`);
    if (new Set((q.options || []).map((o) => String(o).trim().toLowerCase())).size !== (q.options || []).length) errs.push(`${where}: dubbla alternativ`);
    if (q.news !== undefined && (q.news < 1 || q.news > 6)) errs.push(`${where}: fel nyhetsnummer`);
  };
  if (raw.news?.length !== 6) errs.push("Ska vara 6 nyheter");
  raw.news?.forEach((n, i) => {
    if (!items[n.sourceIndex - 1]) errs.push(`Nyhet ${i + 1}: okänt sourceIndex ${n.sourceIndex}`);
    if (!n.studentSummary) errs.push(`Nyhet ${i + 1}: elevtext saknas`);
  });
  raw.questions?.mc?.forEach((q, i) => checkQ(q, 4, `Flerval ${i + 1}`));
  raw.questions?.words?.forEach((q, i) => checkQ(q, 4, `Ord ${i + 1}`));
  if (raw.questions?.mc?.length !== 6) errs.push("Ska vara 6 flervalsfrågor");
  if (raw.questions?.words?.length !== 4) errs.push("Ska vara 4 ordfrågor");
  if (raw.questions?.discussion?.length !== 4) errs.push("Ska vara 4 diskussionsfrågor");
  return errs;
}

function finalize(raw, items, meta) {
  const rnd = seeded(meta.id);
  return {
    ...meta,
    teacherIntro: raw.teacherIntro,
    lessonTips: raw.lessonTips || [],
    news: raw.news.map((n, i) => {
      const src = items[n.sourceIndex - 1];
      return { n: i + 1, title: n.title, studentSummary: n.studentSummary, teacherBackground: n.teacherBackground, source: src.source, link: src.link, originalTitle: src.title };
    }),
    questions: {
      mc: raw.questions.mc.map((q) => shuffleOptions(q, rnd)),
      words: raw.questions.words.map((q) => shuffleOptions(q, rnd)),
      discussion: raw.questions.discussion,
    },
  };
}

// ---------- HTML och PDF ----------

async function loadRenderer() {
  await import(pathToFileURL(path.join(ROOT, "quiz-render.js")).href);
  return globalThis.QuizRender;
}

function findChrome() {
  const candidates = [process.env.CHROME, "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].filter(Boolean);
  for (const c of candidates) {
    try { execFileSync(c, ["--version"], { stdio: "ignore" }); return c; } catch { /* prova nästa */ }
  }
  return null;
}

async function renderPdfs(quiz) {
  const R = await loadRenderer();
  await mkdir(QUIZ_OUT, { recursive: true });
  const chrome = findChrome();
  if (!chrome) { console.warn("Hittade ingen Chrome – hoppar över PDF."); return; }
  const tmp = path.join(os.tmpdir(), `quiz-${quiz.id}`);
  await mkdir(tmp, { recursive: true });

  for (const version of ["elev", "larare"]) {
    const html = `<!DOCTYPE html><html lang="sv"><head><meta charset="utf-8"><title>${quiz.title} – ${version === "elev" ? "elevversion" : "lärarversion"}</title><style>body{margin:0}${R.CSS}</style></head><body>${R.render(quiz, version)}</body></html>`;
    const htmlFile = path.join(tmp, `${version}.html`);
    await writeFile(htmlFile, html, "utf8");
    const pdf = path.join(QUIZ_OUT, `${quiz.id}-${version}.pdf`);
    execFileSync(chrome, [
      "--headless=new", "--disable-gpu", "--no-sandbox", "--no-pdf-header-footer",
      `--print-to-pdf=${pdf}`, pathToFileURL(htmlFile).href,
    ], { stdio: "ignore", timeout: 60000 });
    console.log(`PDF: ${path.relative(ROOT, pdf)}`);
  }
  await rm(tmp, { recursive: true, force: true });
}

// Gör PDF:er för quiz som saknar dem (t.ex. quiz som lagts in utan Chrome)
async function renderMissing() {
  const index = await readJson(path.join(QUIZ_DATA, "index.json"), { quizzes: [] });
  for (const q of index.quizzes) {
    if (existsSync(path.join(QUIZ_OUT, `${q.id}-elev.pdf`)) && existsSync(path.join(QUIZ_OUT, `${q.id}-larare.pdf`))) continue;
    const quiz = await readJson(path.join(QUIZ_DATA, `${q.id}.json`), null);
    if (quiz) await renderPdfs(quiz);
  }
}

async function updateIndex(quiz) {
  const file = path.join(QUIZ_DATA, "index.json");
  const index = await readJson(file, { quizzes: [] });
  index.quizzes = [{ id: quiz.id, title: quiz.title, period: quiz.period, created: quiz.created },
    ...index.quizzes.filter((q) => q.id !== quiz.id)].sort((a, b) => b.id.localeCompare(a.id, "sv", { numeric: true }));
  await writeFile(file, JSON.stringify(index, null, 2) + "\n", "utf8");
}

// ---------- Huvudprogram ----------

async function main() {
  const args = process.argv.slice(2);
  await mkdir(QUIZ_DATA, { recursive: true });

  if (args[0] === "--render") {
    const quiz = await readJson(path.join(QUIZ_DATA, `${args[1]}.json`), null);
    if (!quiz) throw new Error(`Hittar inget quiz ${args[1]}`);
    await renderPdfs(quiz);
    return;
  }

  const now = stockholmNow();
  const { year, week } = isoWeek(now.y, now.m, now.d);
  const id = `${year}-v${String(week).padStart(2, "0")}`;
  const quizFile = path.join(QUIZ_DATA, `${id}.json`);
  const force = process.env.FORCE_QUIZ === "1" || args[0] === "--input";

  if (args[0] === "--prompt") {
    if (existsSync(quizFile)) { console.log(`QUIZ_FINNS_REDAN ${id}`); return; }
  } else if (existsSync(quizFile) && !force) { console.log(`Quiz för ${id} finns redan.`); await renderMissing(); return; }
  if (now.wd.startsWith("mån") && now.h < 6 && !force) { console.log("Veckans quiz skapas måndag kl. 06."); return; }

  // Nyheter från de senaste 7 dagarna
  const archive = await readJson(path.join(DATA, "archive.json"), { items: [] });
  const cutoff = Date.now() - 7 * 864e5;
  // Många källor: ta ett jämnt urval över veckan, högst 8 nyheter per källa
  const thisWeek = archive.items.filter((x) => new Date(x.date || x.firstSeen).getTime() >= cutoff);
  const seenTitles = new Set();
  const unique = thisWeek.filter((x) => { const k = (x.title || "").toLowerCase().trim(); return seenTitles.has(k) ? false : seenTitles.add(k); });
  const bySource = new Map();
  for (const x of unique) { if (!bySource.has(x.sourceId)) bySource.set(x.sourceId, []); bySource.get(x.sourceId).push(x); }
  const items = [...bySource.values()].flatMap((list) => {
    const step = Math.max(1, Math.floor(list.length / 8));
    return list.filter((_, i) => i % step === 0).slice(0, 8);
  }).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  if (items.length < 6) { console.log(`För få nyheter (${items.length}) för ett quiz.`); return; }

  const dates = items.map((x) => x.date || x.firstSeen).sort();
  const period = periodText(dates[0], dates[dates.length - 1]);
  const repo = process.env.GITHUB_REPOSITORY || "dragbasun69-jpg/nyhetslaget";
  const [owner, name] = repo.split("/");
  const siteUrl = process.env.SITE_URL || `https://${owner}.github.io/${name}/`;
  const meta = { id, year, week, title: `Nyhetsquiz vecka ${week}`, period, siteUrl, created: new Date().toISOString(), model: MODEL };

  if (args[0] === "--prompt") {
    console.log(`QUIZ_ID ${id}\n`);
    console.log(buildPrompt(items, period).replace("Spara quizet med verktyget skapa_quiz.",
      "Spara quizet som JSON i en fil med exakt den här strukturen och kör sedan: node scripts/make-quiz.mjs --input <filen>\n\n" +
      JSON.stringify(TOOL.input_schema, null, 1)));
    return;
  }

  let raw, errs = [];
  if (args[0] === "--input") {
    raw = JSON.parse(await readFile(args[1], "utf8"));
    meta.model = "manuellt";
    errs = validate(raw, items);
  } else {
    if (!process.env.ANTHROPIC_API_KEY) { console.log("Ingen ANTHROPIC_API_KEY – quizet görs av den schemalagda uppgiften i stället."); await renderMissing(); return; }
    // Max 3 misslyckade körningar per vecka, så att ett fel inte kostar pengar varje timme
    const failFile = path.join(QUIZ_DATA, `.misslyckat-${id}`);
    const fails = parseInt(await readFile(failFile, "utf8").catch(() => "0"), 10) || 0;
    if (fails >= 3 && !force) { console.log(`Quizet för ${id} har misslyckats ${fails} gånger. Kör manuellt med "Skapa om veckans nyhetsquiz".`); return; }
    await writeFile(failFile, String(fails + 1));
    for (let attempt = 1; attempt <= 2; attempt++) {
      raw = await askClaude(items, period);
      errs = validate(raw, items);
      if (!errs.length) break;
      console.warn(`Försök ${attempt} hade fel:\n- ${errs.join("\n- ")}`);
    }
  }
  if (errs.length) throw new Error(`Quizet klarade inte kontrollen:\n- ${errs.join("\n- ")}`);

  await rm(path.join(QUIZ_DATA, `.misslyckat-${id}`), { force: true });
  const quiz = finalize(raw, items, meta);
  await writeFile(quizFile, JSON.stringify(quiz, null, 2) + "\n", "utf8");
  await updateIndex(quiz);
  console.log(`Sparade ${path.relative(ROOT, quizFile)}`);
  await renderPdfs(quiz);
}

main().catch((err) => { console.error(err.message || err); process.exit(1); });
