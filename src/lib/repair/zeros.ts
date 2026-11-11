/**
 * Compressed video never contains long runs of zero bytes (the bitstream format escapes them),
 * so such a run means the block was never written: a failed read, a sparse download.
 */
export function hasZeroRun(buf: Uint8Array, from: number, to: number): boolean {
  const RUN = 32;
  for (let i = from + RUN - 1; i < to; i += RUN) {
    if (buf[i] !== 0) continue;
    let a = i;
    while (a > from && buf[a - 1] === 0) a--;
    let b = i + 1;
    while (b < to && buf[b] === 0) b++;
    if (b - a >= RUN) return true;
  }
  return false;
}
