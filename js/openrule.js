// The opening rule: how much equity you need to complete, from the upcards
// behind you and your seat.
//
// Both halves are cheap, which is why this runs live rather than from a
// precomputed table of all 6,175 configurations:
//
//   * required equity is closed-form — pot odds against the chance everyone
//     folds, and that chance is a product of per-upcard continue rates
//   * your equity is a lookup in hu.bin
//
// The only estimated input is CONTINUE. Everything else is exact arithmetic.

export const ANTE = 15, BRING_IN = 30, BET = 100;

/**
 * Continue rate facing a completion, by upcard rank (0 = ace).
 *
 * A, 5, 7, 9, J and K are measured from the 6-handed solve; the rest are
 * interpolated on the same curve. This is the assumption to argue with — a jack
 * continuing 2% is why headcount alone misprices a board.
 */
export const CONTINUE = [0.92, 0.80, 0.66, 0.52, 0.40, 0.36, 0.32, 0.27, 0.23,
                         0.10, 0.02, 0.02, 0.03];

/**
 * Of that, how often the seat *raises* rather than flat-calls.
 *
 * This is the term the first version was missing, and it is not small: an ace
 * behind raises 91% of the time — it almost never just calls. Completing into
 * live cards therefore means getting 2-bet, not called, and a hand opened purely
 * on fold equity cannot continue for 200c. Measured for A/5/7/9/J/K from the
 * 6-handed solve, interpolated between.
 */
export const RAISE = [0.91, 0.70, 0.50, 0.35, 0.26, 0.19, 0.13, 0.09, 0.05,
                      0.03, 0.01, 0.01, 0.02];

/** The bring-in already has ante+bring-in in, so it defends far wider. */
export const bringInDefence = (rank, extra = 0.45) =>
  Math.min(0.95, CONTINUE[rank] + extra);

/**
 * Who acts when. Razz brings in on the highest upcard; ties go to the earliest
 * seat, which is a real simplification — at the table it is decided by suit, and
 * on a board with two kings that shifts the whole order.
 */
export function seating(ups) {
  // The bring-in is the rightmost seat by construction, not by detection. The
  // UI guarantees no other seat holds a higher card, and ties keep the bring-in
  // where it is — at the table that is settled by suit, which the rank-only
  // model cannot represent, so pinning it is more honest than picking a winner.
  const bringIn = ups.length - 1;
  const order = [];
  for (let q = 1; q < ups.length; q++) order.push((bringIn + q) % ups.length);
  return { bringIn, order };
}

/**
 * The pot-odds half.
 *
 * Splits the outcomes three ways rather than two, because being raised is a
 * different price from being called: you have 100c in and must find 200c, into a
 * range that chose to raise. The first version collapsed these and so opened far
 * too wide in late position — it never charged anything for being 2-bet off a
 * hand that only had fold equity going for it.
 */
/**
 * EV of completing, in cents, given this hand's equity against the two ranges it
 * can run into. Folding to the 2-bet is always available at −BET, so the raise
 * branch is floored there.
 */
export function evComplete(ctx, eqVsCall, eqVsRaise) {
  const call = eqVsCall * ctx.potCall - BET;
  const raise = Math.max(-BET, eqVsRaise * ctx.potRaise - 2 * BET);
  return ctx.pAllFold * ctx.winFold + ctx.pCallOnly * call + ctx.pRaised * raise;
}

export function requirement(ups, hero, biExtra = 0.45) {
  const n = ups.length;
  const { bringIn, order } = seating(ups);
  const pos = order.indexOf(hero) + 1;              // hero acts at BI+pos
  if (hero === bringIn) return null;                // the bring-in has its own spot

  const behind = order.slice(pos);                  // seats yet to act
  const biCont = bringInDefence(ups[bringIn], biExtra);

  let pAllFold = 1 - biCont;
  for (const s of behind) pAllFold *= 1 - CONTINUE[ups[s]];

  // chance each seat is the single caller — two callers is rare enough that
  // pricing against one keeps the arithmetic honest and readable
  const callers = [];
  let restFold = 1;
  for (const s of behind) restFold *= 1 - CONTINUE[ups[s]];
  for (const s of behind) {
    let p = CONTINUE[ups[s]] * (1 - biCont);
    for (const t of behind) if (t !== s) p *= 1 - CONTINUE[ups[t]];
    callers.push({ seat: s, up: ups[s], p });
  }
  callers.push({ seat: bringIn, up: ups[bringIn], p: biCont * restFold });

  // nobody raises, versus at least one raise
  let pNoRaise = 1 - Math.min(0.95, RAISE[ups[bringIn]] + biExtra * 0.3);
  for (const s of behind) pNoRaise *= 1 - RAISE[ups[s]];
  const pRaised = 1 - pNoRaise;
  const pCallOnly = Math.max(0, 1 - pAllFold - pRaised);

  const winFold = (n - 1) * ANTE + BRING_IN;        // 105c at six-handed
  const potCall = 2 * BET + (n - 2) * ANTE;         // ~260c heads-up after a call
  const potRaise = 4 * BET + (n - 2) * ANTE;        // ~460c if you call the 2-bet

  // who is doing the raising, for the equity lookup
  const raisers = [];
  for (const s of behind) if (RAISE[ups[s]] > 0.005) raisers.push({ up: ups[s], p: RAISE[ups[s]] });
  if (RAISE[ups[bringIn]] > 0.005) raisers.push({ up: ups[bringIn], p: RAISE[ups[bringIn]] });
  const rSum = raisers.reduce((a, b) => a + b.p, 0) || 1;
  for (const r of raisers) r.p /= rSum;

  return { pos, bringIn, behind, pAllFold, pCallOnly, pRaised, callers, raisers,
           potCall, potRaise, winFold };
}
