// Shared core for the engine: card encoding, the stud hand evaluators, the
// samplers, and the heads-up play-out that the builders run inside worker
// threads. Everything game-specific — which states exist, how hands compare,
// who acts first — comes in through a game object from games.mjs.
//
// A card is rank * 4 + suit. Stud ranks run strongest first (0 = A ... 12 = 2,
// the page's order); razz ranks run A = 0 ... K = 12. Either way the bring-in
// is the highest rank index, so the page's seating code serves all three.

export const card = (r, s) => r * 4 + s;
export const rankOf = (c) => c >> 2;
export const suitOf = (c) => c & 3;

// ---- stud evaluators -------------------------------------------------------
//
// High: larger is better. Bits are 1 << (12 - rank) so the ace is the top bit
// and a mask compares the right way round as a plain number.

const POP = new Uint8Array(8192);
for (let m = 1; m < 8192; m++) POP[m] = POP[m >> 1] + (m & 1);

const STRAIGHT = new Int8Array(8192).fill(-1);   // top bit of the best straight
for (let m = 0; m < 8192; m++) {
  for (let t = 12; t >= 4; t--)
    if (((m >> (t - 4)) & 31) === 31) { STRAIGHT[m] = t; break; }
  if (STRAIGHT[m] < 0 && (m & 0x100f) === 0x100f) STRAIGHT[m] = 3;   // A-2-3-4-5
}

function topBits(m, k) {
  let out = 0;
  while (k-- > 0 && m) {
    const b = 1 << (31 - Math.clz32(m));
    out |= b;
    m &= ~b;
  }
  return out;
}

const cnt = new Uint8Array(13);

/** Best high hand from the first n cards of cs (n may be 1..7). */
export function evalHi(cs, n) {
  cnt.fill(0);
  let all = 0, s0 = 0, s1 = 0, s2 = 0, s3 = 0;
  for (let k = 0; k < n; k++) {
    const c = cs[k], b = 12 - (c >> 2), bit = 1 << b;
    cnt[b]++;
    all |= bit;
    const s = c & 3;
    if (s === 0) s0 |= bit; else if (s === 1) s1 |= bit; else if (s === 2) s2 |= bit; else s3 |= bit;
  }
  const fm = POP[s0] >= 5 ? s0 : POP[s1] >= 5 ? s1 : POP[s2] >= 5 ? s2 : POP[s3] >= 5 ? s3 : 0;
  if (fm && STRAIGHT[fm] >= 0) return (8 << 27) | STRAIGHT[fm];
  let quad = -1, t1 = -1, t2 = -1, p1 = -1, p2 = -1;
  for (let b = 12; b >= 0; b--) {
    const c = cnt[b];
    if (c === 4) quad = b;
    else if (c === 3) { if (t1 < 0) t1 = b; else if (t2 < 0) t2 = b; }
    else if (c === 2) { if (p1 < 0) p1 = b; else if (p2 < 0) p2 = b; }
  }
  if (quad >= 0) return (7 << 27) | (quad << 4) | (31 - Math.clz32(all & ~(1 << quad)) & 15);
  if (t1 >= 0 && (t2 >= 0 || p1 >= 0)) return (6 << 27) | (t1 << 4) | Math.max(t2, p1);
  if (fm) return (5 << 27) | topBits(fm, 5);
  if (STRAIGHT[all] >= 0) return (4 << 27) | STRAIGHT[all];
  if (t1 >= 0) return (3 << 27) | (t1 << 13) | topBits(all & ~(1 << t1), 2);
  if (p2 >= 0) return (2 << 27) | (p1 << 17) | (p2 << 13) | topBits(all & ~(1 << p1) & ~(1 << p2), 1);
  if (p1 >= 0) return (1 << 27) | (p1 << 13) | topBits(all & ~(1 << p1), 3);
  return topBits(all, 5);
}

// Low (8 or better, aces low): smaller is better, -1 = no qualifying low.
// Bit l is low rank l (A = 0, 2 = 1 ... 8 = 7); the five lowest set bits,
// read as a number, compare highest card first.
const LOWV = new Int8Array(13).fill(-1);
LOWV[0] = 0;
for (let r = 6; r <= 12; r++) LOWV[r] = 13 - r;                  // 8 -> 7 ... 2 -> 1
const LOW5 = new Int16Array(256).fill(-1);
for (let m = 0; m < 256; m++) {
  if (POP[m] < 5) continue;
  let out = 0, k = 0;
  for (let b = 0; b < 8 && k < 5; b++) if (m & (1 << b)) { out |= 1 << b; k++; }
  LOW5[m] = out;
}

export function evalLow(cs, n) {
  let m = 0;
  for (let k = 0; k < n; k++) {
    const l = LOWV[cs[k] >> 2];
    if (l >= 0) m |= 1 << l;
  }
  return LOW5[m];
}

