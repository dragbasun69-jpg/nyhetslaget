// Hämtar börsindex (OMXS30) och valutakurser (euro och dollar mot kronan)
// och skriver data/market.json. Körs av GitHub Actions varje timme.
//
// Index:   Yahoo Finance i första hand, Stooq som reserv (fördröjda uppgifter)
// Valutor: Riksbankens öppna API i första hand, ECB (via Frankfurter) som reserv

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "data", "market.json");
const UA = "Mozilla/5.0 (compatible; NyhetslagetBot/1.0)";
const day = (d) => d.toISOString().slice(0, 10);

async function get(url, type = "json") {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": UA, Accept: type === "json" ? "application/json" : "text/csv,*/*" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return type === "json" ? r.json() : r.text();
  } finally { clearTimeout(t); }
}

const round = (x, n = 2) => Math.round(x * 10 ** n) / 10 ** n;

function summarize(history, last, prev, asOf, source) {
  if (!history.length || !Number.isFinite(last)) throw new Error("tom data");
  if (!Number.isFinite(prev)) prev = history.length > 1 ? history[history.length - 2].c : last;
  return { last: round(last), prev: round(prev), change: round(last - prev), changePct: round(((last - prev) / prev) * 100), asOf, source, history };
}

// ---------- OMXS30 ----------

async function indexFromYahoo() {
  const d = await get("https://query1.finance.yahoo.com/v8/finance/chart/%5EOMX?range=1mo&interval=1d");
  const r = d.chart?.result?.[0];
  if (!r) throw new Error("inget resultat");
  const closes = r.indicators.quote[0].close;
  const history = r.timestamp.map((t, i) => ({ d: day(new Date(t * 1000)), c: closes[i] })).filter((x) => Number.isFinite(x.c)).map((x) => ({ ...x, c: round(x.c) }));
  const m = r.meta;
  return summarize(history, m.regularMarketPrice, m.chartPreviousClose ?? m.previousClose, new Date(m.regularMarketTime * 1000).toISOString(), "Yahoo Finance");
}

async function indexFromStooq() {
  const csv = await get("https://stooq.com/q/d/l/?s=%5Eomxs&i=d", "text");
  const rows = csv.trim().split("\n").slice(1).map((l) => l.split(",")).filter((r) => r.length >= 5 && Number.isFinite(+r[4]));
  if (!rows.length) throw new Error("ingen data");
  const cutoff = day(new Date(Date.now() - 31 * 864e5));
  const history = rows.filter((r) => r[0] >= cutoff).map((r) => ({ d: r[0], c: round(+r[4]) }));
  const last = history[history.length - 1];
  return summarize(history, last.c, history.length > 1 ? history[history.length - 2].c : NaN, `${last.d}T17:30:00+01:00`, "Stooq");
}

// ---------- Valutor ----------

async function fxFromRiksbank(series) {
  const to = day(new Date());
  const from = day(new Date(Date.now() - 35 * 864e5));
  const obs = await get(`https://api.riksbank.se/swea/v1/Observations/${series}/${from}/${to}`);
  const history = obs.filter((o) => Number.isFinite(o.value)).map((o) => ({ d: o.date, c: round(o.value, 4) }));
  const last = history[history.length - 1];
  return summarize(history, last.c, NaN, `${last.d}T16:15:00+01:00`, "Riksbanken");
}

async function fxFromEcb(code) {
  const to = day(new Date());
  const from = day(new Date(Date.now() - 35 * 864e5));
  const d = await get(`https://api.frankfurter.app/${from}..${to}?from=${code}&to=SEK`);
  const history = Object.entries(d.rates).map(([dt, r]) => ({ d: dt, c: round(r.SEK, 4) })).sort((a, b) => a.d.localeCompare(b.d));
  const last = history[history.length - 1];
  return summarize(history, last.c, NaN, `${last.d}T16:00:00+01:00`, "Europeiska centralbanken");
}

async function firstWorking(name, attempts, log) {
  for (const [label, fn] of attempts) {
    try { const r = await fn(); log.push({ name, source: label, ok: true }); console.log(`✓ ${name} från ${label}`); return r; }
    catch (e) { log.push({ name, source: label, ok: false, error: String(e.message || e) }); console.warn(`✗ ${name} från ${label}: ${e.message || e}`); }
  }
  return null;
}

async function main() {
  let old = {};
  try { old = JSON.parse(await readFile(OUT, "utf8")); } catch { /* första gången */ }
  const log = [];

  const omx = await firstWorking("OMXS30", [["Yahoo Finance", indexFromYahoo], ["Stooq", indexFromStooq]], log);
  const eur = await firstWorking("EUR", [["Riksbanken", () => fxFromRiksbank("SEKEURPMI")], ["ECB", () => fxFromEcb("EUR")]], log);
  const usd = await firstWorking("USD", [["Riksbanken", () => fxFromRiksbank("SEKUSDPMI")], ["ECB", () => fxFromEcb("USD")]], log);

  const data = {
    updated: new Date().toISOString(),
    index: omx ? { name: "OMXS30", ...omx } : old.index || null,
    fx: [
      eur ? { code: "EUR", name: "Euro", ...eur } : old.fx?.find((f) => f.code === "EUR"),
      usd ? { code: "USD", name: "Dollar", ...usd } : old.fx?.find((f) => f.code === "USD"),
    ].filter(Boolean),
    log,
  };
  if (!data.index && !data.fx.length) { console.error("Ingen börsdata kunde hämtas."); process.exitCode = 1; return; }

  // Spara bara om siffrorna ändrats
  const strip = (d) => JSON.stringify({ i: d.index, f: d.fx });
  if (old.updated && strip(old) === strip(data)) { console.log("Börsdata oförändrad."); return; }
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(data, null, 2) + "\n", "utf8");
  console.log("Sparade data/market.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
