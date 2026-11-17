// Hittar samma nyhet hos olika källor (olika rubriker men samma händelse).
// Används till sidan "Jämför källorna" (jamfor.html).
// Metod: ord från rubrik och ingress -> ordstammar (första 6 bokstäverna) ->
// vikt efter hur ovanligt ordet är (IDF) -> cosinuslikhet mellan nyheter.

const STOP = new Set(`
alla allt andra annan andra anser att av bara bland blir blev bli bara bort borde bra
både dag dagar dagen de dem den denna deras dess det detta dig din dina ditt du där efter
eftersom ej eller en enligt ett fick finns flera fler från får för först förra gick gjorde
gör göra ha hade han har hela heller hen henne hennes hon honom hans här hur i icke igen
in inför inget inga inom inte ja jag kan kanske kom komma kommer kunde man med men mer
mest mig min mina mitt mot mycket många måste ned ni nog nu när någon något några och
också om oss på samma sedan sig sin sina sitt sju ska skulle slut som står så säger
sade tar till tre två under upp ut utan vad var vara varit vi vid vilka vilken vill
vår våra än ändå är år åren året över efter nya nytt ny första andra stor stora
sverige svensk svenska svenskt säger uppger enligt kronor procent miljoner miljarder
idag igår imorgon timmar veckan veckor tisdag måndag onsdag torsdag fredag lördag söndag
januari februari mars april maj juni juli augusti september oktober november december
läs mer artikel video bild direkt live just nyheter nyhet
`.split(/\s+/).filter(Boolean));

const stem = (w) => w.slice(0, 6);

export function tokens(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-zåäöéü0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w))
    .map(stem);
}

// Vanligaste ämnet, men ett mer specifikt ämne går före det breda "Sverige"
function pickCategory(vs) {
  const n = {};
  for (const v of vs) if (v.category) n[v.category] = (n[v.category] || 0) + (v.category === "Sverige" ? 0.5 : 1);
  return Object.entries(n).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

export function clusterStories(items, { maxHours = 48, minSim = 0.32, minShared = 3, maxClusters = 40 } = {}) {
  const docs = items.map((x) => {
    const title = new Set(tokens(x.title));
    const all = new Set([...title, ...tokens(x.summary)]);
    return { x, title, all, t: new Date(x.date || 0).getTime() };
  });
  const df = new Map();
  for (const d of docs) for (const w of d.all) df.set(w, (df.get(w) || 0) + 1);
  const N = docs.length || 1;
  const idf = (w) => Math.log(N / (df.get(w) || 1));
  // Väldigt vanliga ord säger inget om vilken händelse det gäller
  const weight = (w) => (df.get(w) > N * 0.05 ? 0 : idf(w));
  for (const d of docs) d.norm = Math.sqrt([...d.all].reduce((s, w) => s + weight(w) ** 2, 0)) || 1;

  // Union-find
  const parent = docs.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const best = new Map();

  for (let i = 0; i < docs.length; i++) {
    for (let j = i + 1; j < docs.length; j++) {
      const a = docs[i], b = docs[j];
      if (a.x.source === b.x.source) continue;
      if (Math.abs(a.t - b.t) > maxHours * 3600e3) continue;
      let shared = 0, dot = 0, titleShared = 0;
      for (const w of a.all) {
        if (b.all.has(w) && weight(w) > 0) {
          shared++;
          dot += weight(w) ** 2;
          if (a.title.has(w) || b.title.has(w)) titleShared++;
        }
      }
      if (shared < minShared || titleShared < 1) continue;
      const sim = dot / (a.norm * b.norm);
      if (sim < minSim) continue;
      parent[find(i)] = find(j);
      best.set(`${i}-${j}`, sim);
    }
  }

  const groups = new Map();
  docs.forEach((d, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  });

  const clusters = [];
  for (const idx of groups.values()) {
    if (idx.length < 2 || idx.length > 8) continue; // för stora kluster är oftast felkopplingar
    // En version per källa: den nyaste
    const bySource = new Map();
    for (const i of idx) {
      const x = docs[i].x;
      const cur = bySource.get(x.source);
      if (!cur || (x.date || "") > (cur.date || "")) bySource.set(x.source, x);
    }
    if (bySource.size < 2) continue;
    const versions = [...bySource.values()].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    const latest = versions.reduce((m, x) => ((x.date || "") > m ? x.date : m), "");
    clusters.push({
      id: "k-" + versions.map((v) => v.id).sort()[0],
      sources: versions.length,
      latest,
      category: pickCategory(versions),
      image: (versions.find((v) => v.image) || {}).image || null,
      versions: versions.map((v) => ({
        id: v.id, source: v.source, color: v.color, title: v.title, summary: v.summary,
        link: v.link, date: v.date, paywall: !!v.paywall, alsoAt: v.alsoAt || undefined,
      })),
    });
  }
  clusters.sort((a, b) => b.sources - a.sources || b.latest.localeCompare(a.latest));
  return clusters.slice(0, maxClusters);
}
