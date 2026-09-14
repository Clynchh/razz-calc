// Razz 3rd Street — opening threshold, by position.
//
// Set the six upcards in seat order and pick your seat. The bar you must clear
// comes from pot odds and the chance everyone behind folds; the open/fold call
// itself is made on *realised* value with 4th-7th played out.

import { rankChar } from "./hands.js";
import { loadHu } from "./hu.js";
import { loadReal } from "./real.js";
import { heatColor, changeColor, rgbCss, textOn } from "./color.js";
import { DOWN, idxOf, handEquities as calcHandEquities } from "./opencalc.js";
import { CONTINUE, seating, requirement } from "./openrule.js";

const $ = (id) => document.getElementById(id);

const state = {
  hu: null, avg: null,
  reals: [],                  // one realised table per lookahead setting
  ups: [0, 2, 4, 6, 8, 12],   // A 3 5 7 9 K — rightmost is always the bring-in
  hero: 0,
  biExtra: 0.45,
  view: "absolute",
  colorBy: "equity",
  cellVal: "equity",
  fit: true,
  pmin: 0, pmax: 100,
  emin: 0, emax: 100,
  eq: new Map(),              // downIdx -> {e, eRaise, ev, w, pct, base, rank}
  cmpUps: new Set(),          // upcards overlaid on the distribution chart
  distY: "ev",                // distribution y-axis: "ev" or "equity"
  req: null,
};

const cellEl = Array.from({ length: 13 }, () => new Array(13).fill(null));

boot();

async function boot() {
  try {
    $("loading-label").textContent = "Loading equity matrix";
    const [hu, avg] = await Promise.all([
      loadHu("./data/hu.bin", (f) => setBar(f)),
      fetch("./data/average.json").then((r) => (r.ok ? r.json() : null)),
    ]);
    state.hu = hu;
    state.avg = avg?.meanEquity;
    if (!state.avg) throw new Error("average.json is needed to order calling ranges");
    // Later-street play has a free parameter — how many bets a caller prices
    // into its decision. Lookahead 2 is closer to right on 4th (a caller can
    // still fold on 5th); lookahead 4 is closer on 5th (callers there mostly go
    // to the river); they agree on 6th and 7th. Each is right on one street and
    // wrong on the other, so they are weighted equally. The visible-board table
    // prices calls off the wrong information and is only a fallback.
    const load = async (file, label) => {
      try {
        $("loading-label").textContent = `Loading ${label}`;
        const t = await loadReal(file, (f) => f != null && setBar(f));
        state.reals.push({ table: t, label, file });
      } catch { /* optional */ }
    };
    await load("./data/real-la2.bin", "2-street");
    await load("./data/real-la4.bin", "4-street");
    if (!state.reals.length) await load("./data/real.bin", "visible-board");
  } catch (err) {
    const box = $("loading-error");
    box.hidden = false;
    box.textContent = "Could not load data/hu.bin. Run  make hu\n\n(" + err.message + ")";
    $("bar-fill").style.background = "var(--muted)";
    return;
  }
  buildSeats();
  buildGrid();
  wire();
  recompute();
  $("loading").hidden = true;
  $("app").hidden = false;
}
function setBar(f) {
  $("bar-fill").style.width = Math.round(100 * f) + "%";
  $("loading-pct").textContent = Math.round(100 * f) + "%";
}

// ---- seats -------------------------------------------------------
function buildSeats() {
  const root = $("seats");
  root.innerHTML = "";
  for (let i = 0; i < state.ups.length; i++) {
    const box = document.createElement("div");
    box.className = "seat";
    const who = document.createElement("div");
    who.className = "who";
    const sel = document.createElement("select");
    sel.addEventListener("change", () => {
      setUpcard(i, Number(sel.value));
      recompute();
    });
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "you";
    btn.addEventListener("click", () => {
      state.hero = i;
      recompute();
    });
    box.append(who, sel, btn);
    root.appendChild(box);
  }
}

/**
 * Ranks a seat may legally take, given every other seat.
 *
 * Two rules, both enforced by filtering the options rather than by correcting
 * the choice afterwards — an unselectable option is clearer than a selection
 * that silently changes to something else.
 *
 *   1. Only four of any rank exist. Five kings is not a board.
 *   2. The rightmost seat brings in, so it cannot sit below any other seat and
 *      no other seat can sit above it. Equal is fine and leaves the bring-in
 *      where it is.
 */
