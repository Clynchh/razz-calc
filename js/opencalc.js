// The complete/fold calculation behind open.html, with no DOM in it.
//
// Lives apart from the page so the page and tools/export-opens.mjs run the very
// same arithmetic — a spreadsheet built from a copy of this code would drift.
//
// ctx = { hu, avg, reals, rates, ups, hero }: the loaded tables, the continue
// and raise rates for this table size (razz's solved ones six-handed), the
// upcards in seat order (rightmost is the bring-in) and hero's seat index.

import { handId } from "./hands.js";
import { multisetRank } from "./combinadics.js";
import { BRANCH_CALL, BRANCH_RAISE } from "./real.js";
import { RAZZ_RATES, evComplete, ANTE } from "./openrule.js";

export const DOWN = [];
for (let a = 0; a < 13; a++) for (let b = a; b < 13; b++) DOWN.push([a, b]);
export const idxOf = (d) => d[0] * 13 - (d[0] * (d[0] - 1)) / 2 + (d[1] - d[0]);

export const combos = (d, av) =>
  d[0] === d[1] ? (av[d[0]] * (av[d[0]] - 1)) / 2 : av[d[0]] * av[d[1]];

// A seat that "never" continues still has a range once it does call — and a
// zero rate would leave it empty, with nothing to measure equity against. The
// engine floors its priors the same way; razz's smallest solved rate is 2%, so
// six-handed razz is unchanged.
const MIN_RANGE = 0.02;

export function continuing(avg, up, avail, frac) {
  const cand = [];
  for (const d of DOWN) {
    const w = combos(d, avail);
    if (w <= 0) continue;
    cand.push({ d, w, s: avg[multisetRank([...d, up].sort((x, y) => x - y))] });
  }
  cand.sort((a, b) => b.s - a.s);
  const total = cand.reduce((s, c) => s + c.w, 0);
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
 * Every hand's equity and EV for a given hero upcard on this board.
 *
 * Split out of recompute so the distribution chart can call it for upcards hero
 * is *not* holding, to compare. The requirement is unaffected — hero's own card
 * is not among the seats behind — but card removal is, so `avail` is rebuilt
 * with hero's seat swapped.
 */
export function handEquities(ctx, heroUp, req) {
  const { CONTINUE, RAISE } = ctx.rates ?? RAZZ_RATES;
  const avail = new Array(13).fill(4);
  ctx.ups.forEach((u, k) => avail[k === ctx.hero ? heroUp : u]--);

  const callR = req.callers.filter((c) => c.p > 1e-4)
    .map((c) => ({ ...c, hands: continuing(ctx.avg, c.up, avail, CONTINUE[c.up]) }));
  const cSum = callR.reduce((s2, c) => s2 + c.p, 0) || 1;
  const raiseR = req.raisers.map((r) => ({ ...r, hands: continuing(ctx.avg, r.up, avail, RAISE[r.up]) }));

  const out = new Map();
  for (let i = 0; i < DOWN.length; i++) {
    const dh = DOWN[i];
    const wh = combos(dh, avail);
    if (wh <= 0) continue;
    const after = avail.slice();
    if (--after[dh[0]] < 0 || --after[dh[1]] < 0) continue;
    const h = handId(dh[0], dh[1], heroUp);

    const avgOver = (ranges, norm, fn) => {
      let acc = 0;
      for (const c of ranges) {
        let num = 0, den = 0;
        for (const v of c.hands) {
          const wo = combos(v.d, after);
          if (wo <= 0) continue;
          const val = fn(h, c.up, v.d);
          if (val === null) continue;
          num += wo * val;
          den += wo;
        }
        if (den > 0) acc += (c.p / norm) * (num / den);
      }
      return acc;
    };
    const eqFn = (hh, up, vd) => ctx.hu.eq(hh, handId(vd[0], vd[1], up));
    const eCall = avgOver(callR, cSum, eqFn);
    const eRaise = raiseR.length ? avgOver(raiseR, 1, eqFn) : eCall;

    const evs = [];
    for (const { table } of ctx.reals) {
      const hs = table.state(heroUp, i);
      const netFn = (H, D, br) => (hh, up, vd) =>
        table.net(hs, table.state(up, idxOf(vd)), H, D, br);
      const netCall = avgOver(callR, cSum, netFn(100, req.potCall - 200, BRANCH_CALL));
      const netRaise = raiseR.length
        ? Math.max(-100, avgOver(raiseR, 1, netFn(200, req.potRaise - 400, BRANCH_RAISE)))
        : netCall;
      evs.push(req.pAllFold * req.winFold + req.pCallOnly * netCall + req.pRaised * netRaise);
    }
    if (!evs.length) evs.push(evComplete(req, eCall, eRaise));
    // Folding still costs the ante, so the number that decides is EV *against
    // folding*: above 0 completes, at or below folds. One verdict, no third state.
    const ev = evs.reduce((a2, b2) => a2 + b2, 0) / evs.length + ANTE;
    const parts = evs.map((v) => v + ANTE);
    const base = ctx.avg[multisetRank([...dh, heroUp].sort((x, y) => x - y))];
    out.set(i, { e: eCall, eRaise, ev, parts, opens: ev > 0, w: wh, base });
  }
  return out;
}
