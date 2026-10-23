// Stud 3rd Street — opening threshold, by position. Drives both stud.html
// (stud hi) and stud8.html (stud hi-lo, 8 or better); the page says which via
// <body data-game>.
//
// The same page as razz (open-app.js) over a different hand space: a 13x13
// hold'em-style grid per upcard, suited above the diagonal. Set the six upcards
// in seat order and pick your seat. The bar you must clear comes from pot odds
// and the chance everyone behind folds; the open/fold call itself is made on
// *realised* value with 4th-7th played out.

import { rankChar, cellLabel, handLabel, N_CELL, stateOf, cellCombos, cellKind, cellRanks } from "./studhands.js";
import { loadHu } from "./hu.js";
import { loadReal } from "./real.js";
import { heatColor, changeColor, rgbCss, textOn } from "./color.js";
import { handEquities as calcHandEquities } from "./studcalc.js";
import { seating, requirement } from "./openrule.js";

const GAME = document.body.dataset.game === "stud8"
  ? { dir: "./data/stud8", build: "hl" }
  : { dir: "./data/stud", build: "hi" };

// Six-handed tables sit in the game's folder; three-handed and heads-up in n3
// and n2 under it. The all-in matrix does not depend on table size, so there
// is one, beside the six-handed tables.
const dirFor = (n) => (n === 6 ? GAME.dir : `${GAME.dir}/n${n}`);
const DEFAULT_UPS = { 6: [0, 1, 4, 6, 8, 12], 3: [0, 4, 12], 2: [0, 12] };   // rightmost brings in
const DEFAULT_SUITS = { 6: [0, 1, 2, 3, 0, 1], 3: [0, 1, 2], 2: [0, 1] };
const SUIT_CH = ["\u2660", "\u2665", "\u2666", "\u2663"];                       // spades hearts diamonds clubs
const SEAT_WORDS = { 6: ["six", "five random hands"], 3: ["three", "two random hands"], 2: ["two", "one random hand"] };

const $ = (id) => document.getElementById(id);

const state = {
  hu: null, avg: null,
  rates: null,                // { CONTINUE, RAISE } by upcard, from rates.json
  reals: [],                  // one realised table per lookahead setting
  n: 6,                       // players at the table
  ups: DEFAULT_UPS[6].slice(), // A K T 8 6 2 — rightmost is always the bring-in
  suits: DEFAULT_SUITS[6].slice(), // each upcard's suit, 0-3 as SUIT_CH
  suitadj: null,              // dead-suit adjustments for this table size
  hero: 0,
  biExtra: 0.45,
  view: "absolute",
  colorBy: "equity",
  cellVal: "equity",
  fit: true,
  pmin: 0, pmax: 100,
  emin: 0, emax: 100,
  eq: new Map(),              // grid cell -> {e, eRaise, ev, w, pct, base, rank}
  cmpUps: new Set(),          // upcards overlaid on the distribution chart
  distY: "ev",                // distribution y-axis: "ev" or "equity"
  req: null,
  mode: "board",              // "board", or "raw": no board, N-handed averages
  rawUp: 0,                   // hero's upcard in raw mode
  classes: new Set(),         // ticked hand-class highlights (stud8 only)
};

const cellEl = Array.from({ length: 13 }, () => new Array(13).fill(null));
const FOLD_RGB = [46, 94, 140];   // --fold in styles.css
const heroUpcard = () => (state.mode === "raw" ? state.rawUp : state.ups[state.hero]);

// ---- hand classes (stud8.html only) -------------------------------
//
// Hi and lo describe the two downcards — lo is A-8, hi is 9-K, the ace counting
// lo — so a cell's box does not move with the upcard. The pair classes are the
// exception, since a pair is made with the upcard: wired is a split pair (one
// downcard matches the upcard), buried is a pair in the hole, rolled up is both.
// A cell can sit in two boxes: A9o under an ace is 1hi 1lo *and* wired.

