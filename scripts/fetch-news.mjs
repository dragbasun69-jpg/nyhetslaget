// Hämtar nyheter från RSS-flöden i sources.json och skriver data/news.json.
// Körs av GitHub Actions varje timme. Kräver Node 18+ och inga paket.
//
// Kör lokalt:  node scripts/fetch-news.mjs

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { clusterStories } from "./cluster.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES_FILE = process.env.SOURCES_FILE || path.join(ROOT, "sources.json");
const OUT_FILE = process.env.OUT_FILE || path.join(ROOT, "data", "news.json");
const TIMEOUT_MS = 15000;
const SUMMARY_MAX = 320;
const UA = "Mozilla/5.0 (compatible; LattNyttBot/1.0; +https://github.com)";

// ---------- Hjälpfunktioner ----------

async function fetchText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml, text/html, */*" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", aring: "å", auml: "ä", ouml: "ö", Aring: "Å", Auml: "Ä", Ouml: "Ö", eacute: "é" };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

function unCdata(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

// Hämtar innehållet i första taggen med något av namnen
function tag(xml, ...names) {
  for (const name of names) {
    const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i");
    const m = xml.match(re);
    if (m) return unCdata(m[1]).trim();
  }
  return "";
}

// Hämtar ett attribut från första taggen som matchar (även självstängande)
function attr(xml, tagName, attrName, filter) {
  const re = new RegExp(`<${tagName}\\b([^>]*)>`, "gi");
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    if (filter && !filter(attrs)) continue;
    const a = attrs.match(new RegExp(`\\b${attrName}\\s*=\\s*["']([^"']+)["']`, "i"));
    if (a) return decodeEntities(a[1]);
  }
  return "";
}

function stripHtml(html) {
  // Avkoda först, så att dubbelkodad HTML (&lt;p&gt;) blir riktiga taggar som kan tas bort
  let s = html;
  for (let i = 0; i < 3 && /&(lt|gt|amp|#60|#62);/i.test(s); i++) s = decodeEntities(s);
  return decodeEntities(
    s
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/p>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/The post .* appeared first on .*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Kortar texten vid en meningsgräns så att vi bara visar en ingress
function shorten(text, max = SUMMARY_MAX) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (lastStop > max * 0.5) return cut.slice(0, lastStop + 1);
  return cut.slice(0, cut.lastIndexOf(" ")) + " …";
}

const isImageUrl = (u) => /\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(u);

function findImage(itemXml) {
  // 1. media:content / media:thumbnail
  let img =
    attr(itemXml, "media:content", "url", (a) => !/medium=["'](video|audio)/i.test(a) && (!/type=/i.test(a) || /type=["']image/i.test(a))) ||
    attr(itemXml, "media:thumbnail", "url");
  if (img) return img;
  // 2. enclosure med bildtyp
  img = attr(itemXml, "enclosure", "url", (a) => /type=["']image/i.test(a) || isImageUrl(a));
  if (img) return img;
  // 3. itunes:image (poddar, t.ex. Sveriges Radio)
  img = attr(itemXml, "itunes:image", "href");
  if (img) return img;
  // 4. Första <img> i beskrivningen eller innehållet
  const html = decodeEntities(unCdata(tag(itemXml, "content:encoded", "description", "summary", "content")));
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (m) return m[1];
  return "";
}

const LOGO_RE = /logo|ikon|icon|avatar|sprite|placeholder|favicon|\.svg(\?|$)/i;

// Hämtar bilder från artikelsidan: og:image och första riktiga bilden i artikeln
async function findPageImages(url) {
  try {
    const html = await fetchText(url);
    const m =
      html.match(/<meta[^>]+property=["']og:image(?::url)?["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::url)?["']/i) ||
      html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
    const og = m ? new URL(decodeEntities(m[1]), url).href : "";

    // Leta i <article> eller <main> i första hand, annars hela sidan
    const body = (html.match(/<article[\s\S]*?<\/article>/i) || html.match(/<main[\s\S]*?<\/main>/i) || [html])[0];
    let content = "";
    for (const img of body.match(/<img\b[^>]*>/gi) || []) {
      const src = (img.match(/\b(?:data-src|src)\s*=\s*["']([^"']+)["']/i) || [])[1];
      if (!src || src.startsWith("data:") || LOGO_RE.test(src) || LOGO_RE.test(img)) continue;
      const w = parseInt((img.match(/\bwidth=["']?(\d+)/i) || [])[1] || "0", 10);
      if (w && w < 200) continue;
      content = new URL(decodeEntities(src), url).href;
      break;
    }
    return { og, content };
  } catch {
    return { og: "", content: "" };
  }
}

function parseDate(s) {
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString();
}

function parseFeed(xml, source) {
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const chunks = xml.match(isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi) || [];
  const channelImage = attr(xml.split(/<item[\s>]|<entry[\s>]/i)[0], "itunes:image", "href") || tag(tag(xml, "image"), "url");

  return chunks.map((it) => {
    const title = stripHtml(tag(it, "title"));
    let link = isAtom ? attr(it, "link", "href", (a) => !/rel=/i.test(a) || /rel=["']alternate/i.test(a)) : decodeEntities(tag(it, "link"));
    if (!link) link = decodeEntities(tag(it, "guid"));
    const rawDesc = tag(it, "description", "summary", "itunes:summary") || tag(it, "content:encoded", "content");
    let summary = shorten(stripHtml(rawDesc));
    if (/^[\d\s.,:-]*$/.test(summary)) summary = ""; // t.ex. "261113" i 8 Sidors dagssammanfattning
    const date = parseDate(tag(it, "pubDate", "published", "updated", "dc:date"));
    let image = findImage(it);
    if (image) image = decodeEntities(image);
    return { title, link, summary, date, image, sourceId: source.id, source: source.name, color: source.color, category: source.category || "Sverige", paywall: !!source.paywall, _channelImage: channelImage };
  }).filter((x) => x.title && x.link);
}

// Kör uppgifter med begränsad samtidighet
async function pool(items, limit, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------- Arkiv för veckoquizet ----------
// Sparar alla nyheter från de senaste dagarna, så att quizet kan bygga på hela veckan
// och inte bara på de 40 senaste nyheterna.
const ARCHIVE_DAYS = 8;  // räcker för veckoquizet
const SITE_DAYS = 3;     // så många dagar visas på sajten
const SITE_MAX = 600;

async function updateArchive(items) {
  const file = path.join(path.dirname(OUT_FILE), "archive.json");
  let old = [];
  try { old = JSON.parse(await readFile(file, "utf8")).items || []; } catch { /* ingen fil än */ }

  const now = new Date().toISOString();
  const byLink = new Map(old.map((x) => [x.link, x]));
  for (const x of items) {
    const prev = byLink.get(x.link);
    byLink.set(x.link, {
      title: x.title, link: x.link, summary: x.summary, date: x.date,
      image: x.image, source: x.source, sourceId: x.sourceId, category: x.category, paywall: x.paywall,
      firstSeen: prev?.firstSeen || now,
    });
  }
  const cutoff = Date.now() - ARCHIVE_DAYS * 864e5;
  const kept = [...byLink.values()]
    .filter((x) => new Date(x.date || x.firstSeen).getTime() >= cutoff)
    .sort((a, b) => (b.date || b.firstSeen).localeCompare(a.date || a.firstSeen));

  if (JSON.stringify(kept) === JSON.stringify(old)) return kept;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ items: kept }, null, 2) + "\n", "utf8");
  console.log(`Arkivet har ${kept.length} nyheter från de senaste ${ARCHIVE_DAYS} dagarna.`);
  return kept;
}

