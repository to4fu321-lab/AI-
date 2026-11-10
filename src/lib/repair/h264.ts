// H.264 parameter-set and slice-header handling.
//
// The slice header is the only self-describing part of a frame once the MP4 index is gone, so it
// is used both to recognise frames in the raw data and to recover their display order.

import { BitReader, BitWriter, unescapeRbsp } from "./bits";

/** Everything from the SPS/PPS that changes how a slice header is laid out. */
export interface H264Params {
  log2MaxFrameNum: number;
  /** pic_order_cnt_type (0, 1 or 2). */
  pocType: number;
  log2MaxPocLsb: number;
  deltaPicOrderAlwaysZero: boolean;
  frameMbsOnly: boolean;
  separateColourPlane: boolean;
  chromaArrayType: number;
  /** entropy_coding_mode_flag; undefined while still unknown. */
  cabac: boolean | undefined;
  bottomFieldPicOrderPresent: boolean;
  redundantPicCntPresent: boolean;
  weightedPred: boolean;
  weightedBipredIdc: number;
  /** deblocking_filter_control_present_flag; undefined while still unknown. */
  deblockingControl: boolean | undefined;
  numRefIdxL0Default: number;
  numRefIdxL1Default: number;
}

export function defaultH264Params(): H264Params {
  return {
    log2MaxFrameNum: 4,
    pocType: 0,
    log2MaxPocLsb: 4,
    deltaPicOrderAlwaysZero: true,
    frameMbsOnly: true,
    separateColourPlane: false,
    chromaArrayType: 1,
    cabac: undefined,
    bottomFieldPicOrderPresent: false,
    redundantPicCntPresent: false,
    weightedPred: false,
    weightedBipredIdc: 0,
    deblockingControl: undefined,
    numRefIdxL0Default: 1,
    numRefIdxL1Default: 1,
  };
}

function skipScalingList(br: BitReader, size: number): void {
  let last = 8;
  let next = 8;
  for (let j = 0; j < size; j++) {
    if (next !== 0) next = (last + br.se() + 256) % 256;
    last = next === 0 ? last : next;
  }
}

/**
 * Parse an SPS NAL unit (including its one-byte header) into `p`.
 * Returns the cropped picture size, or null when the SPS is not usable.
 */
export function parseSps(nal: Uint8Array, p: H264Params): { width: number; height: number } | null {
  const rbsp = unescapeRbsp(nal, 1, nal.length, 512);
  const br = new BitReader(rbsp);
  const profile = br.bits(8);
  br.bits(16);
  br.ue(); // seq_parameter_set_id
  let chromaFormat = 1;
  p.separateColourPlane = false;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    chromaFormat = br.ue();
    if (chromaFormat === 3) p.separateColourPlane = br.bit() === 1;
    br.ue();
    br.ue();
    br.bit();
    if (br.bit()) {
      const lists = chromaFormat !== 3 ? 8 : 12;
      for (let i = 0; i < lists; i++) if (br.bit()) skipScalingList(br, i < 6 ? 16 : 64);
    }
  }
  p.chromaArrayType = p.separateColourPlane ? 0 : chromaFormat;
  p.log2MaxFrameNum = br.ue() + 4;
  p.pocType = br.ue();
  if (p.pocType === 0) {
    p.log2MaxPocLsb = br.ue() + 4;
  } else if (p.pocType === 1) {
    p.deltaPicOrderAlwaysZero = br.bit() === 1;
    br.se();
    br.se();
    const n = br.ue();
    for (let i = 0; i < n && !br.overrun; i++) br.se();
  }
  br.ue(); // max_num_ref_frames
  br.bit();
  const widthMbs = br.ue() + 1;
  const heightUnits = br.ue() + 1;
  p.frameMbsOnly = br.bit() === 1;
  if (!p.frameMbsOnly) br.bit();
  br.bit();
  const fields = p.frameMbsOnly ? 1 : 2;
  let width = widthMbs * 16;
  let height = heightUnits * 16 * fields;
  if (br.bit()) {
    const subX = chromaFormat === 1 || chromaFormat === 2 ? 2 : 1;
    const subY = (chromaFormat === 1 ? 2 : 1) * fields;
    width -= (br.ue() + br.ue()) * subX;
    height -= (br.ue() + br.ue()) * subY;
  }
  if (br.overrun || p.log2MaxFrameNum > 16 || p.pocType > 2 || width <= 0 || height <= 0) return null;
  return { width, height };
}

