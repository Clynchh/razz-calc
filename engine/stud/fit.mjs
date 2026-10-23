// Continue and raise rates by upcard, derived rather than hand-set.
//
// Razz's six-handed rates were measured from a solve. Everything else — stud
// hi and hi-lo at any table size, razz three-handed and heads-up — has no
// solve, so each seat facing a completion is given the plain value rule:
//
//   * the completing range is the top Q of all starting hands by average
//     strength (all upcards together, so strong upcards complete more). Q
//     widens as the table shrinks: fewer players behind, wider steals
//   * a hand continues if calling is worth more than folding, and raises if the
//     raised pot is worth more to it than the called one
//
// "Worth" is first a provisional guess — all-in equity for stud, the solved
// six-handed rates for razz — then realised value with 4th-7th played out,
// from a quick bootstrap pass. That second pass is the one shipped: it is what
// lets the upcard matter.
//
// Run on razz's own six-handed tables, this rule gets the shape of the solved
// rates (small cards continue about a third of the time, faces almost never)
// but not their extremes. Treat these as the assumption to argue with.

import { CONTINUE as RAZZ_CONTINUE, RAISE as RAZZ_RAISE } from "../../js/openrule.js";

export const Q_COMPLETE = { 6: 0.4, 3: 0.6, 2: 0.8 };
const H_CALL = 100, H_RAISE = 200;

/** The completing range: top Q of all states by average strength. */
function completers(game, avg, q) {
  const ids = [...Array(game.n).keys()].sort((a, b) => avg[b] - avg[a]);
  const total = game.weight.reduce((s, w) => s + w, 0);
  const keep = [];
  let acc = 0;
  for (const id of ids) {
    if (acc >= q * total) break;
    keep.push(id);
    acc += game.weight[id];
  }
  return keep;
}

/** Per-upcard share of combos for which `pred(state)` holds. */
function perUpcard(game, pred) {
  const tot = new Array(13).fill(0), hit = new Array(13).fill(0);
  for (let id = 0; id < game.n; id++) {
    const up = game.up(id);
    tot[up] += game.weight[id];
    if (pred(id)) hit[up] += game.weight[id];
  }
  return tot.map((t, u) => Number((hit[u] / t).toFixed(3)));
}

/** Weighted mean of f(c, x) over the completing range, skipping nulls. */
function vsRange(game, range, x, f) {
  let num = 0, den = 0;
  for (const c of range) {
    const v = f(c, x);
    if (v === null) continue;
    num += game.weight[c] * v;
    den += game.weight[c];
  }
  return den ? num / den : null;
}

function result(game, avg, q, cont, raise, basis) {
  const range = new Set(completers(game, avg, q));
  return {
    basis,
    rule: `continue if calling beats folding, raise if the raised pot beats the called one; ` +
          `completing range is the top ${Math.round(100 * q)}% by average strength`,
    // a hand worth raising is a hand worth continuing with
    continue: perUpcard(game, (x) => cont(x) || raise(x)),
    raise: perUpcard(game, raise),
    open: perUpcard(game, (id) => range.has(id)),
  };
}

/**
 * Provisional rates from all-in equity (stud). A caller who sees the river
 * all-in nets e*pot - bet in each branch.
 */
export function allInRates(game, avg, huBuf, dead, q) {
  const n = huBuf.readUInt16LE(10);
  const hu = new Uint16Array(huBuf.buffer.slice(huBuf.byteOffset + 14, huBuf.byteOffset + 14 + 2 * n * n));
  const range = completers(game, avg, q);
  const eq = new Float64Array(game.n);
  for (let x = 0; x < game.n; x++)
    eq[x] = vsRange(game, range, x, (c, xx) => {
      const v = hu[xx * n + c];
      return v === 0xffff ? null : v / 65534;
    }) ?? 0;
  const call = (x) => eq[x] * (2 * H_CALL + dead) - H_CALL;
  const raise = (x) => eq[x] * (2 * H_RAISE + dead) - H_RAISE;
  return result(game, avg, q, (x) => call(x) > 0, (x) => raise(x) > Math.max(0, call(x)), "all-in");
}

/** Provisional rates for razz: the solved six-handed ones, as a starting point. */
export function razzSolvedRates(game, avg, q) {
  const range = new Set(completers(game, avg, q));
  return {
    basis: "razz six-handed solve",
    continue: RAZZ_CONTINUE.slice(),
    raise: RAZZ_RAISE.slice(),
    open: perUpcard(game, (id) => range.has(id)),
  };
}

/**
 * Final rates from a realised pass. The tables give the completer's net, so
 * the caller's is what is left: both nets together come to the dead money.
 */
export function realisedRates(game, avg, real, dead, q) {
  const range = completers(game, avg, q);
  const n = game.n;
  const net = (b, H) => (c, x) => {
    const k = c * n + x;
    if (!real.ok[k]) return null;
    const s = real.S[b][k] / 10000;
    const completer = H * s + real.M[b][k] + (dead * (s + 1)) / 2;
    return dead - completer;
  };
  const call = new Float64Array(n), raise = new Float64Array(n);
  for (let x = 0; x < n; x++) {
    call[x] = vsRange(game, range, x, net(0, H_CALL)) ?? -1;
    raise[x] = vsRange(game, range, x, net(1, H_RAISE)) ?? -1;
  }
  return result(game, avg, q, (x) => call[x] > 0, (x) => raise[x] > Math.max(0, call[x]), "realised");
}
