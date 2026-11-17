// Börsrad högst upp på Nyhetsläget och börssidan (borsen.html).
// Läser data/market.json som uppdateras varje timme av GitHub Actions.

(() => {
  "use strict";
  const nf = (n, d = 2) => new Intl.NumberFormat("sv-SE", { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
  const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const DAYS = ["söndag", "måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag"];

  function when(iso) {
    const d = new Date(iso);
    const t = d.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Stockholm" });
    const dt = d.toLocaleDateString("sv-SE", { day: "numeric", month: "long", timeZone: "Europe/Stockholm" });
    return `${DAYS[d.getDay()]} ${dt} kl. ${t}`;
  }

  // Upp/ner med pil OCH text, så att det inte bara syns med färg
  function change(x, colored = true) {
    const dir = x.change > 0 ? "up" : x.change < 0 ? "down" : "flat";
    const arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : "■";
    const sign = x.changePct > 0 ? "+" : "";
    const word = dir === "up" ? "upp" : dir === "down" ? "ner" : "oförändrat";
    return `<span class="chg ${colored ? dir : "neutral"}" title="${word} ${nf(Math.abs(x.changePct))} %"><span aria-hidden="true">${arrow}</span> ${sign}${nf(x.changePct)} %<span class="visually-hidden"> ${word}</span></span>`;
  }

  async function load() {
    const r = await fetch(`data/market.json?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    return r.json();
  }

  // ---------- Smal rad högst upp ----------
  async function ticker(el) {
    try {
      const m = await load();
      const parts = [];
      if (m.index) parts.push(`<span class="tk"><b>OMXS30</b> ${nf(m.index.last)} ${change(m.index)}</span>`);
      for (const f of m.fx) parts.push(`<span class="tk"><b>${esc(f.name)}</b> ${nf(f.last)} kr ${change(f, false)}</span>`);
      if (!parts.length) return;
      el.innerHTML = `<a class="ticker-link" href="borsen.html" aria-label="Börsen: se mer"><div class="wrap ticker-inner">${parts.join("")}<span class="tk-more">Börsen →</span></div></a>`;
      el.hidden = false;
    } catch { /* ingen börsdata – visa inget */ }
  }

  // ---------- Linjediagram med hovring ----------
  function chart(series, { unit = "", decimals = 2, label = "", W = 640 } = {}) {
    const H = W < 640 ? 240 : 220, P = { l: 56, r: 16, t: 14, b: 28 };
    const ys = series.map((p) => p.c);
    let min = Math.min(...ys), max = Math.max(...ys);
    const pad = (max - min) * 0.12 || max * 0.01;
    min -= pad; max += pad;
    const x = (i) => P.l + (i / Math.max(1, series.length - 1)) * (W - P.l - P.r);
    const y = (v) => P.t + (1 - (v - min) / (max - min)) * (H - P.t - P.b);
    const d = series.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.c).toFixed(1)}`).join("");
    const ticks = [min + pad, (min + max) / 2, max - pad];
    const fmtDay = (s) => new Date(s).toLocaleDateString("sv-SE", { day: "numeric", month: "short" });
    const xt = [0, Math.floor((series.length - 1) / 2), series.length - 1];
    return `
    <div class="chart" data-w="${W}" data-series='${esc(JSON.stringify(series))}' data-unit="${esc(unit)}" data-dec="${decimals}">
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">
        ${ticks.map((v) => `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${P.l - 8}" y="${y(v) + 4}" text-anchor="end">${nf(v, decimals === 4 ? 2 : 0)}</text>`).join("")}
        ${xt.map((i) => `<text class="ax" x="${x(i)}" y="${H - 8}" text-anchor="${i === 0 ? "start" : i === series.length - 1 ? "end" : "middle"}">${fmtDay(series[i].d)}</text>`).join("")}
        <path class="line" d="${d}"/>
        <circle class="end" cx="${x(series.length - 1)}" cy="${y(ys[ys.length - 1])}" r="4.5"/>
        <line class="cross" y1="${P.t}" y2="${H - P.b}" x1="0" x2="0" hidden/>
        <circle class="dot" r="5" hidden/>
        <rect class="hit" x="${P.l}" y="${P.t}" width="${W - P.l - P.r}" height="${H - P.t - P.b}" fill="transparent"/>
      </svg>
      <div class="tip" hidden></div>
    </div>`;
  }

  function wireCharts(root) {
    root.querySelectorAll(".chart").forEach((c) => {
      const s = JSON.parse(c.dataset.series), unit = c.dataset.unit, dec = +c.dataset.dec;
      const svg = c.querySelector("svg"), hit = c.querySelector(".hit"), cross = c.querySelector(".cross"), dot = c.querySelector(".dot"), tip = c.querySelector(".tip");
      const path = c.querySelector(".line");
      const pts = path.getAttribute("d").slice(1).split("L").map((p) => p.split(",").map(Number));
      function show(evt) {
        const pt = svg.createSVGPoint(); pt.x = evt.clientX; pt.y = evt.clientY;
        const loc = pt.matrixTransform(svg.getScreenCTM().inverse());
        let i = 0, best = Infinity;
        pts.forEach(([px], k) => { const dd = Math.abs(px - loc.x); if (dd < best) { best = dd; i = k; } });
        const [px, py] = pts[i];
        cross.setAttribute("x1", px); cross.setAttribute("x2", px); cross.hidden = false;
        dot.setAttribute("cx", px); dot.setAttribute("cy", py); dot.hidden = false;
        tip.innerHTML = `<b>${nf(s[i].c, dec)}${unit}</b><br>${new Date(s[i].d).toLocaleDateString("sv-SE", { weekday: "short", day: "numeric", month: "long" })}`;
        tip.hidden = false;
        const box = c.getBoundingClientRect(), sb = svg.getBoundingClientRect();
        const left = (px / +c.dataset.w) * sb.width;
        tip.style.left = `${Math.min(Math.max(left, 60), box.width - 60)}px`;
      }
      const hide = () => { cross.hidden = dot.hidden = tip.hidden = true; };
      hit.addEventListener("pointermove", show);
      hit.addEventListener("pointerdown", show);
      hit.addEventListener("pointerleave", hide);
    });
  }

  // ---------- Börssidan ----------
  async function page(el) {
    try {
      const m = await load();
      const blocks = [];
      if (m.index) {
        const i = m.index;
        blocks.push(`
        <section class="mk-card mk-main">
          <h2>OMXS30 <span class="sub">Stockholmsbörsens 30 största bolag</span></h2>
          <p class="big">${nf(i.last)} ${change(i)}</p>
          <p class="small">Förändring sedan föregående stängning: ${i.change > 0 ? "+" : ""}${nf(i.change)} punkter. Senaste värde: ${when(i.asOf)}.</p>
          ${chart(i.history, { label: "OMXS30 senaste månaden" })}
          <p class="small">Senaste månaden, stängningskurs per dag.</p>
        </section>`);
      }
      for (const f of m.fx) {
        blocks.push(`
        <section class="mk-card">
          <h2>${esc(f.name)} <span class="sub">1 ${esc(f.code)} i svenska kronor</span></h2>
          <p class="big">${nf(f.last)} kr ${change(f, false)}</p>
          <p class="small">Riksbankens kurs ${when(f.asOf).replace(/ kl\..*/, "")}.</p>
          ${chart(f.history, { unit: " kr", decimals: 4, label: `${f.name} i kronor senaste månaden`, W: 420 })}
        </section>`);
      }
      const src = [...new Set([m.index?.source, ...m.fx.map((f) => f.source)].filter(Boolean))].join(", ");
      el.innerHTML = `<div class="mk-grid">${blocks.join("")}</div>
        <p class="small mk-note">Uppgifterna uppdateras en gång i timmen och kan vara fördröjda. Källor: ${esc(src)}.
        Stockholmsbörsen är öppen vardagar kl. 09.00–17.30. Sidan är bara information och inte råd om att köpa eller sälja.</p>`;
      wireCharts(el);
    } catch {
      el.innerHTML = `<p class="status">Börsuppgifterna kunde inte hämtas just nu.</p>`;
    }
  }

  window.Market = { ticker, page };
})();