// ---- randomness -----------------------------------------------------------

export class Rng {
  constructor(seed) { this.x = (seed >>> 0) || 0x9e3779b9; }
  next() {
    let x = this.x;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return (this.x = x >>> 0);
  }
  int(n) { return ((this.next() * n) / 4294967296) | 0; }
  float() { return this.next() / 4294967296; }
}

/**
 * Card marking with a stamp, so "clear the deck" is one increment rather than
 * a 52-entry fill. Each nesting level of the simulation owns its own Deck.
 */
export class Deck {
  constructor(rng) { this.rng = rng; this.mark = new Uint32Array(52); this.stamp = 1; }
  reset() { if (++this.stamp === 0xffffffff) { this.mark.fill(0); this.stamp = 1; } }
  take(c) { if (this.mark[c] === this.stamp) return false; this.mark[c] = this.stamp; return true; }
  has(c) { return this.mark[c] === this.stamp; }
  draw() {
    for (;;) {
      const c = this.rng.int(52);
      if (this.mark[c] !== this.stamp) { this.mark[c] = this.stamp; return c; }
    }
  }
}

/** Mark a config's three cards; false (and nothing marked) if any is taken. */
export function takeConfig(deck, cfg) {
  const [a, b, c] = cfg;
  if (deck.has(a) || deck.has(b) || deck.has(c)) return false;
  deck.take(a); deck.take(b); deck.take(c);
  return true;
}

// ---- 3rd-street ranges as later-street priors ---------------------------
//
// When a player estimates their chances on 4th-7th, the opponent's two hidden
// cards are drawn from the range that player could have reached 4th street
// with — not from a random hand. A range is "the top fraction of hands with
// this upcard, by average strength", the same construction the page uses.

/** For each upcard rank: { ids, cum, total } over the top `frac(up)` of its states. */
export function buildPriors(game, avg, frac) {
  const byUp = Array.from({ length: 13 }, () => []);
  for (let id = 0; id < game.n; id++) byUp[game.up(id)].push({ id, w: game.weight[id], s: avg[id] });
  return byUp.map((cand, up) => {
    cand.sort((a, b) => b.s - a.s);
    const total = cand.reduce((s, c) => s + c.w, 0);
    const f = Math.max(0.02, Math.min(1, frac(up)));
    const keep = [];
    let acc = 0;
    for (const c of cand) {
      if (acc >= f * total) break;
      keep.push(c);
      acc += c.w;
    }
    const ids = new Int16Array(keep.length), cum = new Float64Array(keep.length);
    let run = 0;
    keep.forEach((c, k) => { ids[k] = c.id; run += c.w; cum[k] = run; });
    return { ids, cum, total: run };
  });
}

/**
 * Draw two hidden downcards for a player whose upcard is `upCard`, from that
 * player's prior range, avoiding every card already marked in `deck`. Falls
 * back to two random cards if the range is exhausted by card removal.
 */
export function samplePriorDowns(game, deck, rng, prior, upCard, out) {
  const p = prior[rankOf(upCard)], su = suitOf(upCard);
  for (let tries = 0; tries < 60; tries++) {
    const t = rng.float() * p.total;
    let lo = 0, hi = p.cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (p.cum[mid] > t) hi = mid; else lo = mid + 1; }
    if (!game.downsFor(p.ids[lo], su, rng, out)) continue;
    const x = out[0], y = out[1];
    if (x === y || deck.has(x) || deck.has(y)) continue;
    deck.take(x); deck.take(y);
    return;
  }
  out[0] = deck.draw(); out[1] = deck.draw();
}

// ---- later-street play ---------------------------------------------------

export const ANTE = 15, BET = 100;
export const betSize = (street) => (street === 4 ? BET : 2 * BET);

/** Bet or raise for value at these estimated shares, as in the razz model. */
export const BET_AT = 0.55, RAISE_AT = 0.70;

/**
 * The pot-odds bar for calling. The caller prices `look` streets of betting —
 * this one and look-1 more at one bet each — into the decision.
 */
export function needToCall(pot, cost, street, look) {
  let fut = 0;
  for (let s = street + 1; s <= Math.min(7, street + look - 1); s++) fut += betSize(s);
  return (cost + fut) / (pot + cost + 2 * fut);
}

/**
 * One heads-up play-out from 4th street to the river.
 *
 * `h` and `v` are 7-slot card arrays with slots 0-2 already filled (down,
 * down, 3rd-street upcard). Slots 3-5 are 4th-6th (up), 6 is 7th (down).
 * `dead` holds upcards folded elsewhere at the table: out of the deck, and
 * seen by both players. Returns hero's share of the 3rd-street pot in `res.w`
 * and hero's net from money put in on later streets in `res.m`.
 */