function allowedRanks(i) {
  const bi = state.ups.length - 1;
  const used = new Array(13).fill(0);
  for (let k = 0; k < state.ups.length; k++) if (k !== i) used[state.ups[k]]++;

  let lo = 0, hi = 12;
  if (i === bi) {
    for (let k = 0; k < bi; k++) lo = Math.max(lo, state.ups[k]);   // never below a rival
  } else {
    hi = state.ups[bi];                                             // never above the bring-in
  }
  const out = [];
  for (let r = lo; r <= hi; r++) if (used[r] < 4) out.push(r);
  // always keep the current value selectable so the control cannot go blank
  if (!out.includes(state.ups[i])) out.push(state.ups[i]);
  return out.sort((a, b) => a - b);
}

function setUpcard(i, rank) {
  if (allowedRanks(i).includes(rank)) state.ups[i] = rank;
}

function syncSeats() {
  const bi = state.ups.length - 1;
  const { order } = seating(state.ups);
  const kids = $("seats").children;
  for (let i = 0; i < kids.length; i++) {
    const sel = kids[i].querySelector("select");
    sel.innerHTML = "";
    for (const r of allowedRanks(i)) {
      const o = document.createElement("option");
      o.value = String(r);
      o.textContent = rankChar(r);
      sel.appendChild(o);
    }
    sel.value = String(state.ups[i]);
    kids[i].querySelector(".who").innerHTML =
      i === bi ? "<b>bring-in</b>" : `BI+${order.indexOf(i) + 1}`;
    kids[i].classList.toggle("hero", i === state.hero);
    kids[i].classList.toggle("bi", i === bi);
    kids[i].querySelector("button").disabled = i === bi;
  }
}

// ---- derived state ----------------------------------------------
const handEquities = (heroUp, req) => calcHandEquities(state, heroUp, req);

function recompute() {
  const req = requirement(state.ups, state.hero, state.biExtra);
  state.req = req;
  state.eq = new Map();
  if (!req) return render();
  state.eq = handEquities(state.ups[state.hero], req);

  // combo-weighted percentile and rank, both against *this* board
  const ids = [...state.eq.keys()].sort((a2, b2) => state.eq.get(a2).e - state.eq.get(b2).e);
  const total = ids.reduce((s2, i) => s2 + state.eq.get(i).w, 0);
  let cum = 0;
  for (const i of ids) {
    const r = state.eq.get(i);
    r.pct = 100 * (1 - (cum + 0.5 * r.w) / total);   // 0 = strongest
    cum += r.w;
  }
  const byBase = [...state.eq.keys()].sort((a2, b2) => state.eq.get(a2).base - state.eq.get(b2).base);
  let cb = 0;
  for (const i of byBase) {
    const r = state.eq.get(i);
    r.basePct = 100 * (1 - (cb + 0.5 * r.w) / total);
    cb += r.w;
  }
  const desc = [...state.eq.keys()].sort((a2, b2) => state.eq.get(b2).e - state.eq.get(a2).e);
  desc.forEach((i, k) => (state.eq.get(i).rank = k + 1));
  render();
}

// ---- grid --------------------------------------------------------
function buildGrid() {
  const root = $("matrix");
  root.style.setProperty("--cell", "52px");
  for (let i = 0; i < 13; i++)
    for (let c = i; c < 13; c++) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "cell";
      el.style.gridRow = String(i + 1);
      el.style.gridColumn = String(c + 1);
      el.tabIndex = -1;
      const lbl = document.createElement("span");
      lbl.className = "lbl";
      const val = document.createElement("span");
      val.className = "val";
      el.append(lbl, val);
      el.addEventListener("mouseenter", () => showTip(el, i, c));
      el.addEventListener("mouseleave", hideTip);
      cellEl[i][c] = el;
      root.appendChild(el);
    }
}
const downcardsFor = (i, c) => (c < 12 ? [i, c + 1] : [i, i]);

function inBands(r) {
  if (r.pct < state.pmin || r.pct > state.pmax) return false;
  const e = 100 * r.e;
  return e >= state.emin && e <= state.emax;
}

