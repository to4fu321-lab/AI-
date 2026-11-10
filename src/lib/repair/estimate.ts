// Recovers H.264 decoder parameters (SPS / PPS) when no reference video is available.
//
// The lost avcC is rebuilt in two steps:
//   1. Slice headers are analysed statistically. Fields such as frame_num must count up in a
//      known way and CABAC headers must end in alignment bits, which pins down the bit layout.
//   2. What cannot be derived from headers (picture size, 8x8 transform, ...) is found by trial
//      decoding one key frame and checking how much of it decodes into a coherent picture.

import { BitReader } from "./bits";
import { buildPps, buildSps, defaultH264Params, parseSliceHeader, type H264Params } from "./h264";
import type { SliceHead } from "./scan";

/** Decoder used for trial decoding (ffmpeg compiled to WebAssembly in the browser). */
export interface Prober {
  /**
   * Decode an Annex-B stream without error concealment and return output frame `frame` as
   * planar YUV 4:2:0 (null when the decoder produced fewer frames). Undecoded areas must come
   * back as zeros.
   */
  decodeYuv(annexB: Uint8Array, width: number, height: number, frame: number): Promise<{ data: Uint8Array; errors: boolean } | null>;
}

/** Encoder settings x264 embeds as text in the first frame. */
export interface X264Hints {
  cabac?: boolean;
  transform8x8?: boolean;
  refs?: number;
  weightedPred?: boolean;
  weightedBipred?: boolean;
  chromaQpOffset?: number;
  picInitQp?: number;
}

export function parseX264Options(text: string): X264Hints | null {
  const at = text.indexOf("options:");
  if (!text.includes("x264") || at < 0) return null;
  const opt = new Map<string, string>();
  for (const kv of text.slice(at + 8).trim().split(/\s+/)) {
    const eq = kv.indexOf("=");
    if (eq > 0) opt.set(kv.slice(0, eq), kv.slice(eq + 1));
  }
  const num = (k: string) => (opt.has(k) && Number.isFinite(Number(opt.get(k))) ? Number(opt.get(k)) : undefined);
  const flag = (k: string) => (opt.has(k) ? Number(opt.get(k)) > 0 : undefined);
  const h: X264Hints = {
    cabac: flag("cabac"),
    transform8x8: flag("8x8dct"),
    refs: num("ref"),
    weightedPred: flag("weightp"),
    weightedBipred: flag("weightb"),
    chromaQpOffset: num("chroma_qp_offset"),
  };
  // x264 writes pic_init_qp = 26 for bitrate-based rate control and the constant QP / CRF value otherwise.
  const rc = opt.get("rc");
  if (rc === "crf" && num("crf") !== undefined) h.picInitQp = Math.floor(num("crf")!);
  else if (rc === "cqp" && num("qp") !== undefined) h.picInitQp = num("qp");
  else if (rc) h.picInitQp = 26;
  if (h.picInitQp !== undefined) h.picInitQp = Math.max(0, Math.min(51, h.picInitQp));
  return h;
}

export interface LayoutGuess {
  params: H264Params;
  /** False when the header statistics matched no CABAC layout (stream is treated as CAVLC). */
  cabacConfirmed: boolean;
  hasBFrames: boolean;
  /** Values of num_ref_idx_l0_default_active the slice headers are consistent with. */
  l0Candidates: number[];
}