export class Playout {
  constructor(opts) {
    this.game = opts.game;
    this.look = opts.look;
    this.k = opts.k;                    // inner samples per estimate
    this.rng = opts.rng;
    this.deck = new Deck(this.rng);     // the real deal
    this.inner = new Deck(this.rng);    // a player's imagined deals
    this.xa = new Int8Array(7);
    this.oa = new Int8Array(7);
    this.tmp = new Int8Array(2);
    this.vis = new Int8Array(4);
    this.dead = new Int8Array(8);
    this.nDead = 0;
    this.res = { w: 0, m: 0 };
  }

  /**
   * What `x` thinks its share of the pot is on `street`: its own cards, the
   * opponent's upcards and the dead cards are known, the opponent's downcards
   * come from `prior` (the range x believes the opponent holds), the rest is
   * random.
   */
  estimate(x, o, street, prior) {
    const { inner, rng, xa, oa, tmp, game, dead, nDead } = this;
    const nUp = Math.min(street, 6) - 2;           // opponent upcards showing
    let sum = 0;
    for (let k = 0; k < this.k; k++) {
      inner.reset();
      for (let q = 0; q < nDead; q++) inner.take(dead[q]);
      for (let q = 0; q < street; q++) { xa[q] = x[q]; inner.take(x[q]); }
      for (let q = 2; q < 2 + nUp; q++) { oa[q] = o[q]; inner.take(o[q]); }
      samplePriorDowns(game, inner, rng, prior, o[2], tmp);
      oa[0] = tmp[0]; oa[1] = tmp[1];
      for (let q = street; q < 7; q++) xa[q] = inner.draw();
      for (let q = 2 + nUp; q < 7; q++) oa[q] = inner.draw();
      sum += game.share(xa, oa);
    }
    return sum / this.k;
  }

  visible(p, street) {
    const n = Math.min(street, 6) - 2;
    for (let q = 0; q < n; q++) this.vis[q] = p[2 + q];
    return this.game.first(this.vis, n);
  }

  /**
   * @param pot3   the 3rd-street pot (both players' bets plus dead money)
   * @param heroPrior  the range the *villain* puts hero on
   * @param vilPrior   the range *hero* puts the villain on
   * @param dead   optional dead upcards (folded elsewhere at the table)
   */
  run(h, v, pot3, heroPrior, vilPrior, dead = null) {
    const { deck, look } = this;
    deck.reset();
    this.nDead = dead ? dead.length : 0;
    for (let q = 0; q < this.nDead; q++) { this.dead[q] = dead[q]; deck.take(dead[q]); }
    for (let q = 0; q < 3; q++) { deck.take(h[q]); deck.take(v[q]); }
    let ch = 0, cv = 0;                            // later-street contributions
    for (let street = 4; street <= 7; street++) {
      h[street - 1] = deck.draw();
      v[street - 1] = deck.draw();
      const b = betSize(street);
      const vh = this.visible(h, street), vv = this.visible(v, street);
      const heroFirst = vh > vv || (vh === vv && this.rng.int(2) === 0);
      // F acts first, S second; estimates are made at most once a street
      const F = heroFirst ? h : v, S = heroFirst ? v : h;
      const fPrior = heroFirst ? vilPrior : heroPrior;   // what F believes of S
      const sPrior = heroFirst ? heroPrior : vilPrior;
      let eF = -1, eS = -1;
      const estF = () => (eF >= 0 ? eF : (eF = this.estimate(F, S, street, fPrior)));
      const estS = () => (eS >= 0 ? eS : (eS = this.estimate(S, F, street, sPrior)));
      let cF = 0, cS = 0, folded = 0;              // folded: 1 = F folded, 2 = S
      const pot = () => pot3 + ch + cv + cF + cS;

      if (estF() >= BET_AT) {
        cF = b;
        if (estS() >= RAISE_AT) {
          cS = 2 * b;
          if (estF() >= needToCall(pot(), b, street, look)) cF = 2 * b; else folded = 1;
        } else if (estS() >= needToCall(pot(), b, street, look)) cS = b;
        else folded = 2;
      } else if (estS() >= BET_AT) {
        cS = b;
        if (estF() >= RAISE_AT) {
          cF = 2 * b;
          if (estS() >= needToCall(pot(), b, street, look)) cS = 2 * b; else folded = 2;
        } else if (estF() >= needToCall(pot(), b, street, look)) cF = b;
        else folded = 1;
      }

      if (heroFirst) { ch += cF; cv += cS; } else { ch += cS; cv += cF; }
      if (folded) {
        const heroFolded = (folded === 1) === heroFirst;
        this.res.w = heroFolded ? 0 : 1;
        this.res.m = heroFolded ? -ch : cv;
        return this.res;
      }
    }
    const w = this.game.share(h, v);
    this.res.w = w;
    this.res.m = w * (ch + cv) - ch;
    return this.res;
  }
}
