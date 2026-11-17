// Ritar upp ett nyhetsquiz som HTML, i elev- eller lärarversion.
// Används både på quiz.html i webbläsaren och av scripts/make-quiz.mjs när PDF:erna skapas.

(function (root) {
  "use strict";

  const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const LETTERS = "ABCD";

  function points(quiz) {
    const Q = quiz.questions || quiz.partB;
    return { total: Q.mc.length + Q.words.length };
  }

  function options(q, teacher) {
    return `<ol class="opts">${q.options
      .map((o, i) => {
        const right = teacher && i === q.answer;
        return `<li class="${right ? "right" : ""}"><span class="box">${right ? "✔" : ""}</span><span class="letter">${LETTERS[i]}</span> ${esc(o)}</li>`;
      })
      .join("")}</ol>`;
  }

  function mcBlock(list, prefix, teacher, start) {
    return list
      .map((q, i) => `
      <div class="q">
        <p class="qtext"><span class="qnum">${prefix}${start + i}.</span> ${esc(q.q)} ${teacher && q.news ? `<span class="ref">(nyhet ${q.news})</span>` : ""}</p>
        ${options(q, teacher)}
        ${teacher ? `<p class="facit"><b>Rätt svar: ${LETTERS[q.answer]}.</b> ${esc(q.explanation || "")}</p>` : ""}
      </div>`)
      .join("");
  }

  function wordBlock(list, prefix, teacher, start) {
    return list
      .map((w, i) => `
      <div class="q">
        <p class="qtext"><span class="qnum">${prefix}${start + i}.</span> Vad betyder <b>${esc(w.word)}</b>?</p>
        ${w.context ? `<p class="context">”${esc(w.context)}”</p>` : ""}
        ${options(w, teacher)}
        ${teacher ? `<p class="facit"><b>Rätt svar: ${LETTERS[w.answer]}.</b> ${esc(w.explanation || "")}</p>` : ""}
      </div>`)
      .join("");
  }

  function render(quiz, version) {
    const teacher = version === "larare";
    const p = points(quiz);
    const B = quiz.questions || quiz.partB;

    return `
<article class="quiz ${teacher ? "teacher" : "student"}">
  <header class="qhead">
    <div>
      <p class="kicker">Nyhetsläget · ${teacher ? "Lärarversion med facit" : "Elevversion"}</p>
      <h1>${esc(quiz.title)}</h1>
      <p class="period">Nyheter från ${esc(quiz.period)}</p>
    </div>
    ${teacher
      ? `<div class="pointsbox"><b>Poäng</b><br>1 p per fråga<br><b>Totalt: ${p.total} p</b></div>`
      : `<div class="namebox">Namn: <span class="line"></span><br>Klass: <span class="line short"></span></div>`}
  </header>

  ${teacher ? `
  <section class="note">
    <p><b>Om quizet.</b> ${esc(quiz.teacherIntro || "")}</p>
    <p class="small">Frågorna är skrivna av AI utifrån nyheternas rubriker och ingresser. Läs igenom facit och bakgrund innan lektionen.</p>
    ${quiz.lessonTips?.length ? `<p><b>Förslag på upplägg</b></p><ul>${quiz.lessonTips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
  </section>` : ""}

  ${teacher ? `
  <section>
    <h2>Nyheterna i quizet</h2>
    <p class="instr">Eleverna letar själva efter nyheterna på sajten. Här är de sex nyheterna frågorna bygger på.</p>
    <ol class="news">
      ${quiz.news.map((n) => `
      <li>
        <p class="ntitle">${esc(n.title)} <span class="ref">– på sajten: ”${esc(n.originalTitle || n.title)}”</span></p>
        <p>${esc(n.studentSummary)}</p>
        <p class="bg"><b>Bakgrund:</b> ${esc(n.teacherBackground || "")}</p>
        <p class="src">Källa: ${esc(n.source)} – ${esc(n.link)}</p>
      </li>`).join("")}
    </ol>
  </section>` : ""}

  <section class="part">
    <h2>Frågor om nyheterna</h2>
    <p class="instr">Sätt ett kryss vid rätt svar.</p>
    ${mcBlock(B.mc, "", teacher, 1)}
    <h2>Ord</h2>
    <p class="instr">Vad betyder ordet? Sätt ett kryss.</p>
    ${wordBlock(B.words, "", teacher, B.mc.length + 1)}
  </section>

  <section class="part disc-part">
    ${B.discussion.map((d, i) => `
    <div class="q disc">
      ${i === 0 ? `<h2>Prata om nyheterna</h2><p class="instr">Diskutera i par eller i grupp.${teacher ? "" : " Skriv gärna stödord."}</p>` : ""}
      <p class="qtext"><span class="qnum">${i + 1}.</span> ${esc(d.q)} ${teacher && d.news ? `<span class="ref">(nyhet ${d.news})</span>` : ""}</p>
      ${teacher ? `<p class="facit"><b>Tips:</b> ${esc(d.tips || "")}</p>` : `<div class="lines"><span></span><span></span></div>`}
    </div>`).join("")}
  </section>

  ${teacher ? `
  <section class="part">
    <h2>Facit i korthet</h2>
    <p>${[...B.mc, ...B.words].map((q, i) => `${i + 1}.&nbsp;${LETTERS[q.answer]}`).join(" · ")}</p>
  </section>` : ""}

  <footer class="qfoot">Nyhetsläget – nyheter från Sverige och världen · ${esc(quiz.id)}</footer>
</article>`;
  }

  const CSS = `
.quiz { --ink:#14213d; --soft:#4a5568; --accent:#e85d04; --line:#d9d4c7; color:var(--ink);
  font-family: Inter,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif; line-height:1.45; max-width:780px; margin:0 auto; }
.quiz h1 { font-size:1.9rem; margin:.1rem 0; line-height:1.15; }
.quiz h2 { font-size:1.3rem; margin:1.6rem 0 .5rem; padding-bottom:.25rem; border-bottom:3px solid var(--ink); }
.quiz h3 { font-size:1.05rem; margin:1rem 0 .2rem; }
.quiz .kicker { text-transform:uppercase; letter-spacing:.08em; font-size:.75rem; font-weight:700; color:var(--accent); margin:0; }
.quiz .period { margin:0; color:var(--soft); }
.qhead { display:flex; justify-content:space-between; gap:1rem; align-items:flex-start; border-bottom:1px solid var(--line); padding-bottom:.8rem; }
.namebox { line-height:2.2; white-space:nowrap; }
@media screen and (max-width:600px) { .qhead { flex-wrap:wrap; } .namebox .line { width:140px; } .quiz h1 { font-size:1.6rem; } }
.namebox .line { display:inline-block; width:170px; border-bottom:1px solid var(--ink); }
.namebox .line.short { width:90px; }
.pointsbox { border:2px solid var(--ink); border-radius:8px; padding:.5rem .8rem; font-size:.9rem; white-space:nowrap; }
.findbox { border:3px dashed var(--accent); border-radius:10px; padding:.7rem 1rem; margin-top:1rem; }
.findbox p { margin:.15rem 0; } .findtitle { font-weight:800; font-size:1.15rem; }
.note { background:#fff6e6; border-left:5px solid var(--accent); padding:.6rem .9rem; margin-top:1rem; border-radius:4px; }
.note p { margin:.3rem 0; } .note ul { margin:.2rem 0 .3rem 1.1rem; padding:0; }
.small { font-size:.85rem; color:var(--soft); }
.news { padding-left:1.4rem; } .news li { margin-bottom:.7rem; break-inside:avoid; }
.news p { margin:.1rem 0; } .ntitle { font-weight:700; }
.bg { font-size:.92rem; background:#f2f5fa; padding:.35rem .55rem; border-radius:4px; margin-top:.3rem !important; }
.src { font-size:.75rem; color:var(--soft); word-break:break-all; }
.lvl { font-size:.8rem; font-weight:600; background:var(--ink); color:#fff; border-radius:999px; padding:.1rem .6rem; vertical-align:middle; margin-left:.4rem; }
.instr { margin:.1rem 0 .4rem; font-style:italic; color:var(--soft); }
.q { margin:.55rem 0 .8rem; break-inside:avoid; }
.qtext { margin:0 0 .25rem; font-weight:600; }
.qnum { display:inline-block; min-width:2.1rem; font-weight:800; }
.ref { font-weight:400; color:var(--soft); font-size:.85rem; }
.context { margin:0 0 .25rem 2.1rem; font-style:italic; color:var(--soft); }
.opts { list-style:none; margin:0 0 0 2.1rem; padding:0; }
.opts li { margin:.15rem 0; display:flex; gap:.45rem; align-items:baseline; }
.box { display:inline-flex; width:1rem; height:1rem; border:1.5px solid var(--ink); border-radius:3px; flex:none; align-items:center; justify-content:center; font-size:.8rem; position:relative; top:.15rem; }
.letter { font-weight:700; min-width:1rem; }
.opts li.right { font-weight:700; }
.opts li.right .box { background:var(--ink); color:#fff; }
.facit { margin:.25rem 0 0 2.1rem; font-size:.9rem; background:#eef7ee; border-left:3px solid #2f855a; padding:.25rem .5rem; }
.lines span { display:block; border-bottom:1px solid var(--line); height:1.7rem; margin-left:2.1rem; }
.qfoot { margin-top:2rem; font-size:.75rem; color:var(--soft); border-top:1px solid var(--line); padding-top:.4rem; }
@media print {
  @page { size:A4; margin:16mm 15mm; }
  .quiz { font-size:10.5pt; max-width:none; }
  .quiz h2 { break-after:avoid; } .quiz h3 { break-after:avoid; }
  .part { break-before:auto; }
  .opts { display:grid; grid-template-columns:1fr 1fr; column-gap:1.2rem; }
  .q { margin:.35rem 0 .55rem; }
  .student .lines span { height:1.25rem; }
  .disc { margin:.25rem 0 .4rem; }
  .qfoot { margin-top:.5rem; padding-top:.2rem; break-before:avoid; }
  .disc-part h2 { margin-top:1rem; }
  .quiz h2 { margin:1.1rem 0 .4rem; }
}`;

  root.QuizRender = { render, CSS, points };
})(typeof globalThis !== "undefined" ? globalThis : this);