const isLo = (r) => r === 0 || r >= 6;            // A, or 8 down to 2
const mixed = (a, b) => isLo(a) !== isLo(b);
const both = (pred) => (a, b) => pred(a) && pred(b);
const isHi = (r) => !isLo(r);
const CLASSES = [
  { key: "offhi", label: "Offsuit hi", color: "#E2705A", kind: "offsuit", ranks: both(isHi) },
  { key: "suihi", label: "Suited hi", color: "#C77DBB", kind: "suited", ranks: both(isHi) },
  { key: "offlo", label: "Offsuit lo", color: "#4AC6E0", kind: "offsuit", ranks: both(isLo) },
  { key: "suilo", label: "Suited lo", color: "#7FE07F", kind: "suited", ranks: both(isLo) },
  { key: "sui1", label: "Suited 1hi 1lo", color: "#F2C14E", kind: "suited", ranks: mixed },
  { key: "off1", label: "Offsuit 1hi 1lo", color: "#B9C4D6", kind: "offsuit", ranks: mixed },
  { key: "wired", label: "Wired pair", color: "#FFFFFF", test: (k, a, b, up) => k !== "pair" && (a === up || b === up) },
  { key: "buried", label: "Buried pair", color: "#FF9F1C", test: (k, a, b, up) => k === "pair" && a !== up },
  { key: "rolled", label: "Rolled up", color: "#FF4FA3", test: (k, a, b, up) => k === "pair" && a === up },
];
const inClass = (c, g, up) => {
  const k = cellKind(g), [a, b] = cellRanks(g);
  return c.test ? c.test(k, a, b, up) : k === c.kind && c.ranks(a, b);
};

function buildClasses() {
  const root = $("classes");
  if (!root) return;
  root.innerHTML = "";
  for (const c of CLASSES) {
    const row = document.createElement("label");
    row.className = "class-row";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.addEventListener("change", () => {
      box.checked ? state.classes.add(c.key) : state.classes.delete(c.key);
      render();
    });
    const sw = document.createElement("span");
    sw.className = "class-swatch";
    sw.style.borderColor = c.color;
    const name = document.createElement("span");
    name.textContent = c.label;
    const stat = document.createElement("span");
    stat.className = "class-stat";
    stat.id = `class-${c.key}`;
    row.append(box, sw, name, stat);
    root.appendChild(row);
  }
}

/** Each class's share of the range on this board, and how much of it opens. */
function classStats() {
  if (!$("classes")) return;
  const up = heroUpcard(), raw = state.mode === "raw";
  let total = 0;
  for (const r of state.eq.values()) total += r.w;
  for (const c of CLASSES) {
    let w = 0, open = 0;
    for (const [g, r] of state.eq) if (inClass(c, g, up)) { w += r.w; if (r.opens) open += r.w; }
    $(`class-${c.key}`).textContent = !w ? "none" :
      `${(100 * w / (total || 1)).toFixed(1)}%` + (raw || !state.req ? "" : ` · ${Math.round(100 * open / w)}% open`);
  }
}

boot();

async function boot() {
  try {
    $("loading-label").textContent = "Loading equity matrix";
    state.hu = await loadHu(`${GAME.dir}/hu.bin`, (f) => setBar(f));
    await loadSize(6);
  } catch (err) {
    const box = $("loading-error");
    box.hidden = false;
    box.textContent = `Could not load ${GAME.dir}/. Run  node engine/stud/build.mjs ${GAME.build} all` +
      "\n\n(" + err.message + ")";
    $("bar-fill").style.background = "var(--muted)";
    return;
  }
  buildSeats();
  buildRawPicker();
  buildClasses();
  buildGrid();
  wire();
  recompute();
  $("loading").hidden = true;
  $("app").hidden = false;
}

