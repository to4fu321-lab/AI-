// Repairs MP4 / MOV files that lost their moov index (interrupted recording, failed transfer,
// truncated download): the frames are located in the raw data and a new index is written.
//
// Nothing is re-encoded and the media data is never copied in memory: the result is a Blob made
// of a small new header plus a slice of the original file, so multi-gigabyte files work on a phone.

import { AAC_SAMPLE_RATES, parseAacFrame } from "./aac";
import { analyzeHeads, estimateParameters, parseX264Options, type Prober } from "./estimate";
import { buildAvcC, defaultH264Params, parsePps, parseSps, readAvcC, type H264Params } from "./h264";
import { parseHvcC } from "./hevc";
import { buildAvc1Entry, buildHeader, listTopBoxes, parseReference, rotationMatrix, type MuxAudio, type MuxVideo, type VideoCodec } from "./mp4";
import { scanMedia, type ScanResult } from "./scan";

export type { Prober } from "./estimate";

export type RepairErrorCode =
  | "REFERENCE_INVALID"
  | "REFERENCE_UNSUPPORTED"
  | "NO_VIDEO_FOUND"
  | "HEVC_NEEDS_REFERENCE"
  | "ESTIMATE_FAILED"
  | "PROBER_UNAVAILABLE";

export class RepairError extends Error {
  constructor(readonly code: RepairErrorCode) {
    super(code);
  }
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
  codec: VideoCodec;
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
  if (runs.length >= 4) {
    const i1 = runs[Math.floor(runs.length * 0.1)];
    const i2 = runs[Math.max(Math.floor(runs.length * 0.1) + 1, Math.floor((runs.length - 1) * 0.95))];
    let count = 0;
    for (const off of a) if (off >= v.offsets[i1] && off < v.offsets[i2]) count++;
    if (count >= 20) return (i2 - i1) / count;
  }
  return v.offsets.length / a.length;
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
  const progress = opts.onProgress ?? (() => {});
  progress("inspect", 0);

  // Locate the media data. Without a usable mdat header the whole file is scanned.
  const boxes = await listTopBoxes(file);
  const mdat = boxes.find((b) => b.type === "mdat");
  const hadMoov = boxes.some((b) => b.type === "moov");
  const start = mdat ? mdat.start + mdat.headerSize : 0;
  const end = mdat && mdat.start + mdat.size < file.size ? mdat.start + mdat.size : file.size;

  let codec: VideoCodec = "h264";
  let h264: H264Params | null = null;
  let entry: Uint8Array | null = null;
  let width = 0;
  let height = 0;
  let matrix: Uint8Array | null = null;
  let refFps = 0;
  let aacSrIndex = -1;
  let audioBase: Pick<MuxAudio, "asc" | "sampleRate" | "channels" | "timescale" | "sampleDelta"> | null = null;
  let unsupportedAudio: string | null = null;
  let estimated = false;
  let scan: ScanResult;
  let hevc = null;

  if (opts.reference) {
    let ref;
    try {
      ref = await parseReference(opts.reference);
    } catch {
      throw new RepairError("REFERENCE_INVALID");
    }
    if (!ref.video) throw new RepairError("REFERENCE_UNSUPPORTED");
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
    // No reference: sample the start of the file and work the H.264 settings out from it.
    progress("sample", 0);
    let sample = await scanMedia(file, start, end, { codec: "h264", aacSrIndex: 4, maxPictures: 600, collectHeads: true, signal: opts.signal });
    if (sample.video.offsets.length < 8) {
      const asHevc = await scanMedia(file, start, end, { codec: "hevc", aacSrIndex: 4, maxPictures: 60, signal: opts.signal });
      if (asHevc.video.offsets.length >= 8) throw new RepairError("HEVC_NEEDS_REFERENCE");
      throw new RepairError("NO_VIDEO_FOUND");
    }
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

  if (opts.reference) {
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

  // Decoding can only start at a key frame: drop anything before the first one.
  const firstKey = scan.video.keys.indexOf(true);
  if (firstKey < 0 || scan.video.offsets.length - firstKey < 1) throw new RepairError("NO_VIDEO_FOUND");
  if (firstKey > 0) {
    for (const k of ["offsets", "sizes", "keys", "idr", "pocLsb"] as const) (scan.video[k] as unknown[]).splice(0, firstKey);
  }
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
      const fps = (framesPerAudioFrame(scan) * AAC_SAMPLE_RATES[idx]) / 1024;
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
    const measured = (framesPerAudioFrame(scan) * audioBase.timescale) / audioBase.sampleDelta;
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

  const video: MuxVideo = {
    codec,
    entry: entry!,
    width,
    height,
    timescale,
    sampleDelta,
    matrix,
    offsets: scan.video.offsets,
    sizes: scan.video.sizes,
    keys: scan.video.keys,
    reorder,
  };
  const audio: MuxAudio | null = audioFrames && audioBase ? { ...audioBase, offsets: scan.audio.offsets, sizes: scan.audio.sizes } : null;

  const dataSize = scan.endOfData - start;
  const header = buildHeader(video, audio, dataSize);
  const blob = new Blob([header as BlobPart, file.slice(start, scan.endOfData)], { type: "video/mp4" });
  progress("write", 1);

  return {
    blob,
    codec,
    width,
    height,
    fps,
    videoFrames: frames,
    audioFrames,
    durationSeconds: (frames * sampleDelta) / timescale,
    discardedBytes: end - scan.endOfData,
    estimated,
    hadMoov,
    unsupportedAudio: audio ? null : unsupportedAudio,
  };
}