function render() {
  syncSeats();
  const req = state.req;
  $("bi-label").textContent = `+${Math.round(100 * state.biExtra)} points`;
  $("rates").textContent = state.ups.map((u) => `${rankChar(u)} ${Math.round(100 * CONTINUE[u])}%`).join("   ");
  $("basis").innerHTML = state.reals.length
    ? "Decisions use <strong>realised</strong> values — 4th&ndash;7th are played out — under " +
      state.reals.length + " calling assumption" + (state.reals.length === 1 ? "" : "s") +
      " (" + state.reals.map((r) => r.label).join(", ") + ")" +
      (state.reals.length > 1 ? ", weighted equally" : "") + ". " +
      "EV is measured <strong>against folding</strong>: above 0 completes, 0 or below folds."
    : "<strong>All-in only</strong> — no realised table found. Run <code>make realtab-bracket</code>.";

  if (!req) {
    $("req").textContent = "—";
    $("reqsub").textContent = "That seat is the bring-in: posting is forced.";
    $("opens").textContent = "";
    $("why").textContent = "Pick any seat other than the rightmost.";
    for (let i = 0; i < 13; i++) for (let c = i; c < 13; c++) blank(cellEl[i][c], downcardsFor(i, c));
    $("top-list").innerHTML = "";
    return;
  }

  let best = 0;
  for (const v of state.eq.values()) best = Math.max(best, v.e);
  const anchor = state.fit ? Math.max(best, 1e-9) : 1;
  const change = state.view === "change";
  let openW = 0, allW = 0, pIn = 0, eIn = 0;

  for (let i = 0; i < 13; i++)
    for (let c = i; c < 13; c++) {
      const el = cellEl[i][c];
      const d = downcardsFor(i, c);
      const r = state.eq.get(idxOf(d));
      el.querySelector(".lbl").textContent = d.map(rankChar).join("");
      if (!r) { blank(el, d); continue; }
      el.classList.remove("infeasible");

      const rgb = change
        ? changeColor(r.basePct - r.pct)
        : heatColor(state.colorBy === "equity" ? 100 * (1 - r.e / anchor) : r.pct);
      el.style.background = rgbCss(rgb);
      el.style.color = textOn(rgb);
      el.querySelector(".val").textContent = cellText(r, change);

      el.classList.toggle("outside", !(r.opens && inBands(r)));
      allW += r.w;
      if (r.opens) openW += r.w;
      if (r.pct >= state.pmin && r.pct <= state.pmax) pIn += r.w;
      if (100 * r.e >= state.emin && 100 * r.e <= state.emax) eIn += r.w;
    }

  // the weakest hand that completes, by all-in equity. Realised EV does not
  // fall in perfect equity order, so a few hands above this can still fold.
  let bar = 1;
  for (const v of state.eq.values()) if (v.opens) bar = Math.min(bar, v.e);
  $("req").textContent = bar > 0.999 ? "no opens" : `${(100 * bar).toFixed(1)}% equity`;
  $("reqsub").textContent =
    `BI+${req.pos}, ${req.behind.length} seat${req.behind.length === 1 ? "" : "s"} behind` +
    ` · raised ${(100 * req.pRaised).toFixed(0)}% of the time`;
  $("opens").innerHTML =
    `opens <strong>${(100 * (allW ? openW / allW : 0)).toFixed(1)}%</strong>` +
    ` of your range`;
  $("why").innerHTML =
    `All fold <strong>${(100 * req.pAllFold).toFixed(0)}%</strong> (win ${req.winFold}c) · ` +
    `called <strong>${(100 * req.pCallOnly).toFixed(0)}%</strong> (pot ${req.potCall}c) · ` +
    `<strong>raised ${(100 * req.pRaised).toFixed(0)}%</strong> (find 200c into ${req.potRaise}c, or fold). ` +
    `Raisers: ` + req.raisers.filter((r) => r.p > 0.02).sort((a, b) => b.p - a.p)
      .map((r) => `${rankChar(r.up)} ${(100 * r.p).toFixed(0)}%`).join(", ") + ".";
  $("p-label").textContent = `top ${state.pmin}% – ${state.pmax}%`;
  $("e-label").textContent = `${state.emin}% – ${state.emax}% equity`;
  $("p-count").textContent = `${(100 * (allW ? pIn / allW : 0)).toFixed(0)}% of combos in band`;
  $("e-count").textContent = `${(100 * (allW ? eIn / allW : 0)).toFixed(0)}% of combos in band`;
  fillBar("p-fill", state.pmin, state.pmax, 100);
  fillBar("e-fill", state.emin, state.emax, 100);

  buildLegend(change, anchor, best);
  buildTop();
}