/** One table size's averages, rates, suit pass and realised tables, fetched once. */
const sizeCache = new Map();
async function loadSize(n) {
  if (!sizeCache.has(n)) {
    const dir = dirFor(n);
    $("loading-label").textContent = `Loading ${n}-handed tables`;
    const json = (f) => fetch(`${dir}/${f}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const [avg, rates, suitadj] = await Promise.all([json("average.json"), json("rates.json"), json("suitadj.json")]);
    if (!avg?.meanEquity) throw new Error("average.json is needed to order calling ranges");
    if (!rates) throw new Error("rates.json is needed for the continue and raise rates");
    // Later-street play has a free parameter — how many bets a caller prices
    // into its decision. As in razz, lookahead 2 and lookahead 4 are each right
    // on one street and wrong on another, so they are weighted equally.
    const reals = [];
    for (const [file, label] of [["real-la2.bin", "2-street"], ["real-la4.bin", "4-street"]]) {
      try {
        $("loading-label").textContent = `Loading ${n}-handed ${label}`;
        reals.push({ table: await loadReal(`${dir}/${file}`, (f) => f != null && setBar(f)), label, file });
      } catch { /* optional */ }
    }
    sizeCache.set(n, {
      avg: avg.meanEquity, rates: { CONTINUE: rates.continue, RAISE: rates.raise }, suitadj, reals,
    });
  }
  Object.assign(state, sizeCache.get(n), { n });
}

/** Switch table size: tables load on first use, and the board resets to fit. */
async function setSize(n) {
  if (n === state.n) return;
  if (!sizeCache.has(n)) {
    setBar(0);
    $("loading").hidden = false;
  }
  try {
    await loadSize(n);
  } catch (err) {
    alert(`Could not load the ${n}-handed tables from ${dirFor(n)}/.\n` +
      `Run  node engine/stud/build.mjs ${GAME.build} all --seats ${n}\n\n(${err.message})`);
    return;
  } finally {
    $("loading").hidden = true;
  }
  state.ups = DEFAULT_UPS[n].slice();
  state.suits = DEFAULT_SUITS[n].slice();
  state.hero = 0;
  state.cmpUps.clear();
  buildSeats();
  recompute();
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
    const pick = document.createElement("div");
    pick.className = "pick";
    const sel = document.createElement("select");
    sel.setAttribute("aria-label", "upcard rank");
    sel.addEventListener("change", () => {
      setUpcard(i, Number(sel.value));
      recompute();
    });
    const suit = document.createElement("select");
    suit.className = "suit";
    suit.setAttribute("aria-label", "upcard suit");
    suit.addEventListener("change", () => {
      state.suits[i] = Number(suit.value);
      recompute();
    });
    pick.append(sel, suit);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "you";
    btn.addEventListener("click", () => {
      state.hero = i;
      recompute();
    });
    box.append(who, pick, btn);
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
 *   2. The rightmost seat brings in, so it holds the lowest card: no other seat
 *      can show a lower one. Equal is fine and leaves the bring-in where it is.
 *      Ranks are indexed strongest first, so "lowest card" is the highest index
 *      and the arithmetic below is razz's unchanged.
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
  if (!allowedRanks(i).includes(rank)) return;
  state.ups[i] = rank;
  // a rank change can collide with a card already showing; take a free suit
  if (suitTaken(i, state.suits[i])) state.suits[i] = [0, 1, 2, 3].find((s) => !suitTaken(i, s));
}

/** Is this suit, at seat i's rank, already some other seat's upcard? */
const suitTaken = (i, s) => state.ups.some((u, k) => k !== i && u === state.ups[i] && state.suits[k] === s);

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
    const ss = kids[i].querySelector("select.suit");
    ss.innerHTML = "";
    for (let s = 0; s < 4; s++) {
      const o = document.createElement("option");
      o.value = String(s);
      o.textContent = SUIT_CH[s];
      o.disabled = suitTaken(i, s);
      ss.appendChild(o);
    }
    ss.value = String(state.suits[i]);
    kids[i].querySelector(".who").innerHTML =
      i === bi ? "<b>bring-in</b>" : `BI+${order.indexOf(i) + 1}`;
    kids[i].classList.toggle("hero", i === state.hero);
    kids[i].classList.toggle("bi", i === bi);
    kids[i].querySelector("button").disabled = i === bi;
  }
}

// ---- raw averages (no board) -------------------------------------
function buildRawPicker() {
  const root = $("raw-ups");
  root.innerHTML = "";
  for (let r = 0; r < 13; r++) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = rankChar(r);
    b.addEventListener("click", () => {
      state.rawUp = r;
      recompute();
    });
    root.appendChild(b);
  }
}

/** Show the controls for the current mode and hide the rest. */
function syncMode() {
  const raw = state.mode === "raw";
  for (const b of document.querySelectorAll(".mode-btn"))
    b.setAttribute("aria-pressed", String(b.dataset.mode === state.mode));
  $("seats").hidden = raw;
  $("raw-picker").hidden = !raw;
  for (const el of document.querySelectorAll(".board-only")) el.hidden = raw;
  for (const el of document.querySelectorAll(".raw-only")) el.hidden = !raw;
  [...$("raw-ups").children].forEach((b, r) => b.setAttribute("aria-pressed", String(r === state.rawUp)));
  for (const b of document.querySelectorAll(".size-btn"))
    b.setAttribute("aria-pressed", String(Number(b.dataset.seats) === state.n));
  for (const el of document.querySelectorAll(".n-seats")) el.textContent = SEAT_WORDS[state.n][0];
  for (const el of document.querySelectorAll(".n-opp")) el.textContent = SEAT_WORDS[state.n][1];
}

/**
 * Every hand's six-handed all-in average behind upcard `up`, with no board:
 * only hero's own upcard is out of the deck. `opens` is false throughout —
 * without a board there is no bar to clear.
 */
function rawEquities(up) {
  const avail = new Array(13).fill(4);
  avail[up]--;
  const out = new Map();
  for (let g = 0; g < N_CELL; g++) {
    const s = stateOf(up, g);
    if (s < 0) continue;
    const w = cellCombos(g, avail, up);
    if (w <= 0) continue;
    const e = state.avg[s];
    out.set(g, { e, eRaise: e, ev: 0, parts: [], opens: false, w, base: e });
  }
  return out;
}

// ---- derived state ----------------------------------------------
const handEquities = (heroUp, req) => calcHandEquities(state, heroUp, req);

function recompute() {
  syncMode();
  if (state.mode === "raw") {
    state.req = null;
    state.eq = rawEquities(state.rawUp);
  } else {
    const req = requirement(state.ups, state.hero, state.biExtra, state.rates);
    state.req = req;
    state.eq = new Map();
    if (!req) return render();
    state.eq = handEquities(state.ups[state.hero], req);
  }

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
// The full square: cell = row * 13 + column. Pairs on the diagonal, AA top-left
// to 22 bottom-right; suited above it, offsuit below.
function buildGrid() {
  const root = $("matrix");
  root.style.setProperty("--cell", "52px");
  for (let i = 0; i < 13; i++)
    for (let c = 0; c < 13; c++) {
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
const cellOf = (i, c) => i * 13 + c;

function inBands(r) {
  if (r.pct < state.pmin || r.pct > state.pmax) return false;
  const e = 100 * r.e;
  return e >= state.emin && e <= state.emax;
}

function render() {
  syncSeats();
  const req = state.req;
  $("bi-label").textContent = `+${Math.round(100 * state.biExtra)} points`;
  $("rates").textContent = state.ups.map((u) => `${rankChar(u)} ${Math.round(100 * state.rates.CONTINUE[u])}%`).join("   ");
  $("basis").innerHTML = state.reals.length
    ? "Decisions use <strong>realised</strong> values — 4th&ndash;7th are played out — under " +
      state.reals.length + " calling assumption" + (state.reals.length === 1 ? "" : "s") +
      " (" + state.reals.map((r) => r.label).join(", ") + ")" +
      (state.reals.length > 1 ? ", weighted equally" : "") + ". " +
      "EV is measured <strong>against folding</strong>: above 0 completes, 0 or below folds."
    : "<strong>All-in only</strong> — no realised table found. Run " +
      `<code>node engine/stud/build.mjs ${GAME.build} real --look 2</code> (and 4).`;

  const raw = state.mode === "raw";
  if (!req && !raw) {
    $("req").textContent = "—";
    $("reqsub").textContent = "That seat is the bring-in: posting is forced.";
    $("opens").textContent = "";
    $("why").textContent = "Pick any seat other than the rightmost.";
    for (let i = 0; i < 13; i++) for (let c = 0; c < 13; c++) blank(cellEl[i][c], cellOf(i, c));
    $("top-list").innerHTML = "";
    return;
  }

  let best = 0;
  for (const v of state.eq.values()) best = Math.max(best, v.e);
  const anchor = state.fit ? Math.max(best, 1e-9) : 1;
  const change = state.view === "change" && !raw;
  let openW = 0, allW = 0, pIn = 0, eIn = 0;

  for (let i = 0; i < 13; i++)
    for (let c = 0; c < 13; c++) {
      const el = cellEl[i][c];
      const g = cellOf(i, c);
      const r = state.eq.get(g);
      el.querySelector(".lbl").textContent = cellLabel(g);
      if (!r) { blank(el, g); continue; }
      el.classList.remove("infeasible");

      // a fold is filled blue rather than dimmed, so it still reads at a glance
      const rgb = !raw && !r.opens
        ? FOLD_RGB
        : change
          ? changeColor(r.basePct - r.pct)
          : heatColor(state.colorBy === "equity" ? 100 * (1 - r.e / anchor) : r.pct);
      el.style.background = rgbCss(rgb);
      el.style.color = textOn(rgb);
      el.querySelector(".val").textContent = cellText(r, change);

      el.classList.toggle("outside", !inBands(r));
      // ticked hand classes: ring each member in its class colour (stacked when
      // a cell is in more than one) and fade everything else
      const hits = state.classes.size ? CLASSES.filter((k) => state.classes.has(k.key) && inClass(k, g, heroUpcard())) : [];
      el.style.boxShadow = hits.map((k, n) => `inset 0 0 0 ${3 * (n + 1)}px ${k.color}`).join(", ");
      el.classList.toggle("unhighlit", state.classes.size > 0 && !hits.length);
      allW += r.w;
      if (r.opens) openW += r.w;
      if (r.pct >= state.pmin && r.pct <= state.pmax) pIn += r.w;
      if (100 * r.e >= state.emin && 100 * r.e <= state.emax) eIn += r.w;
    }

  if (req) {
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
  }
  $("legend-fold").hidden = raw;
  if (req) suitNote();
  $("p-label").textContent = `top ${state.pmin}% – ${state.pmax}%`;
  $("e-label").textContent = `${state.emin}% – ${state.emax}% equity`;
  $("p-count").textContent = `${(100 * (allW ? pIn / allW : 0)).toFixed(0)}% of combos in band`;
  $("e-count").textContent = `${(100 * (allW ? eIn / allW : 0)).toFixed(0)}% of combos in band`;
  fillBar("p-fill", state.pmin, state.pmax, 100);
  fillBar("e-fill", state.emin, state.emax, 100);

  buildLegend(change, anchor, best);
  buildTop();
  classStats();
}

/** How this board's suits moved the suited hands, for the Suits panel. */
function suitNote() {
  const hs = state.suits[state.hero];
  const k = state.ups.filter((u, s) => s !== state.hero && state.suits[s] === hs).length;
  if (!state.suitadj) {
    $("suit-note").textContent = `No suit pass for ${state.n}-handed yet: suited hands use the suit-blind average.`;
    return;
  }
  let w = 0, sum = 0, flips = 0, gained = 0;
  for (const [g, r] of state.eq) {
    if (cellKind(g) !== "suited") continue;
    w += r.w;
    sum += r.w * r.suitAdj;
    if (r.opens !== r.suitBlindOpens) { flips++; if (r.opens) gained++; }
  }
  const mean = w ? sum / w : 0;
  $("suit-note").innerHTML =
    `Your suit is ${SUIT_CH[hs]}, with <strong>${k}</strong> more ${k === 1 ? "card" : "cards"} of it showing. ` +
    `Suited hands are <strong>${signed(mean, 1)}c</strong> on average against a suit-blind board` +
    (flips ? `, and ${flips} change verdict (${gained} now complete, ${flips - gained} now fold).` : "; none change verdict.");
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

/** Suited combos are a 1-in-16 share once ranks are removed, so not always whole. */
const fmtCombos = (w) => (Number.isInteger(w) ? String(w) : w.toFixed(1));

function blank(el, g) {
  el.classList.add("infeasible");
  el.classList.remove("outside", "unhighlit");
  el.style.boxShadow = "";
  el.style.background = "";
  el.style.color = "";
  el.querySelector(".lbl").textContent = cellLabel(g);
  el.querySelector(".val").textContent = "n/a";
}

/** Strongest 10 for *this* board — hands reorder as the visible cards change. */
function buildTop() {
  const root = $("top-list");
  root.innerHTML = "";
  const heroUp = heroUpcard();
  const order = [...state.eq.keys()].sort((a, b) => state.eq.get(b).e - state.eq.get(a).e);
  for (const i of order.slice(0, 10)) {
    const r = state.eq.get(i);
    const opens = r.opens;
    for (const [cls, text] of [
      ["n", String(r.rank)],
      ["h", handLabel(i, heroUp)],
      ["e", (100 * r.e).toFixed(1) + "%"],
      ["v", state.mode === "raw" ? `top ${r.pct.toFixed(0)}%` : signed(r.ev) + "c"],
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
      `<div class="t-hand">${handLabel(r.i, heroUp)}</div>`,
      `<div>EV vs fold ${signed(r.ev, 1)}c</div>`,
      `<div>equity     ${(100 * r.e).toFixed(1)}%</div>`,
      `<div>combos     ${fmtCombos(r.w)}</div>`,
      `<div>top        ${(100 * f).toFixed(1)}% of range</div>`,
      `<div style="color:${vcol}">${verdict}</div>`,
    ];
    for (const c of cmp) {
      const rr = at(c, f);
      lines.push(`<div style="color:${c.color}">${rankChar(c.up)}: ` +
        `${handLabel(rr.i, c.up)} ` +
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
    `${primary.rows.length} hands behind a ${rankChar(heroUp)}, ${fmtCombos(primary.total)} combos · BI+${req.pos}` +
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
  for (const b of document.querySelectorAll(".size-btn"))
    b.addEventListener("click", () => setSize(Number(b.dataset.seats)));
  for (const b of document.querySelectorAll(".mode-btn"))
    b.addEventListener("click", () => {
      state.mode = b.dataset.mode;
      // EV against folding needs a board; show equity without one
      if (state.mode === "raw" && state.cellVal === "ev") {
        state.cellVal = "equity";
        document.querySelector('input[name="cellval"][value="equity"]').checked = true;
      }
      recompute();
    });
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
  const g = cellOf(i, c);
  const r = state.eq.get(g);
  if (!r || (!state.req && state.mode !== "raw")) return hideTip();
  const tip = $("tooltip");
  tip.innerHTML = "";
  const head = document.createElement("div");
  head.className = "t-hand";
  head.textContent = handLabel(g, heroUpcard());
  tip.appendChild(head);
  const raw = state.mode === "raw";
  for (const [k, v] of [
    [raw ? "6-way avg" : "Equity", (100 * r.e).toFixed(1) + "%"],
    ...(raw ? [] : [["vs raise", (100 * r.eRaise).toFixed(1) + "%"]]),
    ["Percentile", "top " + r.pct.toFixed(1) + "%"],
    ["Rank", `${r.rank} of ${state.eq.size}`],
    ...(raw ? [] : [["EV vs fold", signed(r.ev, 1) + "c"]]),
    ...(raw || cellKind(g) !== "suited" ? [] :
      [["Suit adj", `${signed(r.suitAdj, 1)}c (${r.suitShown} ${SUIT_CH[state.suits[state.hero]]} showing)`]]),
    ...(!raw && r.parts.length > 1
      ? [["", r.parts.map((v, k) => `${state.reals[k].label} ${signed(v)}`).join(" · ")]]
      : []),
    ...(raw ? [] : [["Verdict", r.opens ? "complete" : "fold"]]),
    ["Combos", fmtCombos(r.w)],
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