/** Parse a PPS NAL unit (including its one-byte header) into `p`. */
export function parsePps(nal: Uint8Array, p: H264Params): boolean {
  const rbsp = unescapeRbsp(nal, 1, nal.length, 256);
  const br = new BitReader(rbsp);
  br.ue();
  br.ue();
  p.cabac = br.bit() === 1;
  p.bottomFieldPicOrderPresent = br.bit() === 1;
  if (br.ue() !== 0) return false; // slice groups (FMO) are not supported
  p.numRefIdxL0Default = br.ue() + 1;
  p.numRefIdxL1Default = br.ue() + 1;
  p.weightedPred = br.bit() === 1;
  p.weightedBipredIdc = br.bits(2);
  br.se();
  br.se();
  br.se();
  p.deblockingControl = br.bit() === 1;
  br.bit();
  p.redundantPicCntPresent = br.bit() === 1;
  return !br.overrun;
}

export interface SliceInfo {
  firstMb: number;
  /** slice_type modulo 5: 0 = P, 1 = B, 2 = I. */
  sliceType: number;
  frameNum: number;
  /** pic_order_cnt_lsb, or -1 when the stream does not carry one. */
  pocLsb: number;
  /** True when the whole header parsed, including the CABAC alignment bits. */
  complete: boolean;
}

function skipRefListModification(br: BitReader): boolean {
  if (!br.bit()) return true;
  for (let i = 0; i < 66; i++) {
    const idc = br.ue();
    if (idc === 3) return true;
    if (idc > 3 || br.overrun) return false;
    br.ue();
  }
  return false;
}

function skipPredWeights(br: BitReader, count: number, chroma: boolean): void {
  for (let i = 0; i < count && !br.overrun; i++) {
    if (br.bit()) {
      br.se();
      br.se();
    }
    if (chroma && br.bit()) {
      br.se();
      br.se();
      br.se();
      br.se();
    }
  }
}

/**
 * Parse a slice header from the unescaped bytes that follow the NAL header byte.
 * Returns null when the bits cannot be a slice header under the given parameters.
 */