function fillBar(id, lo, hi, max) {
  const f = $(id);
  f.style.left = (100 * lo) / max + "%";
  f.style.width = (100 * Math.max(0, hi - lo)) / max + "%";
}

function cellText(r, change) {
  if (change) {
    const d = r.basePct - r.pct;
    return (d >= 0 ? "+" : "−") + Math.abs(d).toFixed(1);
  }
  if (state.cellVal === "equity") return (100 * r.e).toFixed(0) + "%";
  if (state.cellVal === "percentile") return r.pct.toFixed(1) + "%";
  if (state.cellVal === "rank") return String(r.rank);
  return signed(r.ev);
}

const signed = (v, dp = 0) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(dp);

function blank(el, d) {
  el.classList.add("infeasible");
  el.classList.remove("outside");
  el.style.background = "";
  el.style.color = "";
  el.querySelector(".lbl").textContent = d.map(rankChar).join("");
  el.querySelector(".val").textContent = "n/a";
}

/** Strongest 10 for *this* board — hands reorder as the visible cards change. */
function buildTop() {
  const root = $("top-list");
  root.innerHTML = "";
  const heroUp = state.ups[state.hero];
  const order = [...state.eq.keys()].sort((a, b) => state.eq.get(b).e - state.eq.get(a).e);
  for (const i of order.slice(0, 10)) {
    const r = state.eq.get(i);
    const opens = r.opens;
    for (const [cls, text] of [
      ["n", String(r.rank)],
      ["h", `${DOWN[i].map(rankChar).join("-")}/${rankChar(heroUp)}`],
      ["e", (100 * r.e).toFixed(1) + "%"],
      ["v", signed(r.ev) + "c"],
    ]) {
      const s = document.createElement("span");
      s.className = opens ? `${cls} row-hi` : cls;
      s.textContent = text;
      root.appendChild(s);
    }
  }
}

function buildLegend(change, anchor, best) {
  const stops = [];
  if (change) {
    for (let d = -8; d <= 8; d++) stops.push(rgbCss(changeColor(d)));
    $("legend-left").textContent = "worsened −8";
    $("legend-right").textContent = "+8 improved";
  } else {
    for (let p = 0; p <= 100; p += 4) stops.push(rgbCss(heatColor(p)));
    $("legend-left").textContent =
      state.colorBy === "equity" ? `best ${(100 * anchor).toFixed(0)}%` : "strongest";
    $("legend-right").textContent = state.colorBy === "equity" ? "0%" : "weakest";
  }
  $("legend-bar").style.background = `linear-gradient(to right, ${stops.join(",")})`;
  void best;
}

// ---- distribution ------------------------------------------------
/** Distinct from the green primary, and from each other. */
const CMP_COLORS = ["#4A9DB5", "#D9A03A", "#C77DBB", "#8B9EB7", "#E2705A", "#7FB069"];

/** One curve: hands strongest to weakest, against cumulative share of combos. */
function curveFor(heroUp, req) {
  const m = heroUp === state.ups[state.hero] ? state.eq : handEquities(heroUp, req);
  // sorted by whatever is on the axis, so the curve stays monotonic and the
  // crossing point is where the range actually divides
  const key = state.distY === "ev" ? (r) => r.ev : (r) => r.e;
  const rows = [...m.entries()].map(([i, r]) => ({ i, ...r })).sort((x, y) => key(y) - key(x));
  const total = rows.reduce((s2, r) => s2 + r.w, 0) || 1;
  const spans = [];
  let at = 0;
  for (const r of rows) {
    spans.push({ lo: at / total, hi: (at + r.w) / total, r });
    at += r.w;
  }
  return { rows, total, spans };
}

/**
 * Every hand on the board, strongest to weakest, against how much of the range
 * sits at or above it — optionally with other upcards overlaid for comparison.
 *
 * Plotted against *cumulative combos* rather than hand count, because hands are
 * not equally likely: a paired holding is a third as common as two distinct
 * ranks, so a count-based curve would overstate how much range the tail holds.
 */
