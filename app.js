// Nyhetsläget – visar nyheter från data/news.json och läser upp dem
// med webbläsarens inbyggda röst (Web Speech API).

(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const els = {
    grid: $("grid"), status: $("status"), filters: $("filters"), updated: $("updated"),
    sourceStatus: $("sourceStatus"), playAll: $("playAll"), player: $("player"),
    nowTitle: $("nowTitle"), prev: $("prevBtn"), pause: $("pauseBtn"), next: $("nextBtn"),
    stop: $("stopBtn"), rate: $("rate"), voice: $("voice"),
    smaller: $("textSmaller"), bigger: $("textBigger"),
  };

  const synth = "speechSynthesis" in window ? window.speechSynthesis : null;
  const REFRESH_MS = 10 * 60 * 1000;
  const MODE = window.LATTNYTT_MODE || "alla"; // "utkast" på förhandsvisningssidan

  let data = { items: [], sources: [] };
  let filter = "alla";      // ämne
  let sourceFilter = "alla"; // källa
  const PAGE = 60;
  let shown = PAGE;
  const CATEGORY_ORDER = ["Sverige", "Världen", "Lokalt", "Ekonomi", "Vetenskap", "Sport"];
  let query = "";

  // Uppläsningens läge
  const reader = {
    queue: [],        // nyheter i den ordning de ska läsas
    pos: 0,           // vilken nyhet i kön
    chunk: 0,         // vilken mening i nyheten (0 = rubriken)
    continuous: true, // läs vidare till nästa nyhet
    playing: false,
    paused: false,
    token: 0,         // används för att ignorera gamla händelser efter stopp
  };

  // ---------- Lagring (kan saknas i vissa lägen) ----------
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignoreras */ } },
  };

  // ---------- Hjälpfunktioner ----------
  const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "");

  function splitSentences(text) {
    if (!text) return [];
    const parts = text.match(/[^.!?…]+[.!?…]+["”»']?\s*|[^.!?…]+$/g) || [text];
    return parts.map((s) => s.trim()).filter(Boolean);
  }

  function relTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    const min = Math.round((Date.now() - d) / 60000);
    if (min < 1) return "nyss";
    if (min < 60) return `för ${min} min sedan`;
    const h = Math.round(min / 60);
    if (h < 24) return `för ${h} ${h === 1 ? "timme" : "timmar"} sedan`;
    return d.toLocaleDateString("sv-SE", { day: "numeric", month: "long" });
  }

  const norm = (t) => (t || "").toLowerCase();
  const visibleItems = () => data.items.filter((x) =>
    (filter === "alla" || x.category === filter) &&
    (sourceFilter === "alla" || x.sourceId === sourceFilter) &&
    (!query || query.split(/\s+/).every((w) => norm(x.title + " " + x.summary + " " + (x.own?.tip?.text || "")).includes(w))));

  // ---------- Rendera ----------
  function renderFilters() {
    const cats = CATEGORY_ORDER.filter((c) => data.items.some((x) => x.category === c));
    els.filters.innerHTML = [["alla", "Alla"], ...cats.map((c) => [c, c])]
      .map(([id, name]) => `<button class="chip" type="button" data-filter="${esc(id)}" aria-pressed="${id === filter}">${esc(name)}</button>`)
      .join("");
    const sources = new Map();
    data.items.filter((x) => filter === "alla" || x.category === filter).forEach((x) => sources.set(x.sourceId, x.source));
    if (sourceFilter !== "alla" && !sources.has(sourceFilter)) sourceFilter = "alla";
    $("sourceSelect").innerHTML = [["alla", "Alla källor"], ...[...sources].sort((a, b) => a[1].localeCompare(b[1], "sv"))]
      .map(([id, name]) => `<option value="${esc(id)}"${id === sourceFilter ? " selected" : ""}>${esc(name)}</option>`).join("");
  }

  function renderGrid() {
    const items = visibleItems();
    if (!items.length) {
      els.grid.innerHTML = "";
      els.status.textContent = query ? `Hittade inga nyheter som innehåller ”${query}”.`
        : MODE === "utkast" ? "Det finns inga utkast just nu." : "Inga nyheter att visa just nu.";
      els.status.hidden = false;
      return;
    }
    els.status.hidden = true;
    $("showMore").hidden = items.length <= shown;
    $("showMore").textContent = `Visa fler nyheter (${items.length - shown} till)`;
    els.grid.innerHTML = items.slice(0, shown).map((x) => {
      if (x.own) return ownCard(x);
      const img = safeUrl(x.image);
      const sentences = splitSentences(x.summary);
      return `
      <article class="card" id="card-${esc(x.id)}" data-id="${esc(x.id)}">
        <div class="card-img">
          <div class="ph" style="background:${esc(x.color || "#14213d")}">${esc(x.source)}</div>
          ${img ? `<img src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}
        </div>
        <div class="card-body">
          <div class="meta">
            <span class="badge" style="background:${esc(x.color || "#14213d")}">${esc(x.source)}</span>
            ${x.category ? `<span class="cat">${esc(x.category)}</span>` : ""}
            <time datetime="${esc(x.date || "")}">${esc(relTime(x.date))}</time>
          </div>
          <h2 data-chunk="0"><a href="${esc(safeUrl(x.link))}" target="_blank" rel="noopener">${esc(x.title)}</a></h2>
          <p class="summary">${sentences.map((s, i) => `<span class="sent" data-chunk="${i + 1}">${esc(s)}</span>`).join(" ")}</p>
          <div class="card-actions">
            ${synth ? `<button class="listen" type="button" data-listen="${esc(x.id)}" aria-pressed="false">🔊 Lyssna</button>` : ""}
            <a class="more" href="${esc(safeUrl(x.link))}" target="_blank" rel="noopener"${x.paywall ? ' title="Kan kräva prenumeration"' : ""}>Läs hela hos ${esc(x.source)}${x.paywall ? " 🔒" : ""} →</a>
          </div>
        </div>
      </article>`;
    }).join("");
    markReading();
  }

  // Nyhetslägets egna nyheter: hela texten visas, med ordruta och källor
  function ownCard(x) {
    const o = x.own;
    let n = 0;
    const paras = o.paragraphs.map((p) =>
      `<p class="summary">${splitSentences(p).map((sn) => `<span class="sent" data-chunk="${++n}">${esc(sn)}</span>`).join(" ")}</p>`).join("");
    return `
      <article class="card own" id="card-${esc(x.id)}" data-id="${esc(x.id)}">
        <div class="card-img"><div class="ph" style="background:${esc(o.color || "#14213d")}"><span class="emoji" aria-hidden="true">${esc(o.emoji || "📰")}</span></div></div>
        <div class="card-body">
          <div class="meta">
            <span class="badge" style="background:#14213d">Nyhetsläget</span>
            <time datetime="${esc(x.date || "")}">${esc(relTime(x.date))}</time>
          </div>
          <h2 data-chunk="0">${esc(x.title)}</h2>
          ${paras}
          ${o.tip ? `<p class="tipbox"><b>${esc(o.tip.label)}:</b> ${esc(o.tip.text)}</p>` : ""}
          <details class="sources"><summary>Källor (${o.sources.length})</summary><ul>${o.sources
            .map((c) => `<li><a href="${esc(safeUrl(c.url))}" target="_blank" rel="noopener">${esc(c.title)}</a></li>`).join("")}</ul></details>
          <p class="ai">Skriven av Nyhetsläget med hjälp av AI. Fakta är kontrollerade mot källorna.</p>
          <div class="card-actions">
            ${synth ? `<button class="listen" type="button" data-listen="${esc(x.id)}" aria-pressed="false">🔊 Lyssna</button>` : ""}
          </div>
        </div>
      </article>`;
  }

  // Gör om en egen nyhet till samma form som övriga nyheter
  const OWN_DAYS = 14;
  function ownToItem(o) {
    return {
      id: `egna-${o.id}`, sourceId: "egna", source: "Nyhetsläget", color: "#14213d",
      title: o.title, date: o.date, link: "", image: "",
      summary: o.paragraphs.join(" "), own: o,
    };
  }

  async function loadOwn(file) {
    try {
      const r = await fetch(`data/egna/${file}?t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) return [];
      const d = await r.json();
      return (d.items || []).map(ownToItem);
    } catch { return []; }
  }

  function renderFooter() {
    els.updated.textContent = data.updated
      ? `Senast uppdaterad ${new Date(data.updated).toLocaleString("sv-SE", { dateStyle: "long", timeStyle: "short" })}.`
      : "";
    const failed = (data.sources || []).filter((s) => !s.ok);
    els.sourceStatus.textContent = failed.length ? `Kunde inte hämta just nu: ${failed.map((s) => s.name).join(", ")}.` : "";
  }

  // ---------- Hämta data ----------
  async function load() {
    try {
      const res = await fetch(`data/news.json?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(res.status);
      const fresh = await res.json();
      let own;
      if (MODE === "utkast") {
        own = await loadOwn("utkast.json");
        fresh.items = own;
      } else {
        const cutoff = Date.now() - OWN_DAYS * 864e5;
        own = (await loadOwn("publicerade.json")).filter((x) => new Date(x.date).getTime() >= cutoff);
        fresh.items = [...own, ...fresh.items].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      }
      const changed = fresh.updated !== data.updated || own.length !== data._own;
      fresh._own = own.length;
      data = fresh;
      if (changed && !reader.playing) {
        renderFilters();
        renderGrid();
      }
      renderFooter();
    } catch (err) {
      if (!data.items.length) els.status.textContent = "Kunde inte hämta nyheterna. Försök igen om en stund.";
      console.error(err);
    }
  }

  // ---------- Röster ----------
  function loadVoices() {
    if (!synth) return;
    const all = synth.getVoices();
    let voices = all.filter((v) => /^sv/i.test(v.lang));
    const noSwedish = !voices.length;
    if (noSwedish) voices = all;
    const saved = store.get("voice");
    els.voice.innerHTML = voices
      .map((v) => `<option value="${esc(v.voiceURI)}">${esc(v.name)}${noSwedish ? ` (${esc(v.lang)})` : ""}</option>`)
      .join("");
    // Välj sparad röst, annars en svensk som låter bra om den finns
    const preferred = voices.find((v) => v.voiceURI === saved)
      || voices.find((v) => /alva|klara|sofie|hillevi|google/i.test(v.name))
      || voices[0];
    if (preferred) els.voice.value = preferred.voiceURI;
    if (noSwedish && all.length) {
      els.sourceStatus.textContent = "Din enhet saknar svensk röst. Lägg till en under enhetens inställningar för tal/uppläsning.";
    }
  }

  const currentVoice = () => synth?.getVoices().find((v) => v.voiceURI === els.voice.value) || null;

  // ---------- Uppläsning ----------
  function chunksFor(item) {
    return [item.title, ...splitSentences(item.summary)];
  }

  function markReading() {
    document.querySelectorAll(".card.reading").forEach((c) => c.classList.remove("reading"));
    document.querySelectorAll(".on").forEach((e) => e.classList.remove("on"));
    document.querySelectorAll('[data-listen][aria-pressed="true"]').forEach((b) => {
      b.setAttribute("aria-pressed", "false");
      b.textContent = "🔊 Lyssna";
    });
    if (!reader.playing) return;
    const item = reader.queue[reader.pos];
    const card = item && document.getElementById(`card-${item.id}`);
    if (!card) return;
    card.classList.add("reading");
    card.querySelector(`[data-chunk="${reader.chunk}"]`)?.classList.add("on");
    const btn = card.querySelector("[data-listen]");
    if (btn) { btn.setAttribute("aria-pressed", "true"); btn.textContent = "⏹ Stoppa"; }
  }

  function speakCurrent() {
    const item = reader.queue[reader.pos];
    if (!item) return stop();
    const chunks = chunksFor(item);
    if (reader.chunk >= chunks.length) return nextItem(true);

    const myToken = ++reader.token;
    const u = new SpeechSynthesisUtterance(chunks[reader.chunk]);
    u.lang = "sv-SE";
    const v = currentVoice();
    if (v) u.voice = v;
    u.rate = parseFloat(els.rate.value) || 1;

    u.onend = () => {
      if (myToken !== reader.token || reader.paused || !reader.playing) return;
      reader.chunk++;
      if (reader.chunk >= chunks.length) {
        setTimeout(() => myToken === reader.token && nextItem(true), 700);
      } else {
        markReading();
        speakCurrent();
      }
    };
    u.onerror = (e) => {
      if (myToken !== reader.token) return;
      if (e.error === "interrupted" || e.error === "canceled") return;
      console.warn("Talfel:", e.error);
      reader.chunk++;
      speakCurrent();
    };

    els.nowTitle.textContent = item.title;
    markReading();
    synth.speak(u);
  }

  function start(queue, pos, continuous) {
    if (!synth) return;
    synth.cancel();
    Object.assign(reader, { queue, pos, chunk: 0, continuous, playing: true, paused: false });
    els.player.hidden = false;
    els.pause.textContent = "⏸";
    els.pause.setAttribute("aria-label", "Pausa");
    document.getElementById(`card-${queue[pos].id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    speakCurrent();
    // Räkna uppläsningar i besöksstatistiken (syns som händelser i GoatCounter)
    try {
      window.goatcounter?.count?.({
        path: continuous ? "lyssna-pa-alla" : "lyssna-" + queue[pos].sourceId,
        title: continuous ? "Lyssna på alla" : "Lyssna: " + queue[pos].source,
        event: true,
      });
    } catch { /* räknaren får aldrig störa uppläsningen */ }
  }

  function nextItem(auto = false) {
    if (auto && !reader.continuous) return stop();
    if (reader.pos >= reader.queue.length - 1) return stop();
    synth.cancel();
    reader.token++;
    reader.pos++;
    reader.chunk = 0;
    reader.paused = false;
    els.pause.textContent = "⏸";
    document.getElementById(`card-${reader.queue[reader.pos].id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    speakCurrent();
  }

  function prevItem() {
    synth.cancel();
    reader.token++;
    // Mitt i en nyhet: börja om den. Annars: gå till förra.
    if (reader.chunk === 0 && reader.pos > 0) reader.pos--;
    reader.chunk = 0;
    reader.paused = false;
    els.pause.textContent = "⏸";
    speakCurrent();
  }

  // Paus görs som stopp + omstart av meningen. Det fungerar i fler webbläsare
  // än synth.pause(), som är opålitlig i Chrome och på Android.
  function togglePause() {
    if (!reader.playing) return;
    if (reader.paused) {
      reader.paused = false;
      els.pause.textContent = "⏸";
      els.pause.setAttribute("aria-label", "Pausa");
      speakCurrent();
    } else {
      reader.paused = true;
      reader.token++;
      synth.cancel();
      els.pause.textContent = "▶";
      els.pause.setAttribute("aria-label", "Fortsätt");
    }
  }

  function stop() {
    reader.token++;
    reader.playing = false;
    reader.paused = false;
    synth?.cancel();
    els.player.hidden = true;
    markReading();
  }

  // ---------- Textstorlek ----------
  let scale = parseFloat(store.get("scale")) || 1;
  const applyScale = () => document.documentElement.style.setProperty("--font-scale", scale);
  applyScale();

  // ---------- Händelser ----------
  els.filters.addEventListener("click", (e) => {
    const b = e.target.closest("[data-filter]");
    if (!b) return;
    filter = b.dataset.filter;
    shown = PAGE;
    stop();
    renderFilters();
    renderGrid();
  });

  $("sourceSelect").addEventListener("change", (e) => {
    sourceFilter = e.target.value;
    shown = PAGE;
    stop();
    renderGrid();
  });

  $("showMore").addEventListener("click", () => {
    shown += PAGE;
    renderGrid();
  });

  let searchTimer;
  $("search").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      query = norm(e.target.value.trim());
      shown = PAGE;
      if (reader.playing) stop();
      renderGrid();
    }, 200);
  });

  els.grid.addEventListener("click", (e) => {
    const b = e.target.closest("[data-listen]");
    if (!b) return;
    const items = visibleItems();
    const idx = items.findIndex((x) => x.id === b.dataset.listen);
    if (reader.playing && reader.queue[reader.pos]?.id === b.dataset.listen) return stop();
    start(items, idx, false);
  });

  els.playAll.addEventListener("click", () => {
    const items = visibleItems();
    if (items.length) start(items, 0, true);
  });

  els.pause.addEventListener("click", togglePause);
  els.next.addEventListener("click", () => nextItem(false));
  els.prev.addEventListener("click", prevItem);
  els.stop.addEventListener("click", stop);

  els.rate.addEventListener("change", () => {
    store.set("rate", els.rate.value);
    if (reader.playing && !reader.paused) { synth.cancel(); speakCurrent(); }
  });
  els.voice.addEventListener("change", () => {
    store.set("voice", els.voice.value);
    if (reader.playing && !reader.paused) { synth.cancel(); speakCurrent(); }
  });

  els.smaller.addEventListener("click", () => { scale = Math.max(0.85, +(scale - 0.1).toFixed(2)); store.set("scale", scale); applyScale(); });
  els.bigger.addEventListener("click", () => { scale = Math.min(1.6, +(scale + 0.1).toFixed(2)); store.set("scale", scale); applyScale(); });

  document.addEventListener("keydown", (e) => {
    if (!reader.playing || e.target.closest("input, select, textarea")) return;
    if (e.key === " ") { e.preventDefault(); togglePause(); }
    if (e.key === "Escape") stop();
  });

  // ---------- Start ----------
  const savedRate = store.get("rate");
  if (savedRate) els.rate.value = savedRate;

  if (synth) {
    loadVoices();
    synth.addEventListener?.("voiceschanged", loadVoices);
    synth.cancel(); // rensar ev. fastnad kö i Chrome
  } else {
    els.playAll.hidden = true;
    els.sourceStatus.textContent = "Din webbläsare kan inte läsa upp text.";
  }

  // Visa antal besökare från GoatCounter i sidfoten (döljs om det inte går att hämta)
  fetch("https://nyhetslaget.goatcounter.com/counter/TOTAL.json")
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((d) => {
      if (!d || !d.count) return;
      const el = $("visits");
      el.textContent = `${String(d.count).replace(/[,.]/g, " ")} besökare hittills.`;
      el.hidden = false;
    })
    .catch(() => { /* t.ex. annonsblockerare – visa ingenting */ });

  load();
  setInterval(load, REFRESH_MS);
})();
