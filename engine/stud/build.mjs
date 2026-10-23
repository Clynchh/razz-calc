// Builds the data tables behind the calculator pages.
//
//   node engine/stud/build.mjs <hi|hl|razz> <task> [--seats 6|3|2] [--trials N] [--look L] [--k K]
//
// Tasks, in the order each reads what the one before wrote:
//
//   avg      each hand's N-way all-in equity against N-1 random hands, which
//            orders ranges                                [--trials 20000]
//   hu       the heads-up all-in matrix (stud only; one per game, any seats)
//                                                         [--trials 3000]
//   rates    continue/raise rates: a provisional guess, then a quick realised
//            bootstrap pass                               [--trials 8]
//   real     realised value with 4th-7th played out       [--look 2|4] [--trials 64]
//   suitadj  stud only: how a suited hand's value moves with the number of
//            its suit showing on the board               [--trials 48000]
//   all      every step above for one game and table size
//
// Output: data/stud (hi), data/stud8 (hl); three-handed and heads-up go in an
// n3 or n2 folder under those. Razz's six-handed tables came from the original
// razz solver and live in data/; this engine adds data/razz/n3 and n2 only.
// File formats are razz's: RZHU for the all-in matrix, RZRT version 2 for the
// realised tables.

import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { GAMES } from "./games.mjs";
import { allInRates, razzSolvedRates, realisedRates, Q_COMPLETE } from "./fit.mjs";
import { multisetRank } from "../../js/combinadics.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

const [gameKey, task, ...rest] = process.argv.slice(2);
const opt = (name, dflt) => {
  const k = rest.indexOf(`--${name}`);
  return k >= 0 ? Number(rest[k + 1]) : dflt;
};
const game = GAMES[gameKey];
const SEATS = opt("seats", 6);
if (!game || !task || ![6, 3, 2].includes(SEATS)) {
  console.error("usage: build.mjs <hi|hl|razz> <avg|hu|rates|real|suitadj|all> [--seats 6|3|2] [--trials N] [--look L] [--k K]");
  process.exit(1);
}
const isRazz = gameKey === "razz";
if (isRazz && SEATS === 6) {
  console.error("razz six-handed comes from the original solver (data/); build --seats 3 or 2");
  process.exit(1);
}
const BASE = join(ROOT, "data", isRazz ? "razz" : gameKey === "hl" ? "stud8" : "stud");
const OUT = SEATS === 6 ? BASE : join(BASE, `n${SEATS}`);
mkdirSync(OUT, { recursive: true });

// stakes, as razz: the pot each branch reaches 4th street with
const ANTE = 15, BET = 100;
const DEAD = (SEATS - 2) * ANTE;
const POT_CALL = 2 * BET + DEAD;
const POT_RAISE = 4 * BET + DEAD;
const Q = Q_COMPLETE[SEATS];
const INNER_K = 16;