function showDist() {
  const req = state.req;
  if (!req || !state.eq.size) return;
  const heroUp = state.ups[state.hero];
  const evMode = state.distY === "ev";
  const W = 840, H = 300, PL = 56, PB = 34, PT = 10, PR = 10;
  const x = (f) => PL + f * (W - PL - PR);

  const primary = curveFor(heroUp, req);
  const cmp = [...state.cmpUps].filter((u) => u !== heroUp).sort((p, q) => p - q)
    .map((u, k) => ({ up: u, color: CMP_COLORS[k % CMP_COLORS.length], ...curveFor(u, req) }));
  const val = (r) => (evMode ? r.ev : r.e);

  // EV has no natural bounds the way equity does, so the domain is taken from
  // the data and padded, with the fold line always inside it
  let lo = 0, hi = 1;
  if (evMode) {
    lo = 0; hi = 0;
    for (const c of [primary, ...cmp])
      for (const r of c.rows) { lo = Math.min(lo, r.ev); hi = Math.max(hi, r.ev); }
    const pad = Math.max(10, 0.08 * (hi - lo));
    lo -= pad; hi += pad;
  }
  const y = (v) => PT + (1 - (v - lo) / (hi - lo)) * (H - PT - PB);

  const pathOf = (c) => {
    let d = "", at = 0;
    for (const r of c.rows) {
      d += `${d ? "L" : "M"}${x(at / c.total).toFixed(1)},${y(val(r)).toFixed(1)}`;
      at += r.w;
      d += `L${x(at / c.total).toFixed(1)},${y(val(r)).toFixed(1)}`;
    }
    return d;
  };

  let bar = 1;
  for (const r of primary.rows) if (r.opens) bar = Math.min(bar, r.e);
  const hasBar = bar <= 0.999;
  const openCum = primary.rows.reduce((s2, r) => s2 + (r.opens ? r.w : 0), 0);

  const yTicks = evMode
    ? [0, 0.25, 0.5, 0.75, 1].map((t) => lo + t * (hi - lo))
    : [0, 0.25, 0.5, 0.75, 1];
  const fmtY = (v) => (evMode ? `${signed(v)}c` : `${Math.round(100 * v)}%`);
  const grid = yTicks.map((v) =>
      `<line x1="${x(0)}" y1="${y(v)}" x2="${x(1)}" y2="${y(v)}" stroke="#333b37"/>` +
      `<text x="${x(0) - 8}" y="${y(v) + 4}" fill="#8c9490" font-size="11" text-anchor="end">${fmtY(v)}</text>`).join("") +
    [0, 0.25, 0.5, 0.75, 1].map((v) =>
      `<text x="${x(v)}" y="${H - 12}" fill="#8c9490" font-size="11" text-anchor="middle">${Math.round(100 * v)}%</text>`).join("");

  const shade = `<rect x="${x(0)}" y="${PT}" width="${x(openCum / primary.total) - x(0)}" ` +
                `height="${H - PT - PB}" fill="#3E8E5A" opacity="0.13"/>`;
  // in EV mode the line that matters is folding, not an equity bar
  const refY = evMode ? y(0) : hasBar ? y(bar) : null;
  const refLabel = evMode ? "fold line" : `bar ${(100 * bar).toFixed(1)}%`;
  const refLine = refY === null ? "" :
    `<line x1="${x(0)}" y1="${refY}" x2="${x(1)}" y2="${refY}" stroke="#C4492E" stroke-dasharray="4 3"/>` +
    `<text x="${x(1)}" y="${refY - 5}" fill="#C4492E" font-size="11" text-anchor="end">${refLabel}</text>`;

  $("dist-chart").innerHTML =
    `<svg id="dist-svg" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" ` +
    `aria-label="${evMode ? "EV" : "equity"} distribution across the range">${grid}${shade}` +
    cmp.map((c) => `<path d="${pathOf(c)}" fill="none" stroke="${c.color}" stroke-width="1.5" opacity="0.85"/>`).join("") +
    `<path d="${pathOf(primary)}" fill="none" stroke="#59D167" stroke-width="2"/>${refLine}` +
    `<line id="dist-cursor" x1="0" y1="${PT}" x2="0" y2="${H - PB}" stroke="#e8e6e0" stroke-opacity="0.45" visibility="hidden"/>` +
    cmp.map((c, k) => `<circle id="dist-dot-${k}" r="3" fill="${c.color}" visibility="hidden"/>`).join("") +
    `<circle id="dist-dot" r="4" fill="#59D167" stroke="#12160F" visibility="hidden"/>` +
    `<rect id="dist-hit" x="${x(0)}" y="${PT}" width="${x(1) - x(0)}" height="${H - PT - PB}" fill="transparent"/>` +
    `<text x="${x(0.5)}" y="${H - 1}" fill="#8c9490" font-size="11" text-anchor="middle">` +
    `cumulative share of your combos (best first)</text></svg>`;

  buildCmpPicker(heroUp, cmp);
  buildAxisPicker();

  const svg = $("dist-svg"), cursor = $("dist-cursor"), dot = $("dist-dot"), tip = $("dist-tip");
  const at = (c, f) => (c.spans.find((sp) => f >= sp.lo && f < sp.hi) ?? c.spans[c.spans.length - 1]).r;

  $("dist-hit").addEventListener("mousemove", (ev) => {
    const box = svg.getBoundingClientRect();
    const px = ((ev.clientX - box.left) / box.width) * W;
    const f = Math.min(0.9999, Math.max(0, (px - x(0)) / (x(1) - x(0))));
    const r = at(primary, f);
    cursor.setAttribute("x1", px); cursor.setAttribute("x2", px);
    cursor.setAttribute("visibility", "visible");
    dot.setAttribute("cx", px); dot.setAttribute("cy", y(val(r)));
    dot.setAttribute("visibility", "visible");
    cmp.forEach((c, k) => {
      const d2 = $(`dist-dot-${k}`), rr = at(c, f);
      d2.setAttribute("cx", px); d2.setAttribute("cy", y(val(rr)));
      d2.setAttribute("visibility", "visible");
    });
    const verdict = r.opens ? "complete" : "fold";
    const vcol = r.opens ? "#59D167" : "#C4492E";
    const lines = [
      `<div class="t-hand">${DOWN[r.i].map(rankChar).join("-")}/${rankChar(heroUp)}</div>`,
      `<div>EV vs fold ${signed(r.ev, 1)}c</div>`,
      `<div>equity     ${(100 * r.e).toFixed(1)}%</div>`,
      `<div>combos     ${r.w}</div>`,
      `<div>top        ${(100 * f).toFixed(1)}% of range</div>`,
      `<div style="color:${vcol}">${verdict}</div>`,
    ];
    for (const c of cmp) {
      const rr = at(c, f);
      lines.push(`<div style="color:${c.color}">${rankChar(c.up)}: ` +
        `${DOWN[rr.i].map(rankChar).join("-")}/${rankChar(c.up)} ` +
        `${evMode ? signed(rr.ev) + "c"
                  : (100 * rr.e).toFixed(1) + "%"}</div>`);
    }
    tip.innerHTML = lines.join("");
    tip.hidden = false;
    let tx = ev.clientX + 14, ty = ev.clientY + 14;
    if (tx + tip.offsetWidth > window.innerWidth - 8) tx = ev.clientX - tip.offsetWidth - 14;
    if (ty + tip.offsetHeight > window.innerHeight - 8) ty = ev.clientY - tip.offsetHeight - 14;
    tip.style.left = Math.max(8, tx) + "px";
    tip.style.top = Math.max(8, ty) + "px";
  });
  $("dist-hit").addEventListener("mouseleave", () => {
    cursor.setAttribute("visibility", "hidden");
    dot.setAttribute("visibility", "hidden");
    cmp.forEach((_, k) => $(`dist-dot-${k}`).setAttribute("visibility", "hidden"));
    tip.hidden = true;
  });

  $("dist-sub").textContent =
    `${primary.rows.length} hands behind a ${rankChar(heroUp)}, ${primary.total} combos · BI+${req.pos}` +
    (state.reals.length ? ` · ${state.reals.length} calling assumption${state.reals.length === 1 ? "" : "s"}` : "");
  $("dist-note").textContent = evMode
    ? `Above the dashed line completes, below it folds. The shaded band is the ` +
      `${(100 * openCum / primary.total).toFixed(1)}% of combos that complete.`
    : hasBar
      ? `The shaded band is the ${(100 * openCum / primary.total).toFixed(1)}% of combos that open. ` +
        `Where the curve is flat, many hands share almost the same equity — a threshold drawn ` +
        `there separates hands that are barely different.`
      : "No hand on this board clears the bar.";
  $("dist").hidden = false;
}

