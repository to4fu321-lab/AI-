// Bit-level reader/writer helpers shared by the H.264 / HEVC / AAC parsers.

export class BitReader {
  /** Absolute bit position inside `buf`. */
  pos: number;
  /** Set when a read ran past `end`; all later reads return 0. */
  overrun = false;
  private readonly endBit: number;

  constructor(
    private readonly buf: Uint8Array,
    start = 0,
    end = buf.length,
  ) {
    this.pos = start * 8;
    this.endBit = Math.min(end, buf.length) * 8;
  }

  bit(): number {
    if (this.pos >= this.endBit) {
      this.overrun = true;
      return 0;
    }
    const v = (this.buf[this.pos >> 3] >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return v;
  }

  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bit();
    return v;
  }

  skip(n: number): void {
    this.pos += n;
    if (this.pos > this.endBit) this.overrun = true;
  }

  /** Exp-Golomb unsigned. */
  ue(): number {
    let zeros = 0;
    while (this.bit() === 0) {
      if (this.overrun || ++zeros > 31) {
        this.overrun = true;
        return 0;
      }
    }
    return zeros === 0 ? 0 : 2 ** zeros - 1 + this.bits(zeros);
  }

  /** Exp-Golomb signed. */
  se(): number {
    const k = this.ue();
    return k & 1 ? (k + 1) / 2 : -(k / 2);
  }

  alignByte(): void {
    this.pos = (this.pos + 7) & ~7;
  }

  bitsLeft(): number {
    return this.endBit - this.pos;
  }
}

export class BitWriter {
  private readonly out: number[] = [];
  private cur = 0;
  private n = 0;

  u(n: number, v: number): void {
    for (let i = n - 1; i >= 0; i--) {
      this.cur = (this.cur << 1) | (Math.floor(v / 2 ** i) & 1);
      if (++this.n === 8) {
        this.out.push(this.cur);
        this.cur = 0;
        this.n = 0;
      }
    }
  }

  ue(v: number): void {
    const x = v + 1;
    const len = Math.floor(Math.log2(x)) + 1;
    this.u(len - 1, 0);
    this.u(len, x);
  }

  se(v: number): void {
    this.ue(v > 0 ? 2 * v - 1 : -2 * v);
  }

  /** Append rbsp_trailing_bits and return the bytes with emulation prevention applied. */
  finishRbsp(): Uint8Array {
    this.u(1, 1);
    while (this.n !== 0) this.u(1, 0);
    const res: number[] = [];
    let zeros = 0;
    for (const b of this.out) {
      if (zeros >= 2 && b <= 3) {
        res.push(3);
        zeros = 0;
      }
      res.push(b);
      zeros = b === 0 ? zeros + 1 : 0;
    }
    return Uint8Array.from(res);
  }
}

/** Strip H.264/HEVC emulation prevention bytes (00 00 03) from up to `maxOut` output bytes. */
export function unescapeRbsp(buf: Uint8Array, start: number, end: number, maxOut: number): Uint8Array {
  const out = new Uint8Array(Math.min(maxOut, Math.max(0, end - start)));
  let o = 0;
  let zeros = 0;
  for (let i = start; i < end && o < out.length; i++) {
    const b = buf[i];
    if (zeros >= 2 && b === 3) {
      zeros = 0;
      continue;
    }
    out[o++] = b;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return o === out.length ? out : out.subarray(0, o);
}
