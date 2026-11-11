// Repairs MP4 / MOV files that lost their moov index (interrupted recording, failed transfer,
// truncated download): the frames are located in the raw data and a new index is written.
//
// Nothing is re-encoded and the media data is never copied in memory: the result is a Blob made
// of a small new header plus a slice of the original file, so multi-gigabyte files work on a phone.

import { AAC_SAMPLE_RATES, parseAacFrame } from "./aac";
import { analyzeHeads, estimateParameters, parseX264Options, type Prober } from "./estimate";
import { buildAvcC, defaultH264Params, parsePps, parseSps, readAvcC, type H264Params } from "./h264";
import { hvcCFromParameterSets, parseHvcC, type HevcParams } from "./hevc";
import { repairFromIndex, type TrackReport } from "./indexRepair";
import {
  buildAacEntry,
  buildAvc1Entry,
  buildHeader,
  buildHvc1Entry,
  findMoov,
  listTopBoxes,
  parseReference,
  referenceFromMoov,
  rotationMatrix,
  type OutTrack,
  type Reference,
  type TopBox,
  type VideoCodec,
} from "./mp4";
import { scanMedia, type ScanResult } from "./scan";

export type { Prober } from "./estimate";

export type RepairErrorCode =
  | "REFERENCE_INVALID"
  | "REFERENCE_UNSUPPORTED"
  | "NO_VIDEO_FOUND"
  | "HEVC_NEEDS_REFERENCE"
  | "ESTIMATE_FAILED"
  | "PROBER_UNAVAILABLE"
  | "EMPTY_FILE"
  | "ZERO_FILLED"
  | "NOT_MP4";

export class RepairError extends Error {
  constructor(
    readonly code: RepairErrorCode,
    /** Extra information for the message, e.g. the container format that was recognised. */
    readonly detail: string | null = null,
  ) {
    super(code);
  }
  /** What was found in the file, for the user to pass on when asking for help. */
  facts: Record<string, string | number> = {};
}

/** What turned out to be wrong with the file. */
export type DamageCause =
  /** The index (moov) was never written: recording or saving was interrupted. */
  | "missing_index"
  /** The index is there but unreadable. */
  | "damaged_index"
  /** The file ends early: an incomplete download, copy or transfer. */
  | "truncated"
  /** Parts of the media data were overwritten (zeros, garbage) or frames are missing inside. */
  | "corrupt_data"
  /** The start of the file (ftyp / headers) is damaged. */
  | "damaged_header"
  /** Bytes were lost or added in front of the media data, so the index pointed to the wrong places. */
  | "shifted_data"
  /** Nothing structurally wrong was found. */
  | "healthy";

export interface Diagnosis {
  causes: DamageCause[];
  /** How the file was rebuilt: from its own index, or by scanning the raw data for frames. */
  method: "index" | "scan";
  /** Frames listed in the index (index method only). */
  videoTotal: number;
  /** Frames that had to be left out: lost, overwritten, or depending on a lost frame. */
  videoDropped: number;
  audioDropped: number;
  /** Share of the indexed video that lies beyond the end of the file (0..1). */
  missingFraction: number;
  /** Fourcc of the video / audio formats found in the index. */
  videoFormat: string | null;
  audioFormat: string | null;
}

export type RepairStage = "inspect" | "sample" | "estimate" | "scan" | "write";

export interface RepairOptions {
  /** Healthy video recorded with the same camera / app and settings. */
  reference?: Blob | null;
  /** Trial decoder; required when no reference is given. */
  prober?: () => Promise<Prober>;
  /** Clockwise rotation override in degrees (0 / 90 / 180 / 270). */
  rotation?: number | null;
  onProgress?: (stage: RepairStage, fraction: number) => void;
  signal?: AbortSignal;
}

export interface RepairResult {
  blob: Blob;
  /** Fourcc of the video format (avc1, hvc1 ...). */
  codec: string;
  width: number;
  height: number;
  fps: number;
  videoFrames: number;
  audioFrames: number;
  durationSeconds: number;
  /** Bytes at the end of the file that could not be attributed to a complete frame. */
  discardedBytes: number;
  /** True when the decoder settings were estimated rather than taken from a reference. */
  estimated: boolean;
  hadMoov: boolean;
  /** Fourcc of an audio format that could not be recovered. */
  unsupportedAudio: string | null;
  diagnosis: Diagnosis;
}