/** Run one task across all cores, with a progress line every few seconds. */
function runPool(label, data) {
  const threads = availableParallelism();
  const counter = new SharedArrayBuffer(4);
  let done = 0, finished = 0, shown = 0;
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    for (let w = 0; w < threads; w++) {
      const wk = new Worker(join(HERE, "worker.mjs"), {
        workerData: { ...data, gameKey, seats: SEATS, counter },
      });
      wk.on("message", (m) => {
        if (m.rows) {
          done += m.rows;
          const s = (Date.now() - t0) / 1000;
          if (s - shown >= 15) {
            shown = s;
            console.log(`${label}: ${done}/${game.n} rows  ${s.toFixed(0)}s  eta ${((s * (game.n - done)) / done).toFixed(0)}s`);
          }
        }
        if (m.done && ++finished === threads) {
          console.log(`${label}: done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
          resolve();
        }
      });
      wk.on("error", reject);
    }
  });
}

/** State-level averages: razz keeps them beside the page's upcard-blind 455. */
function loadAvg() {
  const j = JSON.parse(readFileSync(join(OUT, "average.json"), "utf8"));
  return j.stateMean ?? j.meanEquity;
}
const loadRates = () => JSON.parse(readFileSync(join(OUT, "rates.json"), "utf8"));
const label = (s) => `${game.name} ${SEATS}-handed ${s}`;

async function buildAvg() {
  const trials = opt("trials", 20000);
  const buf = new SharedArrayBuffer(8 * game.n);
  await runPool(label("avg"), { task: "avg", trials, seed: 0x5eed01 + SEATS, out: buf });
  const state = Array.from(new Float64Array(buf), (x) => Number(x.toFixed(6)));
  const meta = { schema: 1, game: game.name, seats: SEATS, trials };
  if (!isRazz) {
    writeFileSync(join(OUT, "average.json"), JSON.stringify({ ...meta, model: "state", meanEquity: state }));
    return;
  }
  // the razz page reads an upcard-blind table keyed by sorted rank triple
  const num = new Float64Array(455), den = new Float64Array(455);
  game.states.forEach(({ up, a, b }, id) => {
    const k = multisetRank([a, b, up].sort((x, y) => x - y));
    num[k] += game.weight[id] * state[id];
    den[k] += game.weight[id];
  });
  const blind = Array.from(num, (x, k) => Number((den[k] ? x / den[k] : 0).toFixed(6)));
  writeFileSync(join(OUT, "average.json"), JSON.stringify({ ...meta, model: "upcard-blind", meanEquity: blind, stateMean: state }));
}

async function buildHu() {
  if (isRazz) { console.log("razz uses data/hu.bin"); return; }
  const trials = opt("trials", 3000);
  const buf = new SharedArrayBuffer(2 * game.n * game.n);
  await runPool(label("hu"), { task: "hu", trials, seed: 0x5eed02, out: buf });
  const head = Buffer.alloc(14);
  head.write("RZHU", 0, "latin1");
  head.writeUInt16LE(1, 4);
  head.writeUInt32LE(trials, 6);
  head.writeUInt16LE(game.n, 10);
  writeFileSync(join(BASE, "hu.bin"), Buffer.concat([head, Buffer.from(buf)]));
}

/** Both branches of one realised table, held in memory. */
async function realPass(look, trials, k, rates, name) {
  const cells = game.n * game.n;
  const ok = new SharedArrayBuffer(cells);
  const S = [], M = [];
  for (const [b, pot3, villain] of [[0, POT_CALL, rates.continue], [1, POT_RAISE, rates.raise]]) {
    const out = { S: new SharedArrayBuffer(2 * cells), M: new SharedArrayBuffer(2 * cells), ok };
    await runPool(`${name} ${b ? "raise" : "call"}`, {
      task: "real", trials, seed: 0x5eed10 + 7 * look + b + trials + SEATS, out,
      avg: loadAvg(), look, pot3, rates: { open: rates.open, villain, k },
    });
    S.push(new Int16Array(out.S));
    M.push(new Int16Array(out.M));
  }
  return { ok: new Uint8Array(ok), S, M };
}

async function buildRates() {
  const avg = loadAvg();
  const prov = isRazz
    ? razzSolvedRates(game, avg, Q)
    : allInRates(game, avg, readFileSync(join(BASE, "hu.bin")), DEAD, Q);
  console.log("provisional:", JSON.stringify({ continue: prov.continue, raise: prov.raise }));
  const boot = await realPass(2, opt("trials", 8), INNER_K, prov, label("bootstrap la2"));
  const fin = realisedRates(game, avg, boot, DEAD, Q);
  fin.seats = SEATS;
  fin.provisional = { basis: prov.basis, continue: prov.continue, raise: prov.raise, open: prov.open };
  writeFileSync(join(OUT, "rates.json"), JSON.stringify(fin, null, 1));
  console.log("final (realised):", JSON.stringify({ continue: fin.continue, raise: fin.raise }));
}

async function buildReal(look = opt("look", 2)) {
  const trials = opt("trials", 64);
  const t = await realPass(look, trials, opt("k", INNER_K), loadRates(), label(`real la${look}`));
  const head = Buffer.alloc(16);
  head.write("RZRT", 0, "latin1");
  head.writeUInt8(2, 4);
  head.writeUInt8(look, 5);
  head.writeUInt32LE(trials, 6);
  head.writeUInt16LE(game.n, 10);
  const bytes = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
  writeFileSync(join(OUT, `real-la${look}.bin`), Buffer.concat([
    head, bytes(t.ok), bytes(t.S[0]), bytes(t.M[0]), bytes(t.S[1]), bytes(t.M[1]),
  ]));
}

async function buildSuitAdj() {
  if (!game.hasSuits) { console.log("razz has no suit effects"); return; }
  const trials = opt("trials", 48000);
  const rates = loadRates();
  const runs = [];
  for (const look of [2, 4]) {
    const buf = new SharedArrayBuffer(8 * 4 * game.n);
    await runPool(label(`suitadj la${look}`), {
      task: "suitadj", trials, seed: 0x5eed20 + look + SEATS, out: buf, avg: loadAvg(), look, pot3: POT_CALL,
      rates: { open: rates.open, villain: rates.continue, k: INNER_K },
    });
    runs.push(new Float64Array(buf));
  }
  // the two lookaheads weighted equally, as the page weights its tables
  const delta = [];
  for (let id = 0; id < game.n; id++) {
    if (!game.suited(id)) { delta.push(null); continue; }
    const row = [];
    for (let b = 0; b < 4; b++) {
      const xs = runs.map((r) => r[id * 4 + b]).filter((x) => !Number.isNaN(x));
      row.push(xs.length ? Number((xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(1)) : null);
    }
    delta.push(row);
  }
  writeFileSync(join(OUT, "suitadj.json"), JSON.stringify({
    schema: 1, game: game.name, seats: SEATS, trials, buckets: ["0", "1", "2", "3+"],
    note: "cents per called pot, relative to the suit-blind average, by cards of hero's suit showing elsewhere",
    delta,
  }));
}

const steps = {
  avg: buildAvg,
  hu: buildHu,
  rates: buildRates,
  real: () => buildReal(),
  suitadj: buildSuitAdj,
  all: async () => {
    await buildAvg();
    if (!isRazz && !existsSync(join(BASE, "hu.bin"))) await buildHu();
    await buildRates();
    await buildReal(2);
    await buildReal(4);
    await buildSuitAdj();
  },
};
if (!steps[task]) { console.error(`unknown task ${task}`); process.exit(1); }
await steps[task]();
