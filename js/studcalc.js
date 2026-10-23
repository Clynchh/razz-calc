// The complete/fold calculation behind stud.html and stud8.html, with no DOM
// in it. Line for line the same arithmetic as opencalc.js (razz); only the
// hand space differs — 169 grid cells per upcard, with suits, instead of 91
// downcard pairs — and the board's upcards carry suits.
//
// ctx = { hu, avg, reals, rates, suitadj, ups, suits, hero }: the loaded
// tables, the derived continue/raise rates, the dead-suit adjustments, the
// upcards and their suits in seat order (rightmost is the bring-in) and hero's
// seat index.
//
// Suits do two things:
//   * combos are exact against the visible board. A suited cell needs both of
//     its cards in the upcard's suit, so it has one combo or none, never the
//     1-in-16 average a rank-only board has to assume
//   * a suited hand's EV moves with how many cards of its suit are showing on
//     the other upcards, from engine/stud's suit pass (suitadj.json)

import { N_CELL, stateOf, cellRanks, cellKind } from "./studhands.js";
import { BRANCH_CALL, BRANCH_RAISE } from "./real.js";
import { evComplete, ANTE } from "./openrule.js";

/**
 * Combos of a cell behind a known upcard. `avail` counts unseen cards by rank;
 * `board` is the per-rank availability before hero's downcards came out, so
 * the ratio scales a villain's suited combo for cards hero may hold.
 */
function combos(g, up, suit, avail, board, live) {
  const [a, b] = cellRanks(g);
  const kind = cellKind(g);
  if (kind === "pair") return (avail[a] * (avail[a] - 1)) / 2;
  const tot = avail[a] * avail[b];
  if (a === up || b === up) return kind === "suited" ? 0 : tot;
  const suited = live(a, suit) && live(b, suit)
    ? (avail[a] * avail[b]) / (board[a] * board[b])
    : 0;
  return kind === "suited" ? suited : tot - suited;
}

// A seat that "never" continues still has a range once it does call — and a
// zero rate would leave it empty, with nothing to measure equity against. The
// engine floors its priors the same way.
const MIN_RANGE = 0.02;

/** The top `frac` of hands behind upcard `up`, by average strength. */
export function continuing(avg, up, suit, avail, live, frac) {
  const cand = [];
  for (let g = 0; g < N_CELL; g++) {
    const s = stateOf(up, g);
    if (s < 0) continue;
    const w = combos(g, up, suit, avail, avail, live);
    if (w <= 0) continue;
    cand.push({ g, s, w, v: avg[s] });
  }
  cand.sort((a, b) => b.v - a.v);
  const total = cand.reduce((t, c) => t + c.w, 0);
  const keep = [];
  let acc = 0;
  for (const c of cand) {
    if (acc >= Math.max(MIN_RANGE, frac) * total) break;
    keep.push(c);
    acc += c.w;
  }
  return keep;
}

/**
 * Every hand's equity and EV for a given hero upcard on this board, keyed by
 * grid cell. Card removal is by rank, plus the exact suited check above.
 */
export function handEquities(ctx, heroUp, req) {
  const { CONTINUE, RAISE } = ctx.rates;
  const ups = ctx.ups.map((u, k) => (k === ctx.hero ? heroUp : u));
  const suits = ctx.suits;
  const avail = new Array(13).fill(4);
  ups.forEach((u) => avail[u]--);
  // a card is live unless some upcard on the board is that very card
  const live = (r, s) => !ups.some((u, k) => u === r && suits[k] === s);

  const seatSuit = (seat) => suits[seat];
  const callR = req.callers.filter((c) => c.p > 1e-4)
    .map((c) => ({ ...c, suit: seatSuit(c.seat), hands: continuing(ctx.avg, c.up, seatSuit(c.seat), avail, live, CONTINUE[c.up]) }));
  const cSum = callR.reduce((s2, c) => s2 + c.p, 0) || 1;
  const raiseR = req.raisers.map((r) => ({ ...r, suit: seatSuit(r.seat), hands: continuing(ctx.avg, r.up, seatSuit(r.seat), avail, live, RAISE[r.up]) }));

  // cards of hero's suit on everyone else's upcard, for the suit adjustment
  const heroSuit = suits[ctx.hero];
  const k = ups.filter((u, s) => s !== ctx.hero && suits[s] === heroSuit).length;
  const reached = req.pCallOnly + req.pRaised;      // the pots a called hand plays

  const out = new Map();
  for (let g = 0; g < N_CELL; g++) {
    const hs = stateOf(heroUp, g);
    if (hs < 0) continue;
    const wh = combos(g, heroUp, heroSuit, avail, avail, live);
    if (wh <= 0) continue;
    const after = avail.slice();
    const [a, b] = cellRanks(g);
    if (--after[a] < 0 || --after[b] < 0) continue;

    const avgOver = (ranges, norm, fn) => {
      let acc = 0;
      for (const c of ranges) {
        let num = 0, den = 0;
        for (const v of c.hands) {
          const wo = combos(v.g, c.up, c.suit, after, avail, live);
          if (wo <= 0) continue;
          const val = fn(v.s);
          if (val === null) continue;
          num += wo * val;
          den += wo;
        }
        if (den > 0) acc += (c.p / norm) * (num / den);
      }
      return acc;
    };
    const eqFn = (vs) => ctx.hu.eq(hs, vs);
    const eCall = avgOver(callR, cSum, eqFn);
    const eRaise = raiseR.length ? avgOver(raiseR, 1, eqFn) : eCall;

    const evs = [];
    for (const { table } of ctx.reals) {
      const netFn = (H, D, br) => (vs) => table.net(hs, vs, H, D, br);
      const netCall = avgOver(callR, cSum, netFn(100, req.potCall - 200, BRANCH_CALL));
      const netRaise = raiseR.length
        ? Math.max(-100, avgOver(raiseR, 1, netFn(200, req.potRaise - 400, BRANCH_RAISE)))
        : netCall;
      evs.push(req.pAllFold * req.winFold + req.pCallOnly * netCall + req.pRaised * netRaise);
    }
    if (!evs.length) evs.push(evComplete(req, eCall, eRaise));

    // the realised tables average over every suit layout; move a suited hand
    // by what this board's dead cards of its suit are worth, in the pots it
    // actually plays
    const d = cellKind(g) === "suited" ? ctx.suitadj?.delta?.[hs]?.[Math.min(k, 3)] : null;
    const suitAdj = d == null ? 0 : reached * d;

    // Folding still costs the ante, so the number that decides is EV *against
    // folding*: above 0 completes, at or below folds. One verdict, no third state.
    const ev = evs.reduce((a2, b2) => a2 + b2, 0) / evs.length + ANTE + suitAdj;
    const parts = evs.map((v) => v + ANTE + suitAdj);
    out.set(g, {
      e: eCall, eRaise, ev, parts, opens: ev > 0, w: wh, base: ctx.avg[hs],
      suitAdj, suitShown: k, suitBlindOpens: ev - suitAdj > 0,
    });
  }
  return out;
}