/** Recognise other container formats by their first bytes. */
function sniffOtherFormat(h: Uint8Array): string | null {
  const ascii = (o: number, n: number) => String.fromCharCode(...h.subarray(o, o + n));
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "AVI ") return "AVI";
  if (h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3) return "MKV / WebM";
  if (h.length > 400 && h[0] === 0x47 && h[188] === 0x47 && h[376] === 0x47) return "MPEG-TS（.ts / .mts）";
  if (h.length > 400 && h[4] === 0x47 && h[196] === 0x47 && h[388] === 0x47) return "AVCHD（.m2ts / .mts）";
  if (h[0] === 0 && h[1] === 0 && h[2] === 1 && (h[3] === 0xba || h[3] === 0xb3)) return "MPEG（.mpg / .vob）";
  if (ascii(0, 3) === "FLV") return "FLV";
  if (h[0] === 0x30 && h[1] === 0x26 && h[2] === 0xb2 && h[3] === 0x75) return "WMV / ASF";
  if (ascii(0, 4) === "OggS") return "Ogg";
  if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return "JPEG";
  if (h[0] === 0x89 && ascii(1, 3) === "PNG") return "PNG";
  if (ascii(0, 4) === "PK\x03\x04") return "ZIP";
  if (ascii(0, 4) === "%PDF") return "PDF";
  if (ascii(4, 4) === "ftyp" && ["heic", "heix", "mif1", "avif"].includes(ascii(8, 4))) return "HEIC / AVIF";
  return null;
}

/** Fraction of the file that is zero bytes, from samples spread over its length. */
async function zeroFraction(file: Blob): Promise<number> {
  const points = 24;
  const size = 4096;
  let zeros = 0;
  let total = 0;
  for (let i = 0; i < points; i++) {
    const at = Math.floor(((file.size - size) * i) / (points - 1));
    const buf = new Uint8Array(await file.slice(Math.max(0, at), Math.max(0, at) + size).arrayBuffer());
    total += buf.length;
    for (const b of buf) if (b === 0) zeros++;
  }
  return total ? zeros / total : 1;
}

const STANDARD_FPS = [12, 15, 24, 25, 30, 48, 50, 60, 100, 120, 240];

/** Display order of each picture relative to its decode position, from picture order counts. */
function reorderFromPoc(scan: ScanResult, pocBits: number): number[] | null {
  const { pocLsb, idr } = scan.video;
  const n = pocLsb.length;
  if (!n || pocLsb.some((p) => p < 0)) return null;
  const max = 2 ** pocBits;
  const reorder = new Array<number>(n).fill(0);
  let any = false;
  let i = 0;
  while (i < n) {
    let j = i + 1;
    while (j < n && !idr[j]) j++;
    // Unwrap the lsb values of this GOP into a monotonic counter.
    const poc: number[] = [];
    let prev = 0;
    for (let k = i; k < j; k++) {
      let v = prev - (((prev % max) + max) % max) + pocLsb[k];
      if (v - prev > max / 2) v -= max;
      else if (prev - v > max / 2) v += max;
      poc.push(v);
      prev = v;
    }
    const order = poc.map((_, k) => k).sort((a, b) => poc[a] - poc[b] || a - b);
    order.forEach((decodeIndex, displayIndex) => {
      reorder[i + decodeIndex] = displayIndex - decodeIndex;
      if (displayIndex !== decodeIndex) any = true;
    });
    i = j;
  }
  return any ? reorder : null;
}

/**
 * Video frames per audio frame. Audio and video are interleaved with some lead, and a truncated
 * file cuts both off at the same byte, so counting over the whole file is biased. Counting
 * between two points where a run of video frames begins cancels the lead out.
 */