/** Equity reads as a strength ranking; EV says what the hand is actually worth. */
function buildAxisPicker() {
  const root = $("dist-axis");
  root.innerHTML = "";
  for (const [key, label] of [["ev", "EV (cents)"], ["equity", "Equity"]]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cmp-btn";
    b.style.width = "auto";
    b.style.padding = "0 10px";
    b.textContent = label;
    if (state.distY === key) { b.style.borderColor = "#59D167"; b.style.color = "#59D167"; }
    b.addEventListener("click", () => { state.distY = key; showDist(); });
    root.appendChild(b);
  }
}

/**
 * Upcards to overlay. Only ranks hero could legally hold on this board are
 * offered — anything above the bring-in would change who brings in, and a rank
 * with all four copies already visible cannot be held at all.
 */
function buildCmpPicker(heroUp, cmp) {
  const root = $("dist-cmp");
  root.innerHTML = "";
  const legal = allowedRanks(state.hero);
  for (const r of legal) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cmp-btn";
    b.textContent = rankChar(r);
    if (r === heroUp) {
      b.style.borderColor = "#59D167";
      b.style.color = "#59D167";
      b.disabled = true;
      b.title = "your upcard";
    } else if (state.cmpUps.has(r)) {
      const c = cmp.find((q) => q.up === r);
      if (c) { b.style.borderColor = c.color; b.style.color = c.color; }
    }
    b.addEventListener("click", () => {
      state.cmpUps.has(r) ? state.cmpUps.delete(r) : state.cmpUps.add(r);
      showDist();
    });
    root.appendChild(b);
  }
}

