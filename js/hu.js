// Loader for data/hu.bin — the heads-up 3rd-street equity matrix.
//
//   magic "RZHU" | version u16 | trials u32 | n_hands u16 | pad u16
//   data u16[455*455], seat 0's share x 65534, 0xFFFF = hands cannot coexist
//
// Keyed by *sorted rank triple*, so it is upcard-blind: A-2 with a king up and
// 2-K with an ace up are the same entry. That is exact under an all-in runout,
// which is what this measures, but it is why the realized solve cannot use it.

const HEADER = 14;

export class HuMatrix {
  constructor(buffer) {
    const dv = new DataView(buffer);
    const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    if (magic !== "RZHU") throw new Error("bad magic (not an RZHU matrix)");
    this.trials = dv.getUint32(6, true);
    this.n = dv.getUint16(10, true);
    const want = HEADER + this.n * this.n * 2;
    if (buffer.byteLength !== want)
      throw new Error(`size ${buffer.byteLength} != ${want}`);
    this.data = new Uint16Array(buffer, HEADER, this.n * this.n);
  }
  /** Seat 0's equity share, or null when the hands cannot coexist. */
  eq(a, b) {
    const v = this.data[a * this.n + b];
    return v === 0xffff ? null : v / 65534;
  }
}

export async function loadHu(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  onProgress?.(0.5);
  const buf = await res.arrayBuffer();
  onProgress?.(1);
  return new HuMatrix(buf);
}