/** Step 1: derive the slice-header bit layout from the first slices of many pictures. */
export function analyzeHeads(heads: SliceHead[], hints: X264Hints | null): LayoutGuess | null {
  if (heads.length < 8) return null;
  const hasBFrames = heads.some((h) => {
    const br = new BitReader(h.head);
    br.ue();
    return br.ue() % 5 === 1;
  });

  // frame_num: 0 on IDR pictures, otherwise previous reference frame_num + 1.
  let bestFn = 0;
  let bestFnScore = -1;
  for (let bits = 4; bits <= 16; bits++) {
    let prevRef = 0;
    let ok = 0;
    for (const h of heads) {
      const br = new BitReader(h.head);
      br.ue();
      br.ue();
      br.ue();
      const fn = br.bits(bits);
      if (h.nalType === 5) {
        if (fn === 0) ok++;
        prevRef = 0;
      } else {
        if (fn === (prevRef + 1) % 2 ** bits) ok++;
        if (h.refIdc) prevRef = fn;
      }
    }
    if (ok > bestFnScore) {
      bestFnScore = ok;
      bestFn = bits;
    }
  }
  if (bestFnScore / heads.length < 0.8) return null;

  const base = defaultH264Params();
  base.log2MaxFrameNum = bestFn;

  // Picture order count layouts to try: type 2 (no bits) or type 0 with 4..16 lsb bits.
  const pocLayouts: [number, number][] = [[2, 0]];
  for (let bits = 4; bits <= 16; bits++) pocLayouts.push([0, bits]);

  // CABAC streams: the right layout is the one where every header runs cleanly into its
  // alignment bits. When layouts tie, the first one tried wins, so the order matters:
  //  - "deblocking fields present" goes first. If they are really absent, that layout breaks on
  //    every slice whose header ends near a byte boundary, so a perfect score means present.
  //    The reverse does not hold: all-default deblocking fields look exactly like alignment bits.
  //  - unweighted prediction goes before weighted (explicit weights are rare outside x264).
  let best: H264Params | null = null;
  let bestOk = 0;
  const okByL0 = new Map<number, number>();
  const count = (p: H264Params) => {
    let ok = 0;
    for (const h of heads) if (parseSliceHeader(h.head, h.nalType, h.refIdc, p)?.complete) ok++;
    return ok;
  };
  for (const weighted of [0, 1, 2, 3, 4]) {
    for (const deblock of [true, false]) {
      for (const [pocType, pocBits] of pocLayouts) {
        const p: H264Params = {
          ...base,
          pocType,
          log2MaxPocLsb: pocBits,
          cabac: true,
          deblockingControl: deblock,
          weightedPred: weighted > 0,
          numRefIdxL0Default: Math.max(1, weighted),
        };
        const ok = count(p);
        if (ok > bestOk) {
          bestOk = ok;
          best = p;
        }
      }
    }
  }
  if (best && bestOk / heads.length >= 0.97 && hints?.cabac !== false) {
    let l0Candidates = [1, 2, 3, 4];
    if (best.weightedPred) {
      // The weight table length depends on the default reference count unless a slice overrides it.
      for (const l0 of l0Candidates) okByL0.set(l0, count({ ...best, numRefIdxL0Default: l0 }));
      l0Candidates = l0Candidates.filter((l0) => okByL0.get(l0) === bestOk);
    }
    if (best.weightedPred || hints?.weightedBipred) best.weightedBipredIdc = hints?.weightedBipred === false ? 0 : 2;
    return { params: best, cabacConfirmed: true, hasBFrames, l0Candidates };
  }

  // CAVLC streams have no alignment bits to check. Pick the picture-order layout whose values
  // look like a display order: unique inside a GOP, even, and close to the decode position.
  let bestPoc: [number, number] = [2, 0];
  let bestPocScore = 0.9;
  for (const [pocType, pocBits] of pocLayouts) {
    if (pocType !== 0) continue;
    const p: H264Params = { ...base, pocType, log2MaxPocLsb: pocBits };
    let ok = 0;
    let index = 0;
    let seen = new Set<number>();
    let prev = 0;
    for (const h of heads) {
      const s = parseSliceHeader(h.head, h.nalType, h.refIdc, p);
      if (!s) continue;
      if (h.nalType === 5) {
        index = 0;
        seen = new Set();
        prev = 0;
        if (s.pocLsb === 0) ok++;
        seen.add(0);
        continue;
      }
      index++;
      const max = 2 ** pocBits;
      let poc = prev - (prev % max) + s.pocLsb;
      if (poc - prev > max / 2) poc -= max;
      else if (prev - poc > max / 2) poc += max;
      prev = poc;
      if (!seen.has(poc) && poc % 2 === 0 && poc > 0 && poc <= 2 * (index + 17)) ok++;
      seen.add(poc);
    }
    const score = ok / heads.length;
    if (score >= bestPocScore) {
      bestPocScore = score;
      bestPoc = [pocType, pocBits];
    }
  }
  return {
    params: { ...base, pocType: bestPoc[0], log2MaxPocLsb: bestPoc[1], cabac: undefined, deblockingControl: undefined },
    cabacConfirmed: false,
    hasBFrames,
    l0Candidates: [1, 2, 3, 4],
  };
}

/**
 * Picture widths (in pixels) worth trying first. Nothing wider than 4096: larger pictures are
 * practically never H.264 and exhaust the in-browser decoder's memory.
 */
const COMMON_WIDTHS = [
  1920, 1280, 3840, 1080, 720, 2160, 640, 480, 854, 960, 1440, 360, 540, 320, 352, 426, 270, 240, 1024, 800, 600, 576, 768,
  2560, 2704, 4096, 2048, 1600, 1366, 864, 180, 144, 176, 608, 406, 450, 568, 1136, 750, 1334, 886, 888, 1170, 828, 1242,
  1284, 1179, 1290, 1206, 1125, 1320, 1152, 1792, 2880, 3200,
];

