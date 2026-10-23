// One build worker. Rows (hero states) are handed out through a shared atomic
// counter, so fast and slow rows balance across threads without planning.

import { workerData, parentPort } from "node:worker_threads";
import { Rng, Deck, takeConfig, evalHi, evalLow, Playout, buildPriors, samplePriorDowns, suitOf } from "./core.mjs";
import { GAMES, razzEval } from "./games.mjs";

const { gameKey, task, trials, seed, counter, out, avg, rates, look, pot3, seats } = workerData;
const game = GAMES[gameKey];
const N = game.n;
const next = new Int32Array(counter);
const rowsDone = (n) => parentPort.postMessage({ rows: n });

const pick = (rng, list) => list[rng.int(list.length)];

/** Sample two independent configs until they share no card; null if never. */
function dealPair(deck, rng, h, v, hc, vc) {
  for (let t = 0; t < 400; t++) {
    deck.reset();
    const a = pick(rng, hc), b = pick(rng, vc);
    if (!takeConfig(deck, a) || !takeConfig(deck, b)) continue;
    h[0] = a[1]; h[1] = a[2]; h[2] = a[0];
    v[0] = b[1]; v[1] = b[2]; v[2] = b[0];
    return true;
  }
  return false;
}

/** Can these two states coexist at all? Exhaustive, so never a false "no". */
function compatible(hc, vc) {
  for (const a of hc)
    for (const b of vc)
      if (a[0] !== b[0] && a[0] !== b[1] && a[0] !== b[2] && a[1] !== b[0] && a[1] !== b[1] &&
          a[1] !== b[2] && a[2] !== b[0] && a[2] !== b[1] && a[2] !== b[2]) return true;
  return false;
}

/** Hero's (player 0's) share of a multiway pot at showdown. */
const his = new Float64Array(8), los = new Int32Array(8);
function multiwayShare(hands, n) {
  if (game.name === "razz") {
    let best = Infinity, nb = 0;
    for (let p = 0; p < n; p++) {
      const x = (his[p] = razzEval(hands[p], 7));
      if (x < best) { best = x; nb = 1; } else if (x === best) nb++;
    }
    return his[0] === best ? 1 / nb : 0;
  }
  const hl = game.name === "stud8";
  let bestHi = -1, nHi = 0, bestLo = 1 << 20, nLo = 0;
  for (let p = 0; p < n; p++) {
    const x = (his[p] = evalHi(hands[p], 7));
    if (x > bestHi) { bestHi = x; nHi = 1; } else if (x === bestHi) nHi++;
    if (hl) {
      const l = (los[p] = evalLow(hands[p], 7));
      if (l >= 0) { if (l < bestLo) { bestLo = l; nLo = 1; } else if (l === bestLo) nLo++; }
    }
  }
  const hiShare = his[0] === bestHi ? 1 / nHi : 0;
  if (hl && nLo) return 0.5 * hiShare + 0.5 * (los[0] === bestLo ? 1 / nLo : 0);
  return hiShare;
}

