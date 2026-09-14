// Combinadic ranking of multisets — must stay byte-for-byte in step with
// engine/combinadics.h. See web/test/parity.mjs.

const C = (() => {
  const NMAX = 64;
  const t = Array.from({ length: NMAX }, () => new Array(NMAX).fill(0));
  for (let i = 0; i < NMAX; i++) {
    t[i][0] = 1;
    for (let j = 1; j <= i; j++) t[i][j] = t[i - 1][j - 1] + t[i - 1][j];
  }
  return t;
})();

export function binom(n, k) {
  if (k < 0 || n < 0 || k > n || n >= 64) return 0;
  return C[n][k];
}

// Dense index of a sorted multiset (m0 <= m1 <= ... <= m_{k-1}).
export function multisetRank(m) {
  let rank = 0;
  for (let i = 0; i < m.length; i++) rank += binom(m[i] + i, i + 1);
  return rank;
}

export function multisetCount(k, n) {
  return binom(n + k - 1, k);
}