interface Quality {
  /** Macroblocks the decoder actually produced. */
  decoded: number;
  /** Macroblock rows containing decoded data. */
  rows: number;
  /** Mean luma step across macroblock edges; low for a coherent picture. */
  edge: number;
}

function measure(yuv: Uint8Array, widthMbs: number, heightMbs: number): Quality {
  const w = widthMbs * 16;
  // Decoded picture area has chroma around 128 even where it is black; memory the decoder never
  // wrote stays 0. So the chroma plane tells which macroblocks were really decoded.
  const chroma = w * heightMbs * 16;
  const cw = w / 2;
  let decoded = 0;
  let rows = 0;
  for (let my = 0; my < heightMbs; my++) {
    for (let mx = 0; mx < widthMbs; mx++) {
      const at = chroma + my * 8 * cw + mx * 8;
      if (yuv[at] | yuv[at + 3 * cw + 5] | yuv[at + 7 * cw + 7] | yuv[at + 5 * cw + 2]) {
        decoded++;
        rows = my + 1;
      }
    }
  }
  if (rows === 0) return { decoded: 0, rows: 0, edge: 255 };
  let sum = 0;
  let n = 0;
  for (let y = 0; y < rows * 16; y++) {
    const line = y * w;
    for (let x = 16; x < w; x += 16) {
      sum += Math.abs(yuv[line + x] - yuv[line + x - 1]);
      n++;
    }
  }
  for (let y = 16; y < rows * 16; y += 16) {
    const line = y * w;
    for (let x = 0; x < w; x += 2) {
      sum += Math.abs(yuv[line + x] - yuv[line + x - w]);
      n++;
    }
  }
  return { decoded, rows, edge: n ? sum / n : 255 };
}

function annexB(...nals: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(nals.reduce((n, x) => n + x.length + 4, 0));
  let o = 0;
  for (const nal of nals) {
    out[o + 3] = 1;
    out.set(nal, o + 4);
    o += nal.length + 4;
  }
  return out;
}

/** Convert length-prefixed samples to Annex-B start codes (same size, new buffer). */
export function samplesToAnnexB(samples: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(samples.reduce((n, s) => n + s.length, 0));
  let o = 0;
  for (const s of samples) {
    out.set(s, o);
    let p = 0;
    while (p + 4 <= s.length) {
      const len = ((s[p] << 24) | (s[p + 1] << 16) | (s[p + 2] << 8) | s[p + 3]) >>> 0;
      out[o + p] = 0;
      out[o + p + 1] = 0;
      out[o + p + 2] = 0;
      out[o + p + 3] = 1;
      p += 4 + len;
    }
    o += s.length;
  }
  return out;
}

const LEVELS: [number, number][] = [
  [30, 8100],
  [31, 18000],
  [40, 32768],
  [50, 110400],
  [51, 184320],
  [62, 696320],
];

/** Trim the padding that rounds a picture up to whole macroblocks, for well-known aspect ratios. */
function cropFor(widthMbs: number, heightMbs: number): { width: number; height: number } {
  const W = widthMbs * 16;
  const H = heightMbs * 16;
  const even = (v: number) => Math.round(v / 2) * 2;
  for (const ratio of [16 / 9, 4 / 3, 1, 3 / 4, 9 / 16]) {
    const h = even(W / ratio);
    if (h > H - 16 && h <= H) return { width: W, height: h };
    const w = even(H * ratio);
    if (w > W - 16 && w <= W) return { width: w, height: H };
  }
  return { width: W, height: H };
}

export interface EstimateResult {
  sps: Uint8Array;
  pps: Uint8Array;
  params: H264Params;
  width: number;
  height: number;
}