if (task === "avg") {
  // N-way all-in: hero against seats-1 random hands, share of the whole pot
  const res = new Float64Array(out);
  const hands = Array.from({ length: seats }, () => new Int8Array(7));
  for (let row; (row = Atomics.add(next, 0, 1)) < N; ) {
    const rng = new Rng(seed ^ (row * 2654435761));
    const deck = new Deck(rng);
    let sum = 0;
    for (let t = 0; t < trials; t++) {
      deck.reset();
      const cfg = pick(rng, game.configs[row]);
      takeConfig(deck, cfg);
      hands[0][0] = cfg[1]; hands[0][1] = cfg[2]; hands[0][2] = cfg[0];
      for (let p = 0; p < seats; p++) for (let q = p === 0 ? 3 : 0; q < 7; q++) hands[p][q] = deck.draw();
      sum += multiwayShare(hands, seats);
    }
    res[row] = sum / trials;
    rowsDone(1);
  }
} else if (task === "hu") {
  // heads-up all-in equity, h <= v only; the other half is 1 - x
  const res = new Uint16Array(out);
  const h = new Int8Array(7), v = new Int8Array(7);
  for (let row; (row = Atomics.add(next, 0, 1)) < N; ) {
    const rng = new Rng(seed ^ (row * 2654435761));
    const deck = new Deck(rng);
    for (let col = row; col < N; col++) {
      const hc = game.configs[row], vc = game.configs[col];
      if (!compatible(hc, vc)) {
        res[row * N + col] = res[col * N + row] = 0xffff;
        continue;
      }
      let sum = 0;
      for (let t = 0; t < trials; t++) {
        if (!dealPair(deck, rng, h, v, hc, vc)) { t--; continue; }
        for (let q = 3; q < 7; q++) { h[q] = deck.draw(); v[q] = deck.draw(); }
        sum += game.share(h, v);
      }
      const x = Math.round((sum / trials) * 65534);
      res[row * N + col] = x;
      res[col * N + row] = 65534 - x;
    }
    rowsDone(1);
  }
} else if (task === "real") {
  // realised value with 4th-7th played out, for one pot (one branch)
  const S = new Int16Array(out.S), M = new Int16Array(out.M), ok = new Uint8Array(out.ok);
  const heroPrior = buildPriors(game, avg, (u) => rates.open[u]);
  const vilPrior = buildPriors(game, avg, (u) => rates.villain[u]);
  const h = new Int8Array(7), v = new Int8Array(7);
  for (let row; (row = Atomics.add(next, 0, 1)) < N; ) {
    const rng = new Rng(seed ^ (row * 2654435761));
    const deck = new Deck(rng);
    const play = new Playout({ game, look, k: rates.k, rng });
    for (let col = 0; col < N; col++) {
      const k = row * N + col;
      const hc = game.configs[row], vc = game.configs[col];
      if (!compatible(hc, vc)) { ok[k] = 0; continue; }
      let sw = 0, sm = 0;
      for (let t = 0; t < trials; t++) {
        if (!dealPair(deck, rng, h, v, hc, vc)) { t--; continue; }
        const r = play.run(h, v, pot3, heroPrior, vilPrior);
        sw += r.w; sm += r.m;
      }
      ok[k] = 1;
      S[k] = Math.round((2 * sw / trials - 1) * 10000);
      M[k] = Math.max(-32767, Math.min(32767, Math.round(sm / trials)));
    }
    rowsDone(1);
  }
} else if (task === "suitadj") {
  // How a suited hand's realised value moves with the number of cards of its
  // suit showing elsewhere on the board (villain's upcard and the seats that
  // folded), bucketed 0, 1, 2, 3+. Hero faces one caller drawn from the
  // continuing ranges; the rest of the board is random and dead.
  const res = new Float64Array(out);
  const heroPrior = buildPriors(game, avg, (u) => rates.open[u]);
  const vilPrior = buildPriors(game, avg, (u) => rates.villain[u]);
  const maxCont = Math.max(...rates.villain);
  const H = 100, D = pot3 - 200, nDead = seats - 2;
  const h = new Int8Array(7), v = new Int8Array(7), tmp = new Int8Array(2);
  const dead = new Int8Array(nDead);
  for (let row; (row = Atomics.add(next, 0, 1)) < N; ) {
    if (!game.suited(row)) { for (let b = 0; b < 4; b++) res[row * 4 + b] = NaN; rowsDone(1); continue; }
    const rng = new Rng(seed ^ (row * 2654435761));
    const deck = new Deck(rng);
    const play = new Playout({ game, look, k: rates.k, rng });
    const sum = new Float64Array(4), cnt = new Float64Array(4);
    let all = 0;
    for (let t = 0; t < trials; t++) {
      deck.reset();
      const cfg = pick(rng, game.configs[row]);
      takeConfig(deck, cfg);
      h[0] = cfg[1]; h[1] = cfg[2]; h[2] = cfg[0];
      const su = suitOf(cfg[0]);
      // the caller's upcard, weighted by how often that rank continues
      let vu;
      for (;;) {
        vu = deck.draw();
        if (rng.float() * maxCont < rates.villain[vu >> 2]) break;
        deck.mark[vu] = 0;                       // put it back
      }
      samplePriorDowns(game, deck, rng, vilPrior, vu, tmp);
      v[0] = tmp[0]; v[1] = tmp[1]; v[2] = vu;
      let k = suitOf(vu) === su ? 1 : 0;
      for (let q = 0; q < nDead; q++) { dead[q] = deck.draw(); if (suitOf(dead[q]) === su) k++; }
      const r = play.run(h, v, pot3, heroPrior, vilPrior, nDead ? dead : null);
      const net = r.w * (2 * H + D) - H + r.m;
      const b = Math.min(k, 3);
      sum[b] += net; cnt[b]++;
      all += net;
    }
    const mean = all / trials;
    for (let b = 0; b < 4; b++) res[row * 4 + b] = cnt[b] >= 50 ? sum[b] / cnt[b] - mean : NaN;
    rowsDone(1);
  }
}

parentPort.postMessage({ done: true });