// ---------- Huvudprogram ----------

async function main() {
  const config = JSON.parse(await readFile(SOURCES_FILE, "utf8"));
  const sources = config.sources.filter((s) => s.enabled !== false);
  const maxPer = config.maxPerSource ?? 15;
  const maxTotal = config.maxTotal ?? 40;

  const status = [];
  let all = [];

  for (const source of sources) {
    try {
      const xml = await fetchText(source.url);
      const items = parseFeed(xml, source).slice(0, maxPer);
      if (!items.length) throw new Error("Inga nyheter hittades i flödet");
      all.push(...items);
      status.push({ id: source.id, name: source.name, ok: true, count: items.length });
      console.log(`✓ ${source.name}: ${items.length} nyheter`);
    } catch (err) {
      status.push({ id: source.id, name: source.name, ok: false, error: String(err.message || err) });
      console.warn(`✗ ${source.name}: ${err.message || err}`);
    }
  }

  // Ta bort dubbletter och sortera nyast först
  const seen = new Set();
  all = all.filter((x) => (seen.has(x.link) ? false : seen.add(x.link)));
  all.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  all = all.slice(0, maxTotal);

  // Bildreserv: og:image från artikelsidan, annars kanalens logga
  // Återanvänd bilder från arkivet, så att artikelsidor bara hämtas för nya nyheter
  try {
    const arch = JSON.parse(await readFile(path.join(path.dirname(OUT_FILE), "archive.json"), "utf8")).items || [];
    const known = new Map(arch.map((x) => [x.link, x.image]));
    for (const it of all) if (!it.image && known.get(it.link)) it.image = known.get(it.link);
  } catch { /* inget arkiv än */ }

  await pool(all, 6, async (item) => {
    if (!item.image && /^https?:/i.test(item.link)) {
      const { og, content } = await findPageImages(item.link);
      item.image = og && !LOGO_RE.test(og) ? og : content || og;
      item._alt = content;
    }
    if (!item.image && item._channelImage) item.image = item._channelImage;
  });

  // Samma bild på många nyheter från samma källa är nästan alltid en logga.
  // Byt då till artikelns egen bild om en sådan hittades.
  const uses = {};
  all.forEach((x) => { const k = x.sourceId + "|" + x.image; uses[k] = (uses[k] || 0) + 1; });
  all.forEach((x) => {
    if (x.image && uses[x.sourceId + "|" + x.image] >= 3 && x._alt && x._alt !== x.image) x.image = x._alt;
    delete x._alt;
    delete x._channelImage;
  });

  all.forEach((x, i) => (x.id = `${x.sourceId}-${i}`));

  // Om allt misslyckades: behåll förra versionen så att sajten inte blir tom
  if (!all.length) {
    console.error("Inga nyheter kunde hämtas. Behåller befintlig news.json.");
    process.exitCode = 1;
    return;
  }

  // Sajten visar nyheter från de senaste dagarna; arkivet sparar en vecka till quizet
  const colors = Object.fromEntries(config.sources.map((s) => [s.id, s.color]));
  const archived = await updateArchive(all);
  // Samma artikel kan komma från flera tidningar i samma koncern (t.ex. Norra Skåne och
  // Kristianstadsbladet). Visa den en gång och notera var den mer finns.
  const order = Object.fromEntries(config.sources.map((s, i) => [s.id, i]));
  const normTitle = (t) => (t || "").toLowerCase().replace(/[^a-z0-9åäöéü]+/g, " ").trim();
  const siteCutoff = Date.now() - SITE_DAYS * 864e5;
  const groups = new Map();
  for (const x of archived.filter((x) => new Date(x.date || x.firstSeen).getTime() >= siteCutoff)) {
    const k = normTitle(x.title);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(x);
  }
  all = [...groups.values()]
    .map((g) => {
      g.sort((a, b) => (order[a.sourceId] ?? 99) - (order[b.sourceId] ?? 99));
      const main = { ...g[0] };
      const others = [...new Set(g.slice(1).map((o) => o.source).filter((n) => n !== main.source))];
      if (others.length) main.alsoAt = others;
      return main;
    })
    .sort((a, b) => (b.date || b.firstSeen || "").localeCompare(a.date || a.firstSeen || ""))
    .slice(0, SITE_MAX)
    .map((x, i) => ({
      title: x.title, link: x.link, summary: x.summary, date: x.date, image: x.image,
      sourceId: x.sourceId, source: x.source, color: colors[x.sourceId] || "#14213d",
      category: x.category, paywall: x.paywall, id: `${x.sourceId}-${i}`,
      ...(x.alsoAt ? { alsoAt: x.alsoAt } : {}),
    }));

  // Samma händelse hos olika källor -> sidan "Jämför källorna"
  try {
    const clusters = clusterStories(all);
    for (const c of clusters) for (const v of c.versions) {
      const it = all.find((x) => x.id === v.id);
      if (it) { it.cluster = c.id; it.clusterSize = c.sources; }
    }
    const cmp = { updated: new Date().toISOString(), clusters };
    const CMP_FILE = path.join(path.dirname(OUT_FILE), "jamfor.json");
    let same = false;
    try { same = JSON.stringify(JSON.parse(await readFile(CMP_FILE, "utf8")).clusters) === JSON.stringify(clusters); } catch {}
    if (!same) {
      await writeFile(CMP_FILE, JSON.stringify(cmp, null, 2) + "\n", "utf8");
      console.log(`Jämförelser: ${clusters.length} händelser med flera källor`);
    }
  } catch (err) {
    console.error("Kunde inte jämföra källor:", err.message);
  }

  // Skriv bara om något faktiskt ändrats, så att repot inte fylls av tomma ändringar
  try {
    const old = JSON.parse(await readFile(OUT_FILE, "utf8"));
    if (JSON.stringify(old.items) === JSON.stringify(all) && JSON.stringify(old.sources) === JSON.stringify(status)) {
      console.log("Inga ändringar sedan förra körningen.");
      return;
    }
  } catch { /* ingen tidigare fil */ }

  const data = { updated: new Date().toISOString(), sources: status, items: all };
  await mkdir(path.dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(data, null, 2) + "\n", "utf8");
  console.log(`Sparade ${all.length} nyheter i ${path.relative(ROOT, OUT_FILE)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