function framesPerAudioFrame(scan: ScanResult): number {
  const v = scan.video;
  const a = scan.audio.offsets;
  const runs: number[] = [];
  for (let i = 0; i < v.offsets.length; i++) {
    if (i === 0 || v.offsets[i] !== v.offsets[i - 1] + v.sizes[i - 1]) runs.push(i);
  }
  // Audio frames in front of each run start (both lists are in file order).
  const audioBefore: number[] = [];
  let k = 0;
  for (const r of runs) {
    while (k < a.length && a[k] < v.offsets[r]) k++;
    audioBefore.push(k);
  }
  // Ratios over windows of about 150 audio frames (a few seconds): long enough that whole-frame
  // rounding does not matter, short enough that the median ignores windows spanning a hole.
  const ratios: number[] = [];
  const WINDOW = Math.min(150, Math.floor(a.length / 3));
  let j = 0;
  for (let i = 0; i < runs.length && WINDOW > 0; i++) {
    if (j < i) j = i;
    while (j < runs.length && audioBefore[j] - audioBefore[i] < WINDOW) j++;
    if (j >= runs.length) break;
    ratios.push((runs[j] - runs[i]) / (audioBefore[j] - audioBefore[i]));
  }
  if (ratios.length >= 3) return ratios.sort((x, y) => x - y)[Math.floor(ratios.length / 2)];
  return v.offsets.length / Math.max(1, a.length);
}

/** Find which AAC sampling-rate family parses the bytes between video frames. */
async function detectAacFamily(blob: Blob, start: number, scan: ScanResult): Promise<number> {
  const { offsets, sizes } = scan.video;
  const gaps: [number, number][] = [];
  let cursor = 0;
  for (let i = 0; i < offsets.length && gaps.length < 6; i++) {
    if (offsets[i] - cursor >= 64) gaps.push([start + cursor, start + offsets[i]]);
    cursor = offsets[i] + sizes[i];
  }
  let best = -1;
  let bestBytes = 0;
  for (const srIndex of [4, 5, 7, 8, 11, 0, 2]) {
    let covered = 0;
    let total = 0;
    for (const [from, to] of gaps) {
      const buf = new Uint8Array(await blob.slice(from, Math.min(to, from + 65536)).arrayBuffer());
      total += buf.length;
      let p = 0;
      while (p < buf.length - 2) {
        const f = parseAacFrame(buf, p, buf.length, srIndex);
        if (f) {
          covered += f.length;
          p += f.length;
        } else p++;
      }
    }
    if (covered > bestBytes && covered >= total * 0.5) {
      bestBytes = covered;
      best = srIndex;
    }
  }
  return best;
}

async function readSample(blob: Blob, start: number, scan: ScanResult, i: number): Promise<Uint8Array> {
  const from = start + scan.video.offsets[i];
  return new Uint8Array(await blob.slice(from, from + scan.video.sizes[i]).arrayBuffer());
}

export async function repairVideo(file: Blob, opts: RepairOptions = {}): Promise<RepairResult> {
  const facts: Record<string, string | number> = {};
  try {
    return await repairWithFacts(file, opts, facts);
  } catch (e) {
    if (e instanceof RepairError) e.facts = facts;
    throw e;
  }
}