// ---- controls ----------------------------------------------------
function wire() {
  for (const [name, key] of [["view", "view"], ["colorby", "colorBy"], ["cellval", "cellVal"]])
    for (const r of document.querySelectorAll(`input[name="${name}"]`))
      r.addEventListener("change", () => {
        state[key] = document.querySelector(`input[name="${name}"]:checked`).value;
        render();
      });
  $("fit").addEventListener("change", (e) => { state.fit = e.target.checked; render(); });
  $("biextra").addEventListener("input", (e) => {
    state.biExtra = Number(e.target.value) / 100;
    recompute();
  });
  const band = (id, key, other, cmp) =>
    $(id).addEventListener("input", (e) => {
      state[key] = cmp(Number(e.target.value), state[other]);
      $(id).value = String(state[key]);
      render();
    });
  band("pmin", "pmin", "pmax", Math.min);
  band("pmax", "pmax", "pmin", Math.max);
  band("emin", "emin", "emax", Math.min);
  band("emax", "emax", "emin", Math.max);
  $("dist-btn").addEventListener("click", showDist);
  $("dist-close").addEventListener("click", () => ($("dist").hidden = true));
  $("dist").addEventListener("click", (e) => {
    if (e.target === $("dist")) $("dist").hidden = true;
  });
}

// ---- tooltip -----------------------------------------------------
function showTip(el, i, c) {
  const d = downcardsFor(i, c);
  const r = state.eq.get(idxOf(d));
  if (!r || !state.req) return hideTip();
  const tip = $("tooltip");
  tip.innerHTML = "";
  const head = document.createElement("div");
  head.className = "t-hand";
  head.textContent = `${d.map(rankChar).join("-")}/${rankChar(state.ups[state.hero])}`;
  tip.appendChild(head);
  for (const [k, v] of [
    ["Equity", (100 * r.e).toFixed(1) + "%"],
    ["vs raise", (100 * r.eRaise).toFixed(1) + "%"],
    ["Percentile", "top " + r.pct.toFixed(1) + "%"],
    ["Rank", `${r.rank} of ${state.eq.size}`],
    ["EV vs fold", signed(r.ev, 1) + "c"],
    ...(r.parts.length > 1
      ? [["", r.parts.map((v, k) => `${state.reals[k].label} ${signed(v)}`).join(" · ")]]
      : []),
    ["Verdict", r.opens ? "complete" : "fold"],
    ["Combos", String(r.w)],
  ]) {
    const line = document.createElement("div");
    line.textContent = k.padEnd(11, " ") + v;
    tip.appendChild(line);
  }
  tip.hidden = false;
  const b = el.getBoundingClientRect();
  let px = b.right + 8, py = b.top;
  if (px + tip.offsetWidth > window.innerWidth - 8) px = b.left - tip.offsetWidth - 8;
  if (py + tip.offsetHeight > window.innerHeight - 8) py = window.innerHeight - tip.offsetHeight - 8;
  tip.style.left = Math.max(8, px) + "px";
  tip.style.top = Math.max(8, py) + "px";
}
const hideTip = () => ($("tooltip").hidden = true);