export interface EstimateInput {
  layout: LayoutGuess;
  hints: X264Hints | null;
  /** Length-prefixed samples in decode order, starting with a key frame. */
  samples: Uint8Array[];
  prober: Prober;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/** Step 2: find the picture size and remaining PPS flags by trial decoding. */
export async function estimateParameters(input: EstimateInput): Promise<EstimateResult | null> {
  const { layout, hints, samples, prober } = input;
  const key = samplesToAnnexB([samples[0]]);
  const gop = samplesToAnnexB(samples);
  // x264 is the one common encoder that uses explicit weighted prediction; its default
  // chroma QP offset is -2. Use that when the settings text itself is missing.
  const chromaQpOffset = hints?.chromaQpOffset ?? (layout.params.weightedPred ? -2 : 0);

  const make = (
    widthMbs: number,
    heightMbs: number,
    v: { cabac: boolean; deblock: boolean; t8: boolean; l0: number },
    crop = { right: 0, bottom: 0 },
  ) => {
    const profile = v.t8 ? 100 : v.cabac || layout.hasBFrames || layout.params.weightedPred ? 77 : 66;
    const refFrames = Math.min(16, Math.max(4, hints?.refs ?? 0, v.l0));
    const level = (LEVELS.find(([, dpb]) => widthMbs * heightMbs * refFrames <= dpb) ?? LEVELS[LEVELS.length - 1])[0];
    const sps = buildSps({
      profile,
      level,
      log2MaxFrameNum: layout.params.log2MaxFrameNum,
      pocType: layout.params.pocType,
      log2MaxPocLsb: layout.params.log2MaxPocLsb,
      refFrames,
      widthMbs,
      heightMbs,
      cropRight: crop.right,
      cropBottom: crop.bottom,
    });
    const pps = buildPps({
      profile,
      cabac: v.cabac,
      numRefIdxL0Default: v.l0,
      deblockingControl: v.deblock,
      transform8x8: v.t8,
      weightedPred: layout.params.weightedPred,
      weightedBipredIdc: layout.params.weightedBipredIdc,
      picInitQp: hints?.picInitQp ?? 26,
      chromaQpOffset,
    });
    return { sps, pps };
  };

  // Entropy coding / deblocking flags still to be decided by decoding.
  const flagSets: { cabac: boolean; deblock: boolean }[] = layout.cabacConfirmed
    ? [{ cabac: true, deblock: layout.params.deblockingControl === true }]
    : [
        { cabac: false, deblock: true },
        { cabac: false, deblock: false },
        ...(hints?.cabac === false
          ? []
          : [
              { cabac: true, deblock: true },
              { cabac: true, deblock: false },
            ]),
      ];
  const t8Options = hints?.transform8x8 !== undefined ? [hints.transform8x8] : [true, false];
  type Variant = { cabac: boolean; deblock: boolean; t8: boolean; l0: number };
  const variants: Variant[] = [];
  for (const f of flagSets) for (const t8 of t8Options) variants.push({ ...f, t8, l0: layout.l0Candidates[0] ?? 1 });

  const common = [...new Set(COMMON_WIDTHS.map((w) => Math.ceil(w / 16)))];
  const rest: number[] = [];
  for (let w = 2; w <= 256; w++) if (!common.includes(w)) rest.push(w);
  // Trial pictures are kept small (about the area of a 1080p frame) so that decoding stays
  // within a phone's memory. A picture taller than the trial is simply cut off, which still
  // decodes cleanly; the real height is measured afterwards.
  const trialHeight = (widthMbs: number) => Math.max(8, Math.min(Math.ceil(widthMbs * 2.4), Math.floor(9000 / widthMbs)));

  interface Hit {
    widthMbs: number;
    variant: Variant;
    q: Quality;
    score: number;
  }
  let best: Hit | null = null;
  let runnerUp = 0;
  const hits: Hit[] = [];
  const tryWidths = async (widths: number[], from: number, to: number) => {
    let done = 0;
    for (const widthMbs of widths) {
      for (const variant of variants) {
        if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const heightMbs = trialHeight(widthMbs);
        const { sps, pps } = make(widthMbs, heightMbs, variant);
        const stream = new Uint8Array(sps.length + pps.length + 8 + key.length);
        stream.set(annexB(sps, pps));
        stream.set(key, sps.length + pps.length + 8);
        const out = await prober.decodeYuv(stream, widthMbs * 16, heightMbs * 16, 0);
        if (out && out.data.length >= widthMbs * heightMbs * 384) {
          const q = measure(out.data, widthMbs, heightMbs);
          // A correct guess decodes the whole picture without complaint; wrong ones break off
          // after a few rows or trip decoder errors.
          const hit: Hit = { widthMbs, variant, q, score: q.decoded * (out.errors ? 0.25 : 1) };
          hits.push(hit);
          if (!best || hit.score > best.score || (hit.score === best.score && q.edge < best.q.edge)) {
            if (best && best.widthMbs !== widthMbs) runnerUp = Math.max(runnerUp, best.score);
            best = hit;
          } else if (best.widthMbs !== widthMbs) {
            runnerUp = Math.max(runnerUp, hit.score);
          }
        }
      }
      input.onProgress?.(from + ((to - from) * ++done) / widths.length);
    }
  };

  const convincing = () => best !== null && best.q.rows >= 4 && best.score >= 3 * runnerUp;
  await tryWidths(common, 0, 0.4);
  if (!convincing()) await tryWidths(rest, 0.4, 0.9);
  const found = best as Hit | null;
  if (!found || found.q.rows < 2) return null;

  const widthMbs = found.widthMbs;
  // Measure the height: decode the key frame into a picture that is certainly tall enough.
  let heightMbs = found.q.rows;
  if (heightMbs >= trialHeight(widthMbs)) {
    for (const tall of [Math.ceil(widthMbs * 0.8), Math.ceil(widthMbs * 2.4)]) {
      if (tall <= heightMbs) continue;
      const { sps, pps } = make(widthMbs, tall, found.variant);
      const stream = new Uint8Array(sps.length + pps.length + 8 + key.length);
      stream.set(annexB(sps, pps));
      stream.set(key, sps.length + pps.length + 8);
      const out = await prober.decodeYuv(stream, widthMbs * 16, tall * 16, 0);
      if (!out) break;
      heightMbs = measure(out.data, widthMbs, tall).rows;
      if (heightMbs < tall) break;
    }
  }
  let variant = { ...found.variant };

  // The key frame alone cannot settle everything: the default reference count only matters in
  // P/B slices, and some streams never use the 8x8 transform in key frames. Decode the frames
  // that follow and keep the settings that produce a complete, error-free picture.
  if (samples.length >= 2) {
    const open = hits.filter((h) => h.widthMbs === widthMbs && h.score >= found.score * 0.98).map((h) => h.variant);
    const frame = samples.length - 1;
    interface Trial {
      variant: Variant;
      errors: boolean;
      decoded: number;
      hash: number;
    }
    const trials: Trial[] = [];
    const l0s = [...layout.l0Candidates, 16];
    let done = 0;
    for (const v of open) {
      for (const l0 of l0s) {
        if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const { sps, pps } = make(widthMbs, heightMbs, { ...v, l0 });
        const stream = new Uint8Array(sps.length + pps.length + 8 + gop.length);
        stream.set(annexB(sps, pps));
        stream.set(gop, sps.length + pps.length + 8);
        const out = await prober.decodeYuv(stream, widthMbs * 16, heightMbs * 16, frame);
        input.onProgress?.(0.9 + (0.1 * ++done) / (open.length * l0s.length));
        if (!out) continue;
        let hash = 2166136261;
        for (let i = 0; i < out.data.length; i += 5) hash = Math.imul(hash ^ out.data[i], 16777619);
        trials.push({ variant: { ...v, l0 }, errors: out.errors, decoded: measure(out.data, widthMbs, heightMbs).decoded, hash });
      }
    }
    const rank = (t: Trial) => (t.errors ? 0 : 1) * 1e9 + t.decoded;
    const top = Math.max(...trials.map(rank));
    const good = trials.filter((t) => rank(t) === top);
    if (good.length) {
      // Prefer the variant that did best on the key frame.
      const first = open.find((v) => good.some((t) => t.variant.t8 === v.t8 && t.variant.cabac === v.cabac && t.variant.deblock === v.deblock))!;
      let same = good.filter((t) => t.variant.t8 === first.t8 && t.variant.cabac === first.cabac && t.variant.deblock === first.deblock);
      if (first.cabac) {
        // With CABAC a default count that is too large is harmless, one that is too small
        // scrambles the picture. Whatever decodes exactly like the largest count is safe.
        const reference = same.find((t) => t.variant.l0 === 16);
        if (reference) same = same.filter((t) => t.hash === reference.hash);
      }
      const usable = same.filter((t) => t.variant.l0 !== 16);
      const pick = usable.find((t) => t.variant.l0 === hints?.refs) ?? usable[0] ?? same[0];
      variant = { ...pick.variant, l0: Math.min(pick.variant.l0, 16) };
    }
  }
  input.onProgress?.(1);

  const size = cropFor(widthMbs, heightMbs);
  const { sps, pps } = make(widthMbs, heightMbs, variant, {
    right: widthMbs * 16 - size.width,
    bottom: heightMbs * 16 - size.height,
  });
  const params: H264Params = {
    ...layout.params,
    cabac: variant.cabac,
    deblockingControl: variant.deblock,
    numRefIdxL0Default: variant.l0,
  };
  return { sps, pps, params, width: size.width, height: size.height };
}