async function repairWithFacts(file: Blob, opts: RepairOptions, facts: Record<string, string | number>): Promise<RepairResult> {
  const progress = opts.onProgress ?? (() => {});
  progress("inspect", 0);

  // --- Diagnosis -----------------------------------------------------------------------------
  if (file.size < 1024) throw new RepairError("EMPTY_FILE");
  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  const zeros = await zeroFraction(file);
  if (zeros > 0.999) throw new RepairError("ZERO_FILLED");

  const boxes = await listTopBoxes(file);
  const mdat = boxes.find((b) => b.type === "mdat");
  const moov = await findMoov(file, boxes).catch(() => null);
  facts["サイズ"] = file.size;
  facts["構造"] = boxes.slice(0, 6).map((b) => `${b.type}(${b.size})`).join(" ") || "認識できず";
  facts["索引（moov）"] = moov ? (boxes.some((b) => b.type === "moov") ? "あり" : "あり（位置ずれ）") : "なし";
  facts["ゼロの割合"] = `${Math.round(zeros * 100)}%`;
  facts["先頭16バイト"] = Array.from(head.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
  const moovInPlace = boxes.some((b) => b.type === "moov");
  if (!mdat && !moov) {
    const other = sniffOtherFormat(head);
    if (other) throw new RepairError("NOT_MP4", other);
  }
  // A file that does not even begin with a box has lost its start.
  const headerDamaged = boxes.length === 0 || (moov !== null && !moovInPlace);

  // --- A surviving index: check every sample it lists against the file ------------------------
  if (moov) {
    progress("scan", 0);
    const fixed = await repairFromIndex(file, moov, (f) => progress("scan", f), opts.signal).catch((e) => {
      if (e instanceof DOMException) throw e;
      return null;
    });
    facts["索引の利用"] = fixed ? "可" : "不可";
    if (fixed) return finishFromIndex(file, boxes, fixed, headerDamaged, opts, progress);
  }

  // --- No usable index: find the frames in the raw data ---------------------------------------
  try {
    return await repairByScan(file, boxes, moov, opts, progress, headerDamaged, facts);
  } catch (e) {
    if (e instanceof RepairError && e.code === "NO_VIDEO_FOUND" && zeros > 0.9) throw new RepairError("ZERO_FILLED");
    throw e;
  }
}

async function finishFromIndex(
  file: Blob,
  boxes: TopBox[],
  fixed: NonNullable<Awaited<ReturnType<typeof repairFromIndex>>>,
  headerDamaged: boolean,
  opts: RepairOptions,
  progress: (stage: RepairStage, fraction: number) => void,
): Promise<RepairResult> {
  progress("write", 0);
  const video = fixed.tracks[0];
  const videoReport = fixed.reports.find((r) => r.kind === "vide")!;
  const audioReports = fixed.reports.filter((r) => r.kind === "soun");
  const sum = (rs: TrackReport[], f: (r: TrackReport) => number) => rs.reduce((n, r) => n + f(r), 0);

  const causes: DamageCause[] = [];
  if (headerDamaged) causes.push("damaged_header");
  if (fixed.shift !== 0) causes.push("shifted_data");
  if (fixed.reports.some((r) => r.missing > 0)) causes.push("truncated");
  if (fixed.reports.some((r) => r.corrupt > 0)) causes.push("corrupt_data");
  if (!causes.length) causes.push("healthy");

  if (opts.rotation != null && opts.rotation !== -1) video.matrix = rotationMatrix(opts.rotation, fixed.width, fixed.height);

  // The original file is carried along whole, behind a new header: nothing is copied or moved.
  // Its ftyp is kept, so that a QuickTime (.mov) file keeps being read as one.
  const first = boxes[0];
  const ftyp = first?.type === "ftyp" && first.size <= 4096 ? new Uint8Array(await file.slice(0, first.size).arrayBuffer()) : null;
  const blob = new Blob([buildHeader(fixed.tracks, file.size, ftyp) as BlobPart, file], { type: "video/mp4" });
  progress("write", 1);
  const audio = fixed.tracks.find((t) => t.kind === "soun");
  return {
    blob,
    codec: videoReport.format,
    width: fixed.width,
    height: fixed.height,
    fps: fixed.fps,
    videoFrames: videoReport.kept,
    audioFrames: audio ? audio.sizes.length : 0,
    durationSeconds: fixed.durationSeconds,
    discardedBytes: 0,
    estimated: false,
    hadMoov: true,
    unsupportedAudio: null,
    diagnosis: {
      causes,
      method: "index",
      videoTotal: videoReport.total,
      videoDropped: videoReport.total - videoReport.kept,
      audioDropped: sum(audioReports, (r) => r.total - r.kept),
      missingFraction: videoReport.total ? videoReport.missing / videoReport.total : 0,
      videoFormat: videoReport.format,
      audioFormat: audioReports[0]?.format ?? null,
    },
  };
}

async function repairByScan(
  file: Blob,
  boxes: TopBox[],
  moov: Uint8Array | null,
  opts: RepairOptions,
  progress: (stage: RepairStage, fraction: number) => void,
  headerDamaged: boolean,
  facts: Record<string, string | number>,
): Promise<RepairResult> {
  // Locate the media data. Without a usable mdat header the whole file is scanned. The scan
  // always runs to the end of the file: whatever is not a frame is skipped anyway.
  const mdat = boxes.find((b) => b.type === "mdat");
  const hadMoov = moov !== null;
  const start = mdat ? mdat.start + mdat.headerSize : 0;
  const end = file.size;

  // Codec settings come from the reference video, or from what is left of the file's own index.
  let ref: Reference | null = null;
  if (opts.reference) {
    try {
      ref = await parseReference(opts.reference);
    } catch {
      throw new RepairError("REFERENCE_INVALID");
    }
    if (!ref.video) throw new RepairError("REFERENCE_UNSUPPORTED");
  } else if (moov) {
    try {
      const own = referenceFromMoov(moov);
      if (own.video) ref = own;
    } catch {
      // the index is too damaged to give settings
    }
  }

  let codec: VideoCodec = "h264";
  let h264: H264Params | null = null;
  let entry: Uint8Array | null = null;
  let width = 0;
  let height = 0;
  let matrix: Uint8Array | null = null;
  let refFps = 0;
  let aacSrIndex = -1;
  let audioBase: { asc: Uint8Array; sampleRate: number; channels: number; timescale: number; sampleDelta: number } | null = null;
  let unsupportedAudio: string | null = null;
  let estimated = false;
  let scan: ScanResult;
  let hevc: HevcParams | null = null;
  // Set when the codec settings are known up front and only the full scan remains.
  let fullScan = false;
  let h264Sample: ScanResult | null = null;

  if (ref?.video) {
    codec = ref.video.codec;
    entry = ref.video.entry;
    width = ref.video.width;
    height = ref.video.height;
    matrix = ref.video.matrix;
    if (ref.video.sampleDelta) refFps = ref.video.timescale / ref.video.sampleDelta;
    if (codec === "h264") {
      const cfg = readAvcC(ref.video.config);
      h264 = defaultH264Params();
      if (!cfg || cfg.lengthSize !== 4 || !parseSps(cfg.sps, h264) || !parsePps(cfg.pps, h264)) throw new RepairError("REFERENCE_UNSUPPORTED");
    } else {
      hevc = parseHvcC(ref.video.config);
    }
    if (ref.audio) {
      aacSrIndex = ref.audio.srIndex;
      audioBase = ref.audio;
    }
    unsupportedAudio = ref.audio ? null : ref.unsupportedAudio;
  } else {
    // No reference: sample the start of the file and work the settings out from it.
    progress("sample", 0);
    const sample = await scanMedia(file, start, end, { codec: "h264", aacSrIndex: 4, maxPictures: 600, collectHeads: true, signal: opts.signal });
    h264Sample = sample;
    facts["H.264フレーム（先頭部）"] = sample.video.offsets.length;
    let asHevc: ScanResult | null = null;
    if (sample.video.offsets.length < 8) {
      asHevc = await scanMedia(file, start, end, { codec: "hevc", aacSrIndex: 4, maxPictures: 60, signal: opts.signal });
      facts["HEVCフレーム（先頭部）"] = asHevc.video.offsets.length;
      facts["埋め込み設定（VPS/SPS/PPS）"] = [asHevc.vps, asHevc.sps, asHevc.pps].map((x) => (x ? "有" : "無")).join("/");
      if (asHevc.video.offsets.length < 8) throw new RepairError("NO_VIDEO_FOUND");
      // HEVC: usable without a reference when the stream carries its own parameter sets.
      const cfg = asHevc.vps && asHevc.sps && asHevc.pps ? hvcCFromParameterSets(asHevc.vps, asHevc.sps, asHevc.pps) : null;
      if (!cfg) throw new RepairError("HEVC_NEEDS_REFERENCE");
      codec = "hevc";
      hevc = cfg.params;
      width = cfg.sps.width;
      height = cfg.sps.height;
      entry = buildHvc1Entry(cfg.hvcC, width, height);
      aacSrIndex = asHevc.audio.offsets.length >= 4 ? 4 : await detectAacFamily(file, start, asHevc);
      fullScan = true;
    }
  }
  if (!ref?.video && !fullScan && h264Sample) {
    let sample = h264Sample;
    aacSrIndex = sample.audio.offsets.length >= 4 ? 4 : await detectAacFamily(file, start, sample);
    if (aacSrIndex !== 4 && aacSrIndex >= 0) {
      // Audio in the gaps helps to confirm frames, so sample again with the right tables.
      sample = await scanMedia(file, start, end, { codec: "h264", aacSrIndex, maxPictures: 600, collectHeads: true, signal: opts.signal });
    }

    let sps = sample.sps;
    let pps = sample.pps;
    h264 = defaultH264Params();
    const inBandSize = sps && pps && parsePps(pps, h264) ? parseSps(sps, h264) : null;
    if (inBandSize) {
      // The stream carries its own parameter sets: nothing to estimate.
      width = inBandSize.width;
      height = inBandSize.height;
    } else {
      sps = null;
      pps = null;
      const hints = sample.x264Options ? parseX264Options(sample.x264Options) : null;
      const layout = analyzeHeads(sample.heads, hints);
      if (!layout) throw new RepairError("ESTIMATE_FAILED");
      h264 = layout.params;
    }

    progress("scan", 0);
    scan = await scanMedia(file, start, end, {
      codec: "h264",
      h264,
      aacSrIndex,
      signal: opts.signal,
      onProgress: (f) => progress("scan", f),
    });
    const firstKey = scan.video.keys.indexOf(true);
    if (firstKey < 0) throw new RepairError("NO_VIDEO_FOUND");

    if (!sps || !pps) {
      if (!opts.prober) throw new RepairError("PROBER_UNAVAILABLE");
      progress("estimate", 0);
      let prober: Prober;
      try {
        prober = await opts.prober();
      } catch {
        throw new RepairError("PROBER_UNAVAILABLE");
      }
      // Use the most detailed key frame near the start: a black opening frame says nothing about size.
      let pick = firstKey;
      let seen = 0;
      for (let i = firstKey; i < scan.video.keys.length && seen < 12; i++) {
        if (!scan.video.keys[i]) continue;
        seen++;
        if (scan.video.sizes[i] > scan.video.sizes[pick]) pick = i;
      }
      const samples: Uint8Array[] = [];
      for (let i = pick; i < Math.min(pick + 12, scan.video.sizes.length); i++) {
        if (i > pick && scan.video.keys[i]) break;
        samples.push(await readSample(file, start, scan, i));
      }
      const hints = sample.x264Options ? parseX264Options(sample.x264Options) : null;
      const layout = analyzeHeads(sample.heads, hints)!;
      const est = await estimateParameters({ layout, hints, samples, prober, signal: opts.signal, onProgress: (f) => progress("estimate", f) });
      if (!est) throw new RepairError("ESTIMATE_FAILED");
      sps = est.sps;
      pps = est.pps;
      width = est.width;
      height = est.height;
      estimated = true;
    }
    entry = buildAvc1Entry(buildAvcC(sps, pps), width, height);
  }

  if (ref || fullScan) {
    progress("scan", 0);
    scan = await scanMedia(file, start, end, {
      codec,
      h264,
      hevc,
      aacSrIndex,
      signal: opts.signal,
      onProgress: (f) => progress("scan", f),
    });
  }
  scan = scan!;

  // Decoding can only start at a key frame: drop anything before the first one. The same goes
  // for frames behind a hole in the data (overwritten or missing frames): they are left out up
  // to the next key frame, and their time is given to the frame shown before them.
  const firstKey = scan.video.keys.indexOf(true);
  if (firstKey < 0 || scan.video.offsets.length - firstKey < 1) throw new RepairError("NO_VIDEO_FOUND");
  // Measured before damaged frames are taken out, which would otherwise skew it.
  const videoPerAudio = framesPerAudioFrame(scan);
  const found = scan.video.offsets.length - firstKey;
  const gaps = scan.video.gap.filter((g, i) => g && i > firstKey).length;
  // Many "holes" mean the continuity check does not fit this stream; then nothing is dropped.
  const trustGaps = gaps > 0 && gaps <= Math.max(3, found * 0.01);
  const hold: number[] = [];
  {
    const v = scan.video;
    const keep: number[] = [];
    let waitForKey = false;
    for (let i = firstKey; i < v.offsets.length; i++) {
      if (v.keys[i]) waitForKey = false;
      else if (trustGaps && v.gap[i]) waitForKey = true;
      // A frame with a blanked-out block is unusable itself, key frame or not.
      if (v.bad[i]) waitForKey = true;
      if (waitForKey) {
        if (hold.length) hold[hold.length - 1]++;
        continue;
      }
      keep.push(i);
      hold.push(0);
    }
    for (const k of ["offsets", "sizes", "keys", "idr", "pocLsb", "gap", "bad"] as const) {
      const src = v[k] as unknown[];
      (v as Record<string, unknown[]>)[k] = keep.map((i) => src[i]);
    }
  }
  const droppedFrames = found - scan.video.offsets.length;
  if (!scan.video.offsets.length) throw new RepairError("NO_VIDEO_FOUND");
  progress("write", 0);

  const frames = scan.video.offsets.length;
  const audioFrames = scan.audio.offsets.length;

  // Audio: 1024 samples per AAC frame. Without a reference the sampling rate is not stored
  // anywhere, so pick the rate that makes the video frame rate come out at a standard value.
  if (audioFrames && !audioBase) {
    const channels = scan.audio.channels || 2;
    const candidates = aacSrIndex === 4 ? [4, 3] : [aacSrIndex];
    let bestIdx = candidates[0];
    let bestErr = Infinity;
    for (const idx of candidates) {
      const fps = (videoPerAudio * AAC_SAMPLE_RATES[idx]) / 1024;
      const err = Math.min(...STANDARD_FPS.map((s) => Math.abs(Math.log(fps / s))));
      if (err < bestErr) {
        bestErr = err;
        bestIdx = idx;
      }
    }
    const sampleRate = AAC_SAMPLE_RATES[bestIdx];
    audioBase = {
      asc: Uint8Array.from([(2 << 3) | (bestIdx >> 1), ((bestIdx & 1) << 7) | (Math.min(channels, 7) << 3)]),
      sampleRate,
      channels,
      timescale: sampleRate,
      sampleDelta: 1024,
    };
  }

  // Frame rate: the audio track is the clock. Its duration divided by the frame count gives the
  // rate, snapped to the reference's value or to the nearest standard rate.
  let fps = refFps || 30;
  if (audioFrames > 20 && audioBase) {
    const measured = (videoPerAudio * audioBase.timescale) / audioBase.sampleDelta;
    if (!(refFps && Math.abs(Math.log(measured / refFps)) < 0.12)) {
      fps = STANDARD_FPS.reduce((a, b) => (Math.abs(Math.log(measured / b)) < Math.abs(Math.log(measured / a)) ? b : a));
    }
  }
  // NTSC rates (29.97 ...) need a 1001-based time base to be exact.
  const ntsc = Math.abs(fps * 1.001 - Math.round(fps * 1.001)) < 0.01 && Math.abs(fps - Math.round(fps)) > 0.01;
  const timescale = ntsc ? Math.round(fps * 1.001) * 1000 : Number.isInteger(fps) ? fps * 1000 : 90000;
  const sampleDelta = ntsc ? 1001 : Number.isInteger(fps) ? 1000 : Math.round(timescale / fps);

  const pocBits = codec === "h264" ? (h264 && h264.pocType === 0 ? h264.log2MaxPocLsb : 0) : (hevc?.log2MaxPocLsb ?? 0);
  const reorder = pocBits ? reorderFromPoc(scan, pocBits) : null;

  if (opts.rotation != null && opts.rotation !== -1) matrix = rotationMatrix(opts.rotation, width, height);

  let shift = 0;
  if (reorder) for (const r of reorder) if (-r > shift) shift = -r;

  // Holes in the data (blocks that are neither video nor audio) took some playing time with
  // them. How much is estimated from the average data rate, and the same amount is inserted
  // into both tracks at that spot, so picture and sound stay together after the hole.
  const videoDurations = hold.map((h) => (h + 1) * sampleDelta);
  const audioDelta = audioBase?.sampleDelta ?? 1024;
  const audioDurations = new Array<number>(audioFrames).fill(audioDelta);
  const frameBytes = scan.video.sizes.reduce((n, x) => n + x, 0) + scan.audio.sizes.reduce((n, x) => n + x, 0);
  const seconds = (frames * sampleDelta) / timescale;
  let lostSeconds = 0;
  if (frameBytes > 0 && seconds > 0) {
    const lastBefore = (offsets: number[], at: number) => {
      let lo = 0;
      let hi = offsets.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (offsets[mid] < at) lo = mid + 1;
        else hi = mid;
      }
      return lo - 1;
    };
    for (const [at, length] of scan.junk) {
      const lost = (length / frameBytes) * seconds;
      if (lost < 0.1) continue; // ordinary non-media data (metadata tracks)
      lostSeconds += lost;
      const vi = lastBefore(scan.video.offsets, at);
      if (vi >= 0) videoDurations[vi] += Math.round(lost * fps) * sampleDelta;
      const ai = lastBefore(scan.audio.offsets, at);
      if (ai >= 0 && audioBase) audioDurations[ai] += Math.round(lost * fps) * Math.round((sampleDelta / timescale) * audioBase.timescale);
    }
  }
  const tracks: OutTrack[] = [
    {
      kind: "vide",
      entry: entry!,
      timescale,
      matrix,
      width: width * 65536,
      height: height * 65536,
      offsets: scan.video.offsets,
      sizes: scan.video.sizes,
      durations: videoDurations,
      cts: reorder ? reorder.map((r) => (r + shift) * sampleDelta) : null,
      sync: scan.video.keys,
      mediaTime: shift * sampleDelta,
      // Frames in front of the first key frame cannot be shown; their time stays empty so the
      // sound that goes with them does not slide against the picture.
      startDelay: firstKey * sampleDelta,
    },
  ];
  const hasAudio = audioFrames > 0 && audioBase !== null;
  if (hasAudio && audioBase) {
    tracks.push({
      kind: "soun",
      entry: buildAacEntry(audioBase.asc, audioBase.sampleRate, audioBase.channels),
      timescale: audioBase.timescale,
      matrix: null,
      width: 0,
      height: 0,
      offsets: scan.audio.offsets,
      sizes: scan.audio.sizes,
      durations: audioDurations,
      cts: null,
      sync: null,
      mediaTime: 0,
      startDelay: 0,
    });
  }

  const dataSize = scan.endOfData - start;
  const header = buildHeader(tracks, dataSize);
  const blob = new Blob([header as BlobPart, file.slice(start, scan.endOfData)], { type: "video/mp4" });
  progress("write", 1);

  const causes: DamageCause[] = [hadMoov ? "damaged_index" : "missing_index"];
  if (headerDamaged && !causes.includes("damaged_header")) causes.push("damaged_header");
  if (mdat && mdat.start + mdat.size > file.size + 16) causes.push("truncated");
  if (droppedFrames > 0 || lostSeconds > 0) causes.push("corrupt_data");

  return {
    blob,
    codec,
    width,
    height,
    fps,
    videoFrames: frames,
    audioFrames,
    durationSeconds: videoDurations.reduce((n, x) => n + x, firstKey * sampleDelta) / timescale,
    discardedBytes: end - scan.endOfData,
    estimated,
    hadMoov,
    unsupportedAudio: hasAudio ? null : unsupportedAudio,
    diagnosis: {
      causes,
      method: "scan",
      videoTotal: frames + droppedFrames,
      videoDropped: droppedFrames,
      audioDropped: 0,
      missingFraction: 0,
      videoFormat: codec === "h264" ? "avc1" : "hvc1",
      audioFormat: hasAudio ? "mp4a" : null,
    },
  };
}
