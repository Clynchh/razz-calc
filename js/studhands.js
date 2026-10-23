// Stud starting hands, for both stud hi and stud hi-lo. The engine imports
// this file too (engine/stud/core.mjs), so the page and the tables can never
// disagree about which state is which.
//
// Ranks run strongest first: 0 = A, 1 = K ... 12 = 2. That puts the bring-in
// (the lowest card) on the *highest* index, the same as razz, so the seating
// and board rules carry over unchanged.
//
// A state is (upcard rank, grid cell). The grid is the 13x13 hold'em square:
// row i, column j. The diagonal is a pair; above it (i < j) is *suited*, both
// downcards in the upcard's suit so all three cards share one; below it is
// everything else ("offsuit"). A suited cell sharing a rank with the upcard
// cannot exist, which leaves 157 cells per upcard and 2041 states.

export const RANKS = "AKQJT98765432";
export const rankChar = (r) => RANKS[r] ?? "?";

export const N_UP = 13, N_CELL = 169;
export const STATES = [];                         // id -> { up, g, i, j, kind }
export const STATE_ID = new Int16Array(N_UP * N_CELL).fill(-1);
for (let up = 0; up < N_UP; up++)
  for (let g = 0; g < N_CELL; g++) {
    const i = (g / 13) | 0, j = g % 13;
    const kind = i === j ? "pair" : i < j ? "suited" : "offsuit";
    if (kind === "suited" && (up === i || up === j)) continue;
    STATE_ID[up * N_CELL + g] = STATES.length;
    STATES.push({ up, g, i, j, kind });
  }
export const N_STATES = STATES.length;            // 2041
export const stateOf = (up, g) => STATE_ID[up * N_CELL + g];

export const cellKind = (g) => {
  const i = (g / 13) | 0, j = g % 13;
  return i === j ? "pair" : i < j ? "suited" : "offsuit";
};

/** The two downcard ranks of a cell, higher first. */
export const cellRanks = (g) => {
  const i = (g / 13) | 0, j = g % 13;
  return i <= j ? [i, j] : [j, i];
};

/** "AA", "AKs", "AKo" */
export function cellLabel(g) {
  const [a, b] = cellRanks(g);
  const k = cellKind(g);
  return rankChar(a) + rankChar(b) + (k === "suited" ? "s" : k === "offsuit" ? "o" : "");
}

/** "AKs/Q" — downcards, then the upcard */
export const handLabel = (g, up) => `${cellLabel(g)}/${rankChar(up)}`;

/**
 * Combos of a cell given how many of each rank are still unseen. Suits are
 * not tracked card by card, so the suited share is the full-deck 1 in 16 of
 * whatever rank combinations remain — exact with nothing removed.
 */
export function cellCombos(g, avail, up) {
  const [a, b] = cellRanks(g);
  const k = cellKind(g);
  if (k === "pair") return (avail[a] * (avail[a] - 1)) / 2;
  const tot = avail[a] * avail[b];
  const sharesUp = a === up || b === up;
  if (k === "suited") return sharesUp ? 0 : tot / 16;
  return sharesUp ? tot : (tot * 15) / 16;
}
