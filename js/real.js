// Loader for the realised-value tables produced by engine/razz-realtab.
//
//   magic "RZRT" | ver u8 | lookahead u8 | trials u32 | nStates u16 | pad
//   ok u8[n*n]
//   ver 1:  S i16[n*n], M i16[n*n]                    — one pot-independent pass
//   ver 2:  (S,M) for the called pot, then for the raised pot
//
// Version 2 exists because pot-odds calling prices each decision against the
// pot, so the result depends on how big the 3rd-street pot was. That breaks the
// pot-independent decomposition version 1 relied on, and each branch needs its
// own pass.
//
// A state is (upcard, downcard pair): 13 x 91 = 1183 per side. Unlike hu.bin
// this is not upcard-blind, which is the point — which card is face up decides
// who bets on later streets.

const HEADER = 16;
export const BRANCH_CALL = 0, BRANCH_RAISE = 1;

export class RealTable {
  constructor(buffer) {
    const dv = new DataView(buffer);
    const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    if (magic !== "RZRT") throw new Error("bad magic (not an RZRT table)");
    this.version = dv.getUint8(4);
    this.lookahead = dv.getUint8(5);
    this.trials = dv.getUint32(6, true);
    this.n = dv.getUint16(10, true);
    const cells = this.n * this.n;
    this.branches = this.version >= 2 ? 2 : 1;
    const want = HEADER + cells + 4 * cells * this.branches;
    if (buffer.byteLength !== want) throw new Error(`size ${buffer.byteLength} != ${want}`);

    // n*n is odd (1183^2 = 1,399,489), so the int16 sections do not begin on an
    // even byte offset and cannot be viewed in place — slice to copy instead.
    this.ok = new Uint8Array(buffer, HEADER, cells);
    this.S = [];
    this.M = [];
    let off = HEADER + cells;
    for (let b = 0; b < this.branches; b++) {
      this.S.push(new Int16Array(buffer.slice(off, off + 2 * cells)));
      off += 2 * cells;
      this.M.push(new Int16Array(buffer.slice(off, off + 2 * cells)));
      off += 2 * cells;
    }
  }

  state(up, downIdx) { return up * 91 + downIdx; }

  /**
   * Hero's expected net in cents.
   * @param branch BRANCH_CALL or BRANCH_RAISE; ignored by version 1, which is
   *               pot-independent and so serves both from one pass
   */
  net(h, v, H, D, branch = BRANCH_CALL) {
    const k = h * this.n + v;
    if (!this.ok[k]) return null;
    const b = Math.min(branch, this.branches - 1);
    const s = this.S[b][k] / 10000;
    return H * s + this.M[b][k] + (D * (s + 1)) / 2;
  }
}

export async function loadReal(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const total = Number(res.headers.get("Content-Length")) || 0;
  if (!res.body) return new RealTable(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress?.(total ? got / total : null);
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return new RealTable(out.buffer);
}
