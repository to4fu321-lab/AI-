// Walks the raw media data of a broken file and finds every video frame and audio frame in it.
//
// Video frames are stored as length-prefixed NAL units; audio frames are bare AAC. Both are
// recognised purely from their own syntax, anything else (timed metadata, garbage) is skipped.

import { parseAacFrame } from "./aac";
import { unescapeRbsp } from "./bits";
import { hasZeroRun } from "./zeros";
import { parseSliceHeader, parseSliceStart, type H264Params } from "./h264";
import { parseHevcSlice, type HevcParams } from "./hevc";
import type { VideoCodec } from "./mp4";

const LOOK = 16 * 1024;
const CHUNK = 8 * 1024 * 1024;
const MAX_NAL = 48 * 1024 * 1024;
const HEAD_BYTES = 96;

/** Buffered random access into a Blob. */
export class Reader {
  private buf = new Uint8Array(0);
  private base = 0;
  private peekBuf = new Uint8Array(0);
  private peekBase = -1;

  constructor(
    private readonly blob: Blob,
    readonly end: number,
  ) {}

  /** View of at least LOOK bytes (less at EOF) starting at `pos` from the main window, if loaded. */
  view(pos: number): { buf: Uint8Array; at: number } | null {
    const need = Math.min(LOOK, this.end - pos);
    if (pos >= this.base && pos + need <= this.base + this.buf.length) return { buf: this.buf, at: pos - this.base };
    return null;
  }

  async load(pos: number): Promise<{ buf: Uint8Array; at: number }> {
    this.buf = new Uint8Array(await this.blob.slice(pos, Math.min(this.end, pos + CHUNK)).arrayBuffer());
    this.base = pos;
    return { buf: this.buf, at: 0 };
  }

  /** Small look-ahead read that leaves the main window where it is. */
  async peek(pos: number): Promise<{ buf: Uint8Array; at: number }> {
    const v = this.view(pos);
    if (v) return v;
    const need = Math.min(LOOK, this.end - pos);
    if (!(pos >= this.peekBase && this.peekBase >= 0 && pos + need <= this.peekBase + this.peekBuf.length)) {
      this.peekBuf = new Uint8Array(await this.blob.slice(pos, Math.min(this.end, pos + LOOK * 4)).arrayBuffer());
      this.peekBase = pos;
    }
    return { buf: this.peekBuf, at: pos - this.peekBase };
  }
}

/** First slice of a picture, kept for parameter estimation. */
export interface SliceHead {
  nalType: number;
  refIdc: number;
  /** Unescaped bytes following the NAL header. */
  head: Uint8Array;
}

