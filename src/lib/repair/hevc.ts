// Minimal HEVC (H.265) parameter-set / slice-header parsing: just enough to recognise frames
// and read their picture order count. HEVC repair always relies on a reference video for the
// decoder configuration (hvcC).

import { BitReader, unescapeRbsp } from "./bits";

export interface HevcParams {
  log2MaxPocLsb: number;
  separateColourPlane: boolean;
  dependentSliceSegments: boolean;
  outputFlagPresent: boolean;
  numExtraSliceHeaderBits: number;
}

function parseSps(nal: Uint8Array, p: HevcParams): boolean {
  const br = new BitReader(unescapeRbsp(nal, 2, nal.length, 512));
  br.bits(4);
  const maxSub = br.bits(3);
  br.bit();
  br.skip(96); // general profile_tier_level
  const present: number[] = [];
  for (let i = 0; i < maxSub; i++) present.push(br.bits(2));
  if (maxSub > 0) br.skip((8 - maxSub) * 2);
  for (const f of present) {
    if (f & 2) br.skip(88);
    if (f & 1) br.skip(8);
  }
  br.ue(); // sps_seq_parameter_set_id
  const chroma = br.ue();
  p.separateColourPlane = chroma === 3 && br.bit() === 1;
  br.ue();
  br.ue();
  if (br.bit()) {
    br.ue();
    br.ue();
    br.ue();
    br.ue();
  }
  br.ue();
  br.ue();
  p.log2MaxPocLsb = br.ue() + 4;
  return !br.overrun && p.log2MaxPocLsb <= 16;
}

function parsePps(nal: Uint8Array, p: HevcParams): boolean {
  const br = new BitReader(unescapeRbsp(nal, 2, nal.length, 64));
  br.ue();
  br.ue();
  p.dependentSliceSegments = br.bit() === 1;
  p.outputFlagPresent = br.bit() === 1;
  p.numExtraSliceHeaderBits = br.bits(3);
  return !br.overrun;
}

/** Read the parameters needed for slice parsing out of an hvcC payload. */
export function parseHvcC(hvcC: Uint8Array): HevcParams | null {
  if (hvcC.length < 23) return null;
  const p: HevcParams = {
    log2MaxPocLsb: 0,
    separateColourPlane: false,
    dependentSliceSegments: false,
    outputFlagPresent: false,
    numExtraSliceHeaderBits: 0,
  };
  let o = 22;
  const arrays = hvcC[o++];
  let gotSps = false;
  let gotPps = false;
  for (let a = 0; a < arrays && o + 3 <= hvcC.length; a++) {
    const type = hvcC[o] & 63;
    const count = (hvcC[o + 1] << 8) | hvcC[o + 2];
    o += 3;
    for (let i = 0; i < count && o + 2 <= hvcC.length; i++) {
      const len = (hvcC[o] << 8) | hvcC[o + 1];
      const nal = hvcC.subarray(o + 2, o + 2 + len);
      if (type === 33 && !gotSps) gotSps = parseSps(nal, p);
      if (type === 34 && !gotPps) gotPps = parsePps(nal, p);
      o += 2 + len;
    }
  }
  return gotSps && gotPps ? p : null;
}

export interface HevcSliceInfo {
  firstSlice: boolean;
  /** slice_pic_order_cnt_lsb (0 for IDR pictures). */
  pocLsb: number;
}

/** Parse the start of a slice segment header from the unescaped bytes after the 2-byte NAL header. */
export function parseHevcSlice(rbsp: Uint8Array, nalType: number, p: HevcParams | null): HevcSliceInfo | null {
  const br = new BitReader(rbsp);
  const firstSlice = br.bit() === 1;
  if (nalType >= 16 && nalType <= 23) br.bit();
  if (br.ue() > 63) return null; // slice_pic_parameter_set_id
  if (!firstSlice || !p) return br.overrun ? null : { firstSlice, pocLsb: -1 };
  br.skip(p.numExtraSliceHeaderBits);
  if (br.ue() > 2) return null; // slice_type
  if (p.outputFlagPresent) br.bit();
  if (p.separateColourPlane) br.bits(2);
  const pocLsb = nalType === 19 || nalType === 20 ? 0 : br.bits(p.log2MaxPocLsb);
  return br.overrun ? null : { firstSlice, pocLsb };
}
