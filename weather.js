// Väder på Nyhetsläget: liten ruta i raden högst upp och vädersidan (vader.html).
// Data från Open-Meteo (CC BY 4.0). Hämtas direkt i besökarens webbläsare.

(() => {
  "use strict";
  const API = window.WEATHER_API || "https://api.open-meteo.com";
  const GEO = window.GEO_API || "https://geocoding-api.open-meteo.com";
  const DEFAULT = { name: "Hässleholm", region: "Skåne län", lat: 56.1589, lon: 13.7668 };
  const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const nf = (n, d = 0) => new Intl.NumberFormat("sv-SE", { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignoreras */ } },
  };

  // WMO-väderkoder till svensk text och symbol
  const CODES = {
    0: ["Klart", "☀️", "🌙"], 1: ["Mestadels klart", "🌤️", "🌙"], 2: ["Halvklart", "⛅", "☁️"], 3: ["Mulet", "☁️", "☁️"],
    45: ["Dimma", "🌫️"], 48: ["Dimma med rimfrost", "🌫️"],
    51: ["Lätt duggregn", "🌦️"], 53: ["Duggregn", "🌦️"], 55: ["Kraftigt duggregn", "🌧️"],
    56: ["Underkylt duggregn", "🌧️"], 57: ["Kraftigt underkylt duggregn", "🌧️"],
    61: ["Lätt regn", "🌦️"], 63: ["Regn", "🌧️"], 65: ["Kraftigt regn", "🌧️"],
    66: ["Underkylt regn", "🌧️"], 67: ["Kraftigt underkylt regn", "🌧️"],
    71: ["Lätt snöfall", "🌨️"], 73: ["Snöfall", "🌨️"], 75: ["Kraftigt snöfall", "❄️"], 77: ["Snökorn", "🌨️"],
    80: ["Lätta regnskurar", "🌦️"], 81: ["Regnskurar", "🌧️"], 82: ["Kraftiga regnskurar", "⛈️"],
    85: ["Snöbyar", "🌨️"], 86: ["Kraftiga snöbyar", "❄️"],
    95: ["Åska", "⛈️"], 96: ["Åska med hagel", "⛈️"], 99: ["Kraftig åska med hagel", "⛈️"],
  };
  const desc = (c) => (CODES[c] || ["Okänt väder"])[0];
  const icon = (c, day = 1) => { const e = CODES[c] || ["", "🌡️"]; return day || !e[2] ? e[1] : e[2]; };

  const place = () => store.get("wxPlace") || DEFAULT;

  async function forecast(p) {
    const key = `wx:${p.lat},${p.lon}`;
    try {
      const c = JSON.parse(sessionStorage.getItem(key));
      if (c && Date.now() - c.t < 15 * 60 * 1000) return c.d;
    } catch { /* ingen cache */ }
    const url = `${API}/v1/forecast?latitude=${p.lat}&longitude=${p.lon}` +
      "&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_gusts_10m,precipitation,is_day" +
      "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset" +
      "&timezone=Europe%2FStockholm&wind_speed_unit=ms&forecast_days=7";
    const r = await fetch(url);
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    try { sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), d })); } catch { /* ignoreras */ }
    return d;
  }

  // ---------- Liten ruta i raden högst upp ----------
  async function chip(el) {
    try {
      const p = place();
      const d = await forecast(p);
      const c = d.current;
      el.innerHTML = `<span aria-hidden="true">${icon(c.weather_code, c.is_day)}</span> <b>${esc(p.name)}</b> ${nf(c.temperature_2m)}°<span class="visually-hidden">, ${esc(desc(c.weather_code))}. Se vädret.</span>`;
      el.title = `${desc(c.weather_code)} – se prognosen`;
      el.hidden = false;
    } catch { /* inget väder – visa inget */ }
  }

  // ---------- Vädersidan ----------
  const DAYS = ["Sön", "Mån", "Tis", "Ons", "Tor", "Fre", "Lör"];
  const time = (iso) => iso.slice(11, 16).replace(":", ".");

  async function render(out, p) {
    out.innerHTML = `<p class="status">Hämtar prognos för ${esc(p.name)} …</p>`;
    try {
      const d = await forecast(p);
      const c = d.current, dl = d.daily;
      const today = `
        <section class="wx-card wx-now">
          <div>
            <h2>${esc(p.name)}<span class="sub">${esc([p.region, p.country].filter(Boolean).join(", "))}</span></h2>
            <p class="wx-temp"><span class="wx-icon" aria-hidden="true">${icon(c.weather_code, c.is_day)}</span>${nf(c.temperature_2m)}°</p>
            <p class="wx-desc">${esc(desc(c.weather_code))}</p>
          </div>
          <dl class="wx-facts">
            <div><dt>Känns som</dt><dd>${nf(c.apparent_temperature)}°</dd></div>
            <div><dt>Vind</dt><dd>${nf(c.wind_speed_10m)} m/s <span class="small">(byar ${nf(c.wind_gusts_10m)})</span></dd></div>
            <div><dt>I dag</dt><dd>${nf(dl.temperature_2m_max[0])}° / ${nf(dl.temperature_2m_min[0])}°</dd></div>
            <div><dt>Nederbörd i dag</dt><dd>${nf(dl.precipitation_sum[0], 1)} mm${dl.precipitation_probability_max?.[0] != null ? ` <span class="small">(${dl.precipitation_probability_max[0]} %)</span>` : ""}</dd></div>
            <div><dt>Soluppgång</dt><dd>${time(dl.sunrise[0])}</dd></div>
            <div><dt>Solnedgång</dt><dd>${time(dl.sunset[0])}</dd></div>
          </dl>
        </section>`;
      const rows = dl.time.map((t, i) => {
        const wd = i === 0 ? "I dag" : i === 1 ? "I morgon" : `${DAYS[new Date(t + "T12:00").getDay()]} ${new Date(t + "T12:00").getDate()}/${new Date(t + "T12:00").getMonth() + 1}`;
        return `<tr>
          <th scope="row">${wd}</th>
          <td class="wx-sym"><span aria-hidden="true">${icon(dl.weather_code[i])}</span> <span class="wx-txt">${esc(desc(dl.weather_code[i]))}</span></td>
          <td class="num"><b>${nf(dl.temperature_2m_max[i])}°</b> <span class="small">/ ${nf(dl.temperature_2m_min[i])}°</span></td>
          <td class="num">${nf(dl.precipitation_sum[i], 1)} mm</td>
          <td class="num">${nf(dl.wind_speed_10m_max[i])} m/s</td>
        </tr>`;
      }).join("");
      out.innerHTML = today + `
        <section class="wx-card">
          <h2>7 dagar</h2>
          <table class="wx-table">
            <thead><tr><th scope="col">Dag</th><th scope="col">Väder</th><th scope="col" class="num">Max / min</th><th scope="col" class="num"><span class="wx-lg">Nederbörd</span><span class="wx-sm" aria-hidden="true">Nederb.</span></th><th scope="col" class="num">Vind</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </section>`;
    } catch {
      out.innerHTML = `<p class="status">Prognosen kunde inte hämtas just nu. Försök igen om en stund.</p>`;
    }
  }

  function page(root) {
    const input = root.querySelector("#wxSearch"), list = root.querySelector("#wxResults"), out = root.querySelector("#wxOut");
    let timer;
    input.addEventListener("input", () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) { list.innerHTML = ""; return; }
      timer = setTimeout(async () => {
        try {
          const r = await fetch(`${GEO}/v1/search?name=${encodeURIComponent(q)}&count=6&language=sv&format=json`);
          const d = await r.json();
          const res = d.results || [];
          list.innerHTML = res.length ? res.map((x, i) =>
            `<li><button type="button" data-i="${i}">${esc(x.name)} <span class="small">${esc([x.admin1, x.country].filter(Boolean).join(", "))}</span></button></li>`).join("")
            : `<li class="small">Hittade ingen ort.</li>`;
          list.onclick = (e) => {
            const b = e.target.closest("[data-i]"); if (!b) return;
            const x = res[+b.dataset.i];
            const p = { name: x.name, region: x.admin1 || "", country: x.country_code === "SE" ? "" : x.country || "", lat: +x.latitude.toFixed(4), lon: +x.longitude.toFixed(4) };
            store.set("wxPlace", p);
            input.value = ""; list.innerHTML = "";
            render(out, p);
          };
        } catch { list.innerHTML = `<li class="small">Sökningen fungerar inte just nu.</li>`; }
      }, 300);
    });
    root.querySelector("#wxHome").addEventListener("click", () => { store.set("wxPlace", DEFAULT); render(out, DEFAULT); });
    render(out, place());
  }

  window.Weather = { chip, page };
})();
