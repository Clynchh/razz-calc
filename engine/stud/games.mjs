// The three games the engine plays, behind one interface so the builders and
// the play-out never branch on which game they are running:
//
//   states, configs   starting hands, and every concrete card triple of each
//   weight[id]        full-deck combos of a state, for weighting ranges
//   up(id)            a state's upcard rank
//   share(a, b)       first player's share of the pot at showdown, 7 cards each
//   first(cards, n)   larger acts first on 4th-7th (the best board showing)
//   downsFor(id, su, rng, out)  two hidden downcards for state id, given the
//                     upcard's suit; false to reject and draw again
//
// Stud hi and hi-lo use the 2041 suit-aware states of js/studhands.js, ranks
// strongest first (0 = A ... 12 = 2). Razz uses its own 1183 states (upcard x
// downcard pair, ranks A = 0 ... K = 12) in the order the razz page reads its
// realised tables: up * 91 + downcard-pair index.

import { STATES as STUD_STATES, N_STATES as STUD_N } from "../../js/studhands.js";
import { card, evalHi, evalLow } from "./core.mjs";

// ---- stud hi and hi-lo ---------------------------------------------------

const studConfigs = STUD_STATES.map(({ up, i, j, kind }) => {
  const out = [];
  for (let su = 0; su < 4; su++) {
    const u = card(up, su);
    if (kind === "pair") {
      for (let a = 0; a < 4; a++)
        for (let b = a + 1; b < 4; b++) {
          const x = card(i, a), y = card(i, b);
          if (x !== u && y !== u) out.push([u, x, y]);
        }
    } else if (kind === "suited") {
      out.push([u, card(i, su), card(j, su)]);
    } else {
      // offsuit: ranks are (j, i) with j < i; anything but all three suited
      for (let a = 0; a < 4; a++)
        for (let b = 0; b < 4; b++) {
          if (a === su && b === su) continue;
          const x = card(j, a), y = card(i, b);
          if (x !== u && y !== u) out.push([u, x, y]);
        }
    }
  }
  return out;
});

const studWeight = STUD_STATES.map(({ up, i, j, kind }) => {
  if (kind === "pair") return i === up ? 3 : 6;
  if (kind === "suited") return 1;
  return i === up || j === up ? 12 : 15;
});

function studDowns(id, su, rng, out) {
  const { i, j, kind } = STUD_STATES[id];
  if (kind === "pair") {
    const a = rng.int(4); let b = rng.int(3); if (b >= a) b++;
    out[0] = card(i, a); out[1] = card(i, b);
  } else if (kind === "suited") {
    out[0] = card(i, su); out[1] = card(j, su);
  } else {
    const a = rng.int(4), b = rng.int(4);
    if (a === su && b === su) return false;
    out[0] = card(j, a); out[1] = card(i, b);
  }
  return true;
}

function studShare(hl) {
  return (a, b) => {
    const x = evalHi(a, 7), y = evalHi(b, 7);
    const hi = x > y ? 1 : x < y ? 0 : 0.5;
    if (!hl) return hi;
    const la = evalLow(a, 7), lb = evalLow(b, 7);
    if (la < 0 && lb < 0) return hi;
    const lo = lb < 0 ? 1 : la < 0 ? 0 : la < lb ? 1 : la > lb ? 0 : 0.5;
    return 0.5 * hi + 0.5 * lo;
  };
}

const stud = (hl) => ({
  name: hl ? "stud8" : "stud",
  hasSuits: true,
  states: STUD_STATES,
  n: STUD_N,
  configs: studConfigs,
  weight: studWeight,
  up: (id) => STUD_STATES[id].up,
  suited: (id) => STUD_STATES[id].kind === "suited",
  share: studShare(hl),
  first: evalHi,                 // highest board showing acts first, both games
  downsFor: studDowns,
});

// ---- razz ------------------------------------------------------------------

