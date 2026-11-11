// Minimal HEVC (H.265) parameter-set / slice-header parsing: just enough to recognise frames,
// read their picture order count, and build a decoder configuration (hvcC) from parameter sets
// that the stream carries itself.

import { BitReader, unescapeRbsp } from "./bits";

export interface HevcParams {
  log2MaxPocLsb: number;
  separateColourPlane: boolean;
  dependentSliceSegments: boolean;
  outputFlagPresent: boolean;
  numExtraSliceHeaderBits: number;
}

export interface HevcSpsInfo {
  width: number;
  height: number;
  chromaFormat: number;
  bitDepthLuma: number;
  bitDepthChroma: number;
  maxSubLayers: number;
  temporalIdNesting: boolean;
  /** general_profile_space .. general_level_idc, 12 bytes, as stored in hvcC. */
  ptl: Uint8Array;
}

function parseSps(nal: Uint8Array, p: HevcParams): HevcSpsInfo | null {
  const rbsp = unescapeRbsp(nal, 2, nal.length, 512);
  const br = new BitReader(rbsp);
  br.bits(4);
  const maxSub = br.bits(3);
  const nesting = br.bit() === 1;
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
  let width = br.ue();
  let height = br.ue();
  if (br.bit()) {
    const subW = chroma === 1 || chroma === 2 ? 2 : 1;
    const subH = chroma === 1 ? 2 : 1;
    width -= (br.ue() + br.ue()) * subW;
    height -= (br.ue() + br.ue()) * subH;
  }
  const bitDepthLuma = br.ue() + 8;
  const bitDepthChroma = br.ue() + 8;
  p.log2MaxPocLsb = br.ue() + 4;
  if (br.overrun || p.log2MaxPocLsb > 16 || chroma > 3 || width <= 0 || height <= 0 || width > 16384 || height > 16384) return null;
  return {
    width,
    height,
    chromaFormat: chroma,
    bitDepthLuma,
    bitDepthChroma,
    maxSubLayers: maxSub + 1,
    temporalIdNesting: nesting,
    ptl: rbsp.slice(1, 13),
  };
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
      if (type === 33 && !gotSps) gotSps = parseSps(nal, p) !== null;
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

function emptyParams(): HevcParams {
  return { log2MaxPocLsb: 0, separateColourPlane: false, dependentSliceSegments: false, outputFlagPresent: false, numExtraSliceHeaderBits: 0 };
}

export interface InBandConfig {
  /** hvcC payload. */
  hvcC: Uint8Array;
  params: HevcParams;
  sps: HevcSpsInfo;
}

/**
 * Build an hvcC from VPS / SPS / PPS NAL units found in the stream itself (many cameras and
 * dash cams repeat them in front of every key frame). Returns null if they do not parse.
 */
export function hvcCFromParameterSets(vps: Uint8Array, sps: Uint8Array, pps: Uint8Array): InBandConfig | null {
  const params = emptyParams();
  const info = parseSps(sps, params);
  if (!info || !parsePps(pps, params)) return null;
  const head = [
    1,
    ...info.ptl.subarray(0, 1),
    ...info.ptl.subarray(1, 5),
    ...info.ptl.subarray(5, 11),
    info.ptl[11],
    0xf0,
    0x00, // min_spatial_segmentation_idc
    0xfc, // parallelismType unknown
    0xfc | info.chromaFormat,
    0xf8 | (info.bitDepthLuma - 8),
    0xf8 | (info.bitDepthChroma - 8),
    0,
    0, // avgFrameRate
    ((info.maxSubLayers & 7) << 3) | ((info.temporalIdNesting ? 1 : 0) << 2) | 3,
    3,
  ];
  const arrays: number[] = [];
  for (const [type, nal] of [
    [32, vps],
    [33, sps],
    [34, pps],
  ] as const) {
    arrays.push(0x80 | type, 0, 1, nal.length >> 8, nal.length & 255, ...nal);
  }
  return { hvcC: Uint8Array.from([...head, ...arrays]), params, sps: info };
}