export function parseSliceHeader(rbsp: Uint8Array, nalType: number, refIdc: number, p: H264Params): SliceInfo | null {
  const br = new BitReader(rbsp);
  const firstMb = br.ue();
  const rawType = br.ue();
  if (rawType > 9) return null;
  const sliceType = rawType % 5;
  if (sliceType > 2) return null; // SP / SI slices
  if (nalType === 5 && sliceType !== 2) return null;
  if (br.ue() > 255) return null; // pic_parameter_set_id
  if (p.separateColourPlane) br.bits(2);
  const frameNum = br.bits(p.log2MaxFrameNum);
  let fieldPic = false;
  if (!p.frameMbsOnly) {
    fieldPic = br.bit() === 1;
    if (fieldPic) br.bit();
  }
  if (nalType === 5 && br.ue() > 65535) return null; // idr_pic_id
  let pocLsb = -1;
  if (p.pocType === 0) {
    pocLsb = br.bits(p.log2MaxPocLsb);
    if (p.bottomFieldPicOrderPresent && !fieldPic) br.se();
  } else if (p.pocType === 1 && !p.deltaPicOrderAlwaysZero) {
    br.se();
    if (p.bottomFieldPicOrderPresent && !fieldPic) br.se();
  }
  if (br.overrun) return null;
  const info: SliceInfo = { firstMb, sliceType, frameNum, pocLsb, complete: false };

  // The rest of the header is only used as a consistency check.
  if (p.redundantPicCntPresent) br.ue();
  if (sliceType === 1) br.bit(); // direct_spatial_mv_pred_flag
  let l0 = p.numRefIdxL0Default;
  let l1 = p.numRefIdxL1Default;
  if (sliceType !== 2) {
    if (br.bit()) {
      l0 = br.ue() + 1;
      if (sliceType === 1) l1 = br.ue() + 1;
      if (l0 > 32 || l1 > 32) return null;
    }
    if (!skipRefListModification(br)) return null;
    if (sliceType === 1 && !skipRefListModification(br)) return null;
    if ((p.weightedPred && sliceType === 0) || (p.weightedBipredIdc === 1 && sliceType === 1)) {
      const chroma = p.chromaArrayType !== 0;
      if (br.ue() > 7) return null;
      if (chroma && br.ue() > 7) return null;
      skipPredWeights(br, l0, chroma);
      if (sliceType === 1) skipPredWeights(br, l1, chroma);
    }
  }
  if (refIdc !== 0) {
    if (nalType === 5) {
      br.bits(2);
    } else if (br.bit()) {
      let done = false;
      for (let i = 0; i < 66 && !done; i++) {
        const op = br.ue();
        if (op > 6 || br.overrun) return null;
        if (op === 0) done = true;
        else if (op === 3) {
          br.ue();
          br.ue();
        } else if (op !== 5) br.ue();
      }
      if (!done) return null;
    }
  }
  if (p.cabac === undefined) return br.overrun ? null : info;
  if (p.cabac && sliceType !== 2 && br.ue() > 2) return null; // cabac_init_idc
  if (Math.abs(br.se()) > 51) return null; // slice_qp_delta
  if (p.deblockingControl === undefined) return br.overrun ? null : info;
  if (p.deblockingControl) {
    const idc = br.ue();
    if (idc > 2) return null;
    if (idc !== 1 && (Math.abs(br.se()) > 6 || Math.abs(br.se()) > 6)) return null;
  }
  if (p.cabac) {
    // cabac_alignment_one_bit up to the next byte boundary.
    while (br.pos & 7) if (br.bit() !== 1) return null;
    // The arithmetic decoder is initialised from the next 9 bits, which must be below 510.
    // This catches a header that was cut one byte short: the leftover byte is all ones.
    if (br.bitsLeft() >= 9 && br.bits(9) >= 510) return null;
  }
  if (br.overrun) return null;
  info.complete = true;
  return info;
}

/**
 * Check only the leading fields of a slice header, whose layout does not depend on the SPS/PPS.
 * Returns first_mb_in_slice, or -1 when the bits cannot start a slice.
 */
export function parseSliceStart(rbsp: Uint8Array, nalType: number): number {
  const br = new BitReader(rbsp);
  const firstMb = br.ue();
  const rawType = br.ue();
  if (rawType > 9 || rawType % 5 > 2) return -1;
  if (nalType === 5 && rawType % 5 !== 2) return -1;
  if (br.ue() > 3 || br.overrun) return -1;
  return firstMb;
}

export interface SpsOptions {
  profile: number;
  level: number;
  log2MaxFrameNum: number;
  pocType: number;
  log2MaxPocLsb: number;
  refFrames: number;
  widthMbs: number;
  heightMbs: number;
  /** Crop in luma pixels (must be even). */
  cropRight: number;
  cropBottom: number;
}

export function buildSps(o: SpsOptions): Uint8Array {
  const w = new BitWriter();
  w.u(8, o.profile);
  w.u(8, 0);
  w.u(8, o.level);
  w.ue(0);
  if (o.profile >= 100) {
    w.ue(1); // chroma_format_idc 4:2:0
    w.ue(0);
    w.ue(0);
    w.u(1, 0);
    w.u(1, 0);
  }
  w.ue(o.log2MaxFrameNum - 4);
  w.ue(o.pocType);
  if (o.pocType === 0) w.ue(o.log2MaxPocLsb - 4);
  w.ue(o.refFrames);
  w.u(1, 0);
  w.ue(o.widthMbs - 1);
  w.ue(o.heightMbs - 1);
  w.u(1, 1); // frame_mbs_only_flag
  w.u(1, 1); // direct_8x8_inference_flag
  if (o.cropRight || o.cropBottom) {
    w.u(1, 1);
    w.ue(0);
    w.ue(o.cropRight >> 1);
    w.ue(0);
    w.ue(o.cropBottom >> 1);
  } else {
    w.u(1, 0);
  }
  w.u(1, 0); // vui_parameters_present_flag
  const body = w.finishRbsp();
  const out = new Uint8Array(body.length + 1);
  out[0] = 0x67;
  out.set(body, 1);
  return out;
}