const RAZZ_DOWN = [];
for (let a = 0; a < 13; a++) for (let b = a; b < 13; b++) RAZZ_DOWN.push([a, b]);
const RAZZ_STATES = [];
for (let up = 0; up < 13; up++) RAZZ_DOWN.forEach(([a, b]) => RAZZ_STATES.push({ up, a, b }));

const razzConfigs = RAZZ_STATES.map(({ up, a, b }) => {
  const out = [];
  for (let su = 0; su < 4; su++) {
    const u = card(up, su);
    for (let sa = 0; sa < 4; sa++)
      for (let sb = a === b ? sa + 1 : 0; sb < 4; sb++) {
        const x = card(a, sa), y = card(b, sb);
        if (x !== u && y !== u) out.push([u, x, y]);
      }
  }
  return out;
});

const razzWeight = RAZZ_STATES.map(({ up, a, b }) => {
  const av = (r) => (r === up ? 3 : 4);
  return a === b ? (av(a) * (av(a) - 1)) / 2 : av(a) * av(b);
});

// Razz low, A-5: smaller is better. The best five are every distinct rank
// (lowest first) topped up with the lowest pairs, then trips, if fewer than
// five ranks are present. Encoded as category, then the ranks grouped by how
// often they appear and highest first, 4 bits each — so one pair loses to no
// pair, a lower pair beats a higher one, and kickers break ties.
const rcnt = new Uint8Array(13), mult = new Uint8Array(13);
export function razzEval(cs, n) {
  rcnt.fill(0);
  let distinct = 0;
  for (let k = 0; k < n; k++) if (rcnt[cs[k] >> 2]++ === 0) distinct++;
  const m = Math.min(5, n);
  mult.fill(0);
  let take = m, extra = Math.max(0, m - distinct);
  for (let r = 0; r < 13 && take > 0; r++) if (rcnt[r]) { mult[r] = 1; take--; }
  for (let level = 2; level <= 4 && extra > 0; level++)
    for (let r = 0; r < 13 && extra > 0; r++)
      if (mult[r] === level - 1 && rcnt[r] >= level) { mult[r] = level; extra--; }
  // category from the multiplicity pattern
  let pairs = 0, trips = 0, quads = 0;
  for (let r = 0; r < 13; r++) {
    if (mult[r] === 2) pairs++; else if (mult[r] === 3) trips++; else if (mult[r] === 4) quads++;
  }
  const cat = quads ? 5 : trips && pairs ? 4 : trips ? 3 : pairs >= 2 ? 2 : pairs ? 1 : 0;
  // left-aligned in five slots, so boards of any size compare category first
  let v = cat, groups = 0;
  for (let level = 4; level >= 1; level--)
    for (let r = 12; r >= 0; r--) if (mult[r] === level) { v = v * 16 + r; groups++; }
  for (; groups < 5; groups++) v *= 16;
  return v;
}

function razzDowns(id, su, rng, out) {
  const { a, b } = RAZZ_STATES[id];
  if (a === b) {
    const x = rng.int(4); let y = rng.int(3); if (y >= x) y++;
    out[0] = card(a, x); out[1] = card(a, y);
  } else {
    out[0] = card(a, rng.int(4)); out[1] = card(b, rng.int(4));
  }
  return true;
}

const razz = {
  name: "razz",
  hasSuits: false,
  states: RAZZ_STATES,
  n: RAZZ_STATES.length,         // 1183
  configs: razzConfigs,
  weight: razzWeight,
  up: (id) => RAZZ_STATES[id].up,
  suited: () => false,
  share: (a, b) => {
    const x = razzEval(a, 7), y = razzEval(b, 7);
    return x < y ? 1 : x > y ? 0 : 0.5;
  },
  first: (cs, n) => -razzEval(cs, n),   // the lowest board showing acts first
  downsFor: razzDowns,
  down: RAZZ_DOWN,
};

export const GAMES = { hi: stud(false), hl: stud(true), razz };