export interface ScanOptions {
  codec: VideoCodec;
  /** Known H.264 parameters; without them only loose syntax checks are possible. */
  h264?: H264Params | null;
  hevc?: HevcParams | null;
  /** AAC sampling_frequency_index, or -1 to ignore audio. */
  aacSrIndex: number;
  /** Stop after this many pictures (used for the sampling pass). */
  maxPictures?: number;
  /** Collect slice heads for parameter estimation. */
  collectHeads?: boolean;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export interface ScanResult {
  video: {
    offsets: number[];
    sizes: number[];
    keys: boolean[];
    /** IDR flag: display order restarts here. */
    idr: boolean[];
    /** pic_order_cnt_lsb per sample, -1 when unknown. */
    pocLsb: number[];
    /**
     * True when the picture does not follow on from the one before it (frames were lost in
     * between), so it cannot be decoded correctly until the next key frame.
     */
    gap: boolean[];
    /** True when the picture's own data is damaged (it contains a block of zero bytes). */
    bad: boolean[];
  };
  audio: { offsets: number[]; sizes: number[]; channels: number };
  heads: SliceHead[];
  /** In-band parameter sets, when the stream carries them. */
  sps: Uint8Array | null;
  pps: Uint8Array | null;
  /** HEVC only: in-band video parameter set. */
  vps: Uint8Array | null;
  /** Encoder settings text found in an x264 SEI message, if any. */
  x264Options: string | null;
  /** Stretches of at least 4 KB between frames that are neither video nor audio: [offset, length]. */
  junk: [number, number][];
  /** First byte after the last recognised frame. */
  endOfData: number;
}

interface Item {
  kind: "video" | "audio";
  length: number;
  /** Video: NAL type. */
  nalType: number;
  refIdc: number;
  vcl: boolean;
  /** Starts a new picture (first slice / first slice segment). */
  first: boolean;
  /** Passed the checks that need known stream parameters. */
  strict: boolean;
  frameNum: number;
  pocLsb: number;
  channels: number;
  head: Uint8Array | null;
}

export async function scanMedia(blob: Blob, start: number, end: number, opts: ScanOptions): Promise<ScanResult> {
  const reader = new Reader(blob, end);
  const res: ScanResult = {
    video: { offsets: [], sizes: [], keys: [], idr: [], pocLsb: [], gap: [], bad: [] },
    audio: { offsets: [], sizes: [], channels: 0 },
    heads: [],
    sps: null,
    pps: null,
    vps: null,
    x264Options: null,
    junk: [],
    endOfData: start,
  };
  const h264 = opts.codec === "h264";
  const strictParams = h264 ? opts.h264 ?? null : null;
  const maxFrameNum = strictParams ? 2 ** strictParams.log2MaxFrameNum : 0;

  // H.264 frame_num bookkeeping: the value every following picture must carry.
  let prevRefFrameNum = 0;
  let curFrameNum = -1;
  let prevPoc = -1;
  let maxNal = 4 * 1024 * 1024;

  const probeVideo = (buf: Uint8Array, at: number, pos: number): Item | null => {
    const avail = buf.length - at;
    if (avail < 8) return null;
    if (buf[at] > 3) return null;
    const len = ((buf[at] << 24) | (buf[at + 1] << 16) | (buf[at + 2] << 8) | buf[at + 3]) >>> 0;
    if (len < 2 || len > MAX_NAL || pos + 4 + len > end) return null;
    const b0 = buf[at + 4];
    if (b0 & 0x80) return null;
    const item: Item = {
      kind: "video",
      length: 4 + len,
      nalType: 0,
      refIdc: 0,
      vcl: false,
      first: false,
      strict: false,
      frameNum: -1,
      pocLsb: -1,
      channels: 0,
      head: null,
    };
    const headEnd = Math.min(buf.length, at + 4 + len);

    if (h264) {
      const type = b0 & 31;
      const refIdc = b0 >> 5;
      item.nalType = type;
      item.refIdc = refIdc;
      if (type === 1 || type === 5) {
        if (type === 5 && refIdc === 0) return null;
        if (len < 3) return null;
        const rbsp = unescapeRbsp(buf, at + 5, headEnd, HEAD_BYTES);
        const p = strictParams;
        if (p) {
          const s = parseSliceHeader(rbsp, type, refIdc, p);
          if (!s) return null;
          item.first = s.firstMb === 0;
          item.frameNum = s.frameNum;
          item.pocLsb = s.pocLsb;
          if (type === 5) item.strict = s.frameNum === 0;
          else if (item.first) item.strict = s.frameNum === (prevRefFrameNum + 1) % maxFrameNum;
          else item.strict = s.frameNum === curFrameNum;
        } else {
          // Loose check: first_mb_in_slice, slice_type and pic_parameter_set_id must be sane.
          const firstMb = parseSliceStart(rbsp, type);
          if (firstMb < 0) return null;
          item.first = firstMb === 0;
          if (opts.collectHeads && item.first) item.head = rbsp;
        }
        item.vcl = true;
        return item;
      }
      if (type === 6 || type === 9 || type === 12) {
        if (refIdc !== 0 || len > 65536) return null;
        if (type === 6 && opts.collectHeads && len > 64) item.head = buf.slice(at + 4, Math.min(headEnd, at + 4 + 4096));
        return item;
      }
      if (type === 7 || type === 8) {
        if (refIdc === 0 || len > 1024) return null;
        item.head = buf.slice(at + 4, headEnd);
        return item;
      }
      return null;
    }

    // HEVC
    const type = (b0 >> 1) & 63;
    const b1 = buf[at + 5];
    if ((b0 & 1) !== 0 || b1 >> 3 !== 0 || (b1 & 7) === 0) return null; // nuh_layer_id 0, temporal id valid
    item.nalType = type;
    if (type <= 9 || (type >= 16 && type <= 21)) {
      if (len < 4) return null;
      const s = parseHevcSlice(unescapeRbsp(buf, at + 6, headEnd, 32), type, opts.hevc ?? null);
      if (!s) return null;
      item.vcl = true;
      item.first = s.firstSlice;
      item.pocLsb = s.pocLsb;
      if (s.firstSlice && opts.hevc && s.pocLsb >= 0) {
        const max = 2 ** opts.hevc.log2MaxPocLsb;
        const d = (s.pocLsb - prevPoc + max) % max;
        item.strict = type >= 16 || prevPoc < 0 || d <= 64 || d >= max - 64;
      }
      return item;
    }
    if (type >= 32 && type <= 40) {
      if (len > 65536) return null;
      if (type <= 34 && len <= 1024) item.head = buf.slice(at + 4, headEnd);
      return item;
    }
    return null;
  };

  const probe = (buf: Uint8Array, at: number, pos: number): Item | null => {
    const v = probeVideo(buf, at, pos);
    if (v) {
      // A wildly oversized "NAL" in front of real data would swallow it; keep lengths plausible.
      if (v.length - 4 <= maxNal) return v;
    }
    if (opts.aacSrIndex >= 0 && buf.length - at >= 2) {
      const f = parseAacFrame(buf, at, buf.length, opts.aacSrIndex);
      if (f && pos + f.length <= end) {
        return {
          kind: "audio",
          length: f.length,
          nalType: 0,
          refIdc: 0,
          vcl: false,
          first: false,
          strict: false,
          frameNum: -1,
          pocLsb: -1,
          channels: f.channels,
          head: null,
        };
      }
    }
    return null;
  };

  // Access unit being assembled.
  let auStart = -1;
  let auEnd = -1;
  let auHasVcl = false;
  let auKey = false;
  let auIdr = false;
  let auPoc = -1;
  let auGap = false;
  let auBad = false;
  let pictures = 0;
  const flushAu = () => {
    if (auStart >= 0 && auHasVcl) {
      res.video.offsets.push(auStart - start);
      res.video.sizes.push(auEnd - auStart);
      res.video.keys.push(auKey);
      res.video.idr.push(auIdr);
      res.video.pocLsb.push(auPoc);
      res.video.gap.push(auGap);
      res.video.bad.push(auBad);
      pictures++;
    }
    auStart = -1;
    auHasVcl = false;
    auKey = false;
    auIdr = false;
    auPoc = -1;
    auGap = false;
    auBad = false;
  };

  let auBadNext = false;
  let pos = start;
  let lastKind: "video" | "audio" | "" = "";
  let lastEnd = -1;
  let lastReport = start;
  const channelVotes = new Map<number, number>();

  while (pos < end - 4) {
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const v = reader.view(pos) ?? (await reader.load(pos));
    const item = probe(v.buf, v.at, pos);
    let accept = false;
    if (item) {
      const next = pos + item.length;
      if (next >= end - 4) {
        accept = true;
      } else if (item.kind === "video" && item.vcl && item.strict) {
        accept = true;
      } else if (item.kind === "audio" && lastKind === "audio" && lastEnd === pos) {
        accept = true;
      } else {
        const nv = await reader.peek(next);
        accept = probe(nv.buf, nv.at, next) !== null;
      }
    }
    if (!item || !accept) {
      pos++;
      continue;
    }

    const next = pos + item.length;
    if (lastEnd >= 0 && pos - lastEnd >= 4096) res.junk.push([lastEnd - start, pos - lastEnd]);
    if (item.kind === "video" && item.vcl && v.at + item.length <= v.buf.length && hasZeroRun(v.buf, v.at, v.at + item.length)) {
      auBadNext = true;
    }
    if (item.kind === "audio") {
      flushAu();
      res.audio.offsets.push(pos - start);
      res.audio.sizes.push(item.length);
      channelVotes.set(item.channels, (channelVotes.get(item.channels) ?? 0) + 1);
    } else {
      const contiguous = auStart >= 0 && auEnd === pos;
      // A new access unit starts at a picture's first slice, or at any non-VCL NAL that
      // follows slice data.
      if (!contiguous || (auHasVcl && (item.first || !item.vcl))) flushAu();
      if (auStart < 0) auStart = pos;
      auEnd = next;
      if (auBadNext) auBad = true;
      auBadNext = false;
      if (item.vcl) {
        if (item.length - 4 > maxNal / 8) maxNal = Math.min(MAX_NAL, (item.length - 4) * 8);
        if (!auHasVcl) {
          auPoc = item.pocLsb;
          // With known stream parameters, a first slice that fails the continuity check
          // (frame_num / picture order) means pictures are missing in front of it.
          auGap = item.first && !item.strict && (h264 ? strictParams !== null : !!opts.hevc);
        }
        auHasVcl = true;
        if (h264) {
          if (item.nalType === 5) {
            auKey = true;
            auIdr = true;
            prevRefFrameNum = 0;
            curFrameNum = 0;
          } else if (item.first && item.frameNum >= 0) {
            curFrameNum = item.frameNum;
            if (item.refIdc !== 0) prevRefFrameNum = item.frameNum;
          }
          if (item.head && opts.collectHeads) res.heads.push({ nalType: item.nalType, refIdc: item.refIdc, head: item.head });
        } else {
          if (item.nalType >= 16) auKey = true;
          if (item.nalType === 19 || item.nalType === 20) auIdr = true;
          if (item.first && item.pocLsb >= 0) prevPoc = item.pocLsb;
        }
      } else if (!h264 && item.head) {
        if (item.nalType === 32) res.vps ??= item.head;
        else if (item.nalType === 33) res.sps ??= item.head;
        else if (item.nalType === 34) res.pps ??= item.head;
      } else if (h264 && item.head) {
        if (item.nalType === 7) res.sps ??= item.head;
        else if (item.nalType === 8) res.pps ??= item.head;
        else if (!res.x264Options) {
          const text = String.fromCharCode(...item.head);
          const at = text.indexOf("x264 - core");
          if (at >= 0) res.x264Options = text.slice(at).split("\0")[0];
        }
      }
    }
    lastKind = item.kind;
    lastEnd = next;
    res.endOfData = next;
    pos = next;

    if (opts.maxPictures && pictures >= opts.maxPictures) break;
    if (opts.onProgress && pos - lastReport > CHUNK) {
      lastReport = pos;
      opts.onProgress((pos - start) / (end - start));
      // Let the UI breathe.
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  flushAu();

  let best = 0;
  for (const [ch, n] of channelVotes) {
    if (n > best) {
      best = n;
      res.audio.channels = ch;
    }
  }
  return res;
}