export interface PpsOptions {
  profile: number;
  cabac: boolean;
  numRefIdxL0Default: number;
  deblockingControl: boolean;
  transform8x8: boolean;
  weightedPred: boolean;
  weightedBipredIdc: number;
  /** pic_init_qp (26 unless the encoder is known to use something else). */
  picInitQp: number;
  chromaQpOffset: number;
}

export function buildPps(o: PpsOptions): Uint8Array {
  const w = new BitWriter();
  w.ue(0);
  w.ue(0);
  w.u(1, o.cabac ? 1 : 0);
  w.u(1, 0);
  w.ue(0);
  w.ue(o.numRefIdxL0Default - 1);
  w.ue(0);
  w.u(1, o.weightedPred ? 1 : 0);
  w.u(2, o.weightedBipredIdc);
  w.se(o.picInitQp - 26);
  w.se(0);
  w.se(o.chromaQpOffset);
  w.u(1, o.deblockingControl ? 1 : 0);
  w.u(1, 0);
  w.u(1, 0);
  if (o.profile >= 100) {
    w.u(1, o.transform8x8 ? 1 : 0);
    w.u(1, 0);
    w.se(o.chromaQpOffset);
  }
  const body = w.finishRbsp();
  const out = new Uint8Array(body.length + 1);
  out[0] = 0x68;
  out.set(body, 1);
  return out;
}

/** AVCDecoderConfigurationRecord (the payload of an avcC box). */
export function buildAvcC(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const high = sps[1] >= 100;
  const out = new Uint8Array(11 + sps.length + pps.length + (high ? 4 : 0));
  let o = 0;
  out[o++] = 1;
  out[o++] = sps[1];
  out[o++] = sps[2];
  out[o++] = sps[3];
  out[o++] = 0xff; // 4-byte NAL lengths
  out[o++] = 0xe1;
  out[o++] = sps.length >> 8;
  out[o++] = sps.length & 255;
  out.set(sps, o);
  o += sps.length;
  out[o++] = 1;
  out[o++] = pps.length >> 8;
  out[o++] = pps.length & 255;
  out.set(pps, o);
  o += pps.length;
  if (high) {
    out[o++] = 0xfd; // chroma_format 4:2:0
    out[o++] = 0xf8;
    out[o++] = 0xf8;
    out[o++] = 0;
  }
  return out;
}

/** Extract the first SPS and PPS from an avcC payload. */
export function readAvcC(avcC: Uint8Array): { sps: Uint8Array; pps: Uint8Array; lengthSize: number } | null {
  if (avcC.length < 8) return null;
  const lengthSize = (avcC[4] & 3) + 1;
  let o = 5;
  const nSps = avcC[o++] & 31;
  let sps: Uint8Array | null = null;
  for (let i = 0; i < nSps; i++) {
    const len = (avcC[o] << 8) | avcC[o + 1];
    if (!sps) sps = avcC.subarray(o + 2, o + 2 + len);
    o += 2 + len;
  }
  const nPps = avcC[o++];
  let pps: Uint8Array | null = null;
  for (let i = 0; i < nPps; i++) {
    const len = (avcC[o] << 8) | avcC[o + 1];
    if (!pps) pps = avcC.subarray(o + 2, o + 2 + len);
    o += 2 + len;
  }
  return sps && pps && o <= avcC.length ? { sps, pps, lengthSize } : null;
}
