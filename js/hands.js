// Hero starting hands: sorted rank triples, ordered by multiset rank.
// Mirrors engine/hands.h. For k=3 the ranks are dense, so hand id == the
// multiset rank of the sorted triple.

import { multisetRank } from "./combinadics.js";

export const N_HANDS = 455;

const _all = [];
for (let a = 0; a < 13; a++)
  for (let b = a; b < 13; b++)
    for (let c = b; c < 13; c++) _all.push([a, b, c]);
_all.sort((x, y) => multisetRank(x) - multisetRank(y));

/** hand id -> sorted rank triple */
export const HANDS = _all;

/** 13^3 reverse lookup; every permutation resolves to its canonical id. */
export const HAND_INDEX = new Int16Array(2197).fill(-1);
for (let a = 0; a < 13; a++)
  for (let b = 0; b < 13; b++)
    for (let c = 0; c < 13; c++) {
      const s = [a, b, c].sort((p, q) => p - q);
      HAND_INDEX[a * 169 + b * 13 + c] = multisetRank(s);
    }

export function handId(a, b, c) {
  return HAND_INDEX[a * 169 + b * 13 + c];
}

const RANK_CH = "A23456789TJQK";
export const rankChar = (r) => RANK_CH[r] ?? "?";
export const handLabel = (triple) => triple.map(rankChar).join("");
export const handLabelDashed = (triple) => triple.map(rankChar).join("-");
