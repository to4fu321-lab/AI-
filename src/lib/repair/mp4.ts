// MP4 / QuickTime container helpers: locating boxes in the broken file, pulling codec settings
// out of a healthy reference file, and writing a fresh moov index.

export interface TopBox {
  type: string;
  start: number;
  headerSize: number;
  /** Size declared in the header; may run past the end of a truncated file. */
  size: number;
}

const FOURCC_RE = /^[\x20-\x7e]{4}$/;

function fourcc(buf: Uint8Array, o: number): string {
  return String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
}

function u32(buf: Uint8Array, o: number): number {
  return ((buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3]) >>> 0;
}

function u16(buf: Uint8Array, o: number): number {
  return (buf[o] << 8) | buf[o + 1];
}

async function readBytes(blob: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(start, Math.min(end, blob.size)).arrayBuffer());
}

/** Walk the top-level boxes of a file, stopping at the first header that is not a box. */
export async function listTopBoxes(blob: Blob): Promise<TopBox[]> {
  const boxes: TopBox[] = [];
  let pos = 0;
  while (pos + 8 <= blob.size && boxes.length < 1000) {
    const h = await readBytes(blob, pos, pos + 16);
    const type = fourcc(h, 4);
    if (!FOURCC_RE.test(type)) break;
    let size = u32(h, 0);
    let headerSize = 8;
    if (size === 1) {
      if (h.length < 16) break;
      size = u32(h, 8) * 2 ** 32 + u32(h, 12);
      headerSize = 16;
    } else if (size === 0) {
      size = blob.size - pos;
    }
    if (size < headerSize) break;
    boxes.push({ type, start: pos, headerSize, size });
    pos += size;
  }
  return boxes;
}

interface Box {
  type: string;
  body: number;
  end: number;
}

function* children(buf: Uint8Array, start: number, end: number): Generator<Box> {
  let pos = start;
  while (pos + 8 <= end) {
    let size = u32(buf, pos);
    let header = 8;
    if (size === 1) {
      size = u32(buf, pos + 8) * 2 ** 32 + u32(buf, pos + 12);
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) return;
    yield { type: fourcc(buf, pos + 4), body: pos + header, end: pos + size };
    pos += size;
  }
}

function find(buf: Uint8Array, start: number, end: number, type: string): Box | null {
  for (const b of children(buf, start, end)) if (b.type === type) return b;
  return null;
}

export type VideoCodec = "h264" | "hevc";

export interface RefVideo {
  codec: VideoCodec;
  /** Complete sample entry box (avc1 / hvc1 ...) copied from the reference. */
  entry: Uint8Array;
  /** avcC or hvcC payload. */
  config: Uint8Array;
  width: number;
  height: number;
  timescale: number;
  sampleDelta: number;
  /** tkhd transformation matrix (36 bytes) — carries the rotation. */
  matrix: Uint8Array;
}

export interface RefAudio {
  /** AudioSpecificConfig. */
  asc: Uint8Array;
  srIndex: number;
  sampleRate: number;
  channels: number;
  timescale: number;
  sampleDelta: number;
}

export interface Reference {
  video: RefVideo | null;
  audio: RefAudio | null;
  /** Fourcc of an audio track that cannot be recovered (anything but AAC). */
  unsupportedAudio: string | null;
}

const MAX_MOOV = 512 * 1024 * 1024;

function moovHeaderSize(buf: Uint8Array): number {
  return u32(buf, 0) === 1 ? 16 : 8;
}

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

function mostCommonDelta(buf: Uint8Array, stts: Box | null): number {
  if (!stts) return 0;
  const count = u32(buf, stts.body + 4);
  let best = 0;
  let bestCount = 0;
  for (let i = 0; i < count && stts.body + 16 + i * 8 <= stts.end; i++) {
    const n = u32(buf, stts.body + 8 + i * 8);
    const delta = u32(buf, stts.body + 12 + i * 8);
    if (n > bestCount) {
      bestCount = n;
      best = delta;
    }
  }
  return best;
}

function findAsc(entry: Uint8Array): Uint8Array | null {
  // The esds box sits directly in an ISO mp4a entry but inside a 'wave' box in QuickTime files,
  // so look for its fourcc anywhere in the entry.
  for (let i = 8; i + 8 < entry.length; i++) {
    if (entry[i] !== 0x65 || fourcc(entry, i) !== "esds") continue;
    const end = Math.min(entry.length, i - 4 + u32(entry, i - 4));
    let o = i + 8; // skip fourcc + version/flags
    while (o + 2 < end) {
      const tag = entry[o++];
      let len = 0;
      for (let k = 0; k < 4; k++) {
        const b = entry[o++];
        len = (len << 7) | (b & 0x7f);
        if (!(b & 0x80)) break;
      }
      if (tag === 3) o += 3; // ES_ID + flags, then nested descriptors
      else if (tag === 4) o += 13; // DecoderConfigDescriptor fixed part
      else if (tag === 5) return entry.slice(o, Math.min(end, o + len));
      else o += len;
    }
  }
  return null;
}

/** Read the codec configuration of a healthy video recorded with the same device / settings. */
export async function parseReference(blob: Blob): Promise<Reference> {
  const moovBox = (await listTopBoxes(blob)).find((b) => b.type === "moov");
  if (!moovBox) throw new Error("NO_MOOV");
  if (moovBox.size > MAX_MOOV) throw new Error("MOOV_TOO_LARGE");
  return referenceFromMoov(await readBytes(blob, moovBox.start, moovBox.start + moovBox.size));
}

/** Codec configuration from the bytes of a complete moov box (header included). */
export function referenceFromMoov(buf: Uint8Array): Reference {
  const ref: Reference = { video: null, audio: null, unsupportedAudio: null };

  for (const trak of children(buf, moovHeaderSize(buf), buf.length)) {
    if (trak.type !== "trak") continue;
    const tkhd = find(buf, trak.body, trak.end, "tkhd");
    const mdia = find(buf, trak.body, trak.end, "mdia");
    if (!tkhd || !mdia) continue;
    const mdhd = find(buf, mdia.body, mdia.end, "mdhd");
    const hdlr = find(buf, mdia.body, mdia.end, "hdlr");
    const minf = find(buf, mdia.body, mdia.end, "minf");
    const stbl = minf && find(buf, minf.body, minf.end, "stbl");
    const stsd = stbl && find(buf, stbl.body, stbl.end, "stsd");
    if (!mdhd || !hdlr || !stbl || !stsd) continue;
    const handler = fourcc(buf, hdlr.body + 8);
    const timescale = u32(buf, mdhd.body + (buf[mdhd.body] === 1 ? 20 : 12));
    const sampleDelta = mostCommonDelta(buf, find(buf, stbl.body, stbl.end, "stts"));
    const entryStart = stsd.body + 8;
    if (entryStart + 16 > stsd.end) continue;
    const entryEnd = Math.min(stsd.end, entryStart + u32(buf, entryStart));
    const format = fourcc(buf, entryStart + 4);
    const entry = buf.slice(entryStart, entryEnd);

    if (handler === "vide" && !ref.video) {
      const codec: VideoCodec | null = ["avc1", "avc3"].includes(format)
        ? "h264"
        : ["hvc1", "hev1", "dvh1", "dvhe"].includes(format)
          ? "hevc"
          : null;
      if (!codec) continue;
      const cfg = find(entry, 86, entry.length, codec === "h264" ? "avcC" : "hvcC");
      if (!cfg) continue;
      const matrixAt = tkhd.body + (buf[tkhd.body] === 1 ? 52 : 40);
      ref.video = {
        codec,
        entry,
        config: entry.slice(cfg.body, cfg.end),
        width: u16(entry, 32),
        height: u16(entry, 34),
        timescale,
        sampleDelta,
        matrix: buf.slice(matrixAt, matrixAt + 36),
      };
    } else if (handler === "soun" && !ref.audio) {
      const asc = format === "mp4a" ? findAsc(entry) : null;
      if (!asc || asc.length < 2) {
        ref.unsupportedAudio ??= format;
        continue;
      }
      const objectType = asc[0] >> 3;
      const srIndex = ((asc[0] & 7) << 1) | (asc[1] >> 7);
      const channelConfig = (asc[1] >> 3) & 15;
      if (objectType === 31 || srIndex > 12 || channelConfig === 0) {
        ref.unsupportedAudio ??= format;
        continue;
      }
      ref.audio = {
        asc,
        srIndex,
        sampleRate: AAC_RATES[srIndex],
        channels: channelConfig === 7 ? 8 : channelConfig,
        timescale,
        sampleDelta: sampleDelta || 1024,
      };
    }
  }
  return ref;
}

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

class Bytes {
  private parts: Uint8Array[] = [];
  length = 0;

  raw(b: Uint8Array | number[]): this {
    const a = b instanceof Uint8Array ? b : Uint8Array.from(b);
    this.parts.push(a);
    this.length += a.length;
    return this;
  }
  u8(v: number): this {
    return this.raw([v & 255]);
  }
  u16(v: number): this {
    return this.raw([(v >> 8) & 255, v & 255]);
  }
  u32(v: number): this {
    return this.raw([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
  }
  str(s: string): this {
    return this.raw(Array.from(s, (c) => c.charCodeAt(0)));
  }
  zeros(n: number): this {
    return this.raw(new Uint8Array(n));
  }
  done(): Uint8Array {
    const out = new Uint8Array(this.length);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

function box(type: string, ...content: Uint8Array[]): Uint8Array {
  const size = 8 + content.reduce((n, c) => n + c.length, 0);
  const b = new Bytes().u32(size).str(type);
  for (const c of content) b.raw(c);
  return b.done();
}

function fullBox(type: string, flags: number, ...content: Uint8Array[]): Uint8Array {
  return box(type, new Bytes().u32(flags).done(), ...content);
}

function u32Table(values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) dv.setUint32(i * 4, values[i]);
  return out;
}

const IDENTITY_MATRIX = new Bytes().u32(0x10000).zeros(12).u32(0x10000).zeros(12).u32(0x40000000).done();

/** tkhd matrix for a clockwise rotation of 0 / 90 / 180 / 270 degrees. */
export function rotationMatrix(degrees: number, width: number, height: number): Uint8Array {
  const f = 0x10000;
  const m: Record<number, number[]> = {
    0: [f, 0, 0, f, 0, 0],
    90: [0, f, -f, 0, height * f, 0],
    180: [-f, 0, 0, -f, width * f, height * f],
    270: [0, -f, f, 0, 0, width * f],
  };
  const [a, b, c, d, x, y] = m[degrees] ?? m[0];
  const out = new Uint8Array(36);
  const dv = new DataView(out.buffer);
  [a, b, 0, c, d, 0, x, y, 0x40000000].forEach((v, i) => dv.setInt32(i * 4, v));
  return out;
}

/** VisualSampleEntry for HEVC built from scratch. */
export function buildHvc1Entry(hvcC: Uint8Array, width: number, height: number): Uint8Array {
  return visualEntry("hvc1", "hvcC", hvcC, width, height);
}

/** VisualSampleEntry for H.264 built from scratch (used when there is no reference file). */
export function buildAvc1Entry(avcC: Uint8Array, width: number, height: number): Uint8Array {
  return visualEntry("avc1", "avcC", avcC, width, height);
}

function visualEntry(format: string, configType: string, config: Uint8Array, width: number, height: number): Uint8Array {
  return box(
    format,
    new Bytes()
      .zeros(6)
      .u16(1)
      .zeros(16)
      .u16(width)
      .u16(height)
      .u32(0x480000)
      .u32(0x480000)
      .zeros(4)
      .u16(1)
      .zeros(32)
      .u16(0x18)
      .u16(0xffff)
      .done(),
    box(configType, config),
  );
}

function buildMp4aEntry(a: { asc: Uint8Array; sampleRate: number; channels: number }): Uint8Array {
  const dsi = new Bytes().u8(5).u8(a.asc.length).raw(a.asc).done();
  const dcd = new Bytes()
    .u8(4)
    .u8(13 + dsi.length)
    .u8(0x40) // MPEG-4 audio
    .u8(0x15) // audio stream
    .zeros(3)
    .u32(0)
    .u32(0)
    .raw(dsi)
    .done();
  const sl = Uint8Array.from([6, 1, 2]);
  const es = new Bytes()
    .u8(3)
    .u8(3 + dcd.length + sl.length)
    .u16(0)
    .u8(0)
    .raw(dcd)
    .raw(sl)
    .done();
  return box(
    "mp4a",
    new Bytes()
      .zeros(6)
      .u16(1)
      .zeros(8)
      .u16(a.channels)
      .u16(16)
      .zeros(4)
      .u32(a.sampleRate < 65536 ? a.sampleRate * 65536 : 0)
      .done(),
    fullBox("esds", 0, es),
  );
}

/** ISO mp4a sample entry for raw AAC. */
export function buildAacEntry(asc: Uint8Array, sampleRate: number, channels: number): Uint8Array {
  return buildMp4aEntry({ asc, sampleRate, channels });
}

/** One track of the file being written. */
export interface OutTrack {
  kind: "vide" | "soun";
  /** Complete sample entry box. */
  entry: Uint8Array;
  timescale: number;
  matrix: Uint8Array | null;
  /** Display size as 16.16 fixed point (0 for audio). */
  width: number;
  height: number;
  /** Byte position of each sample inside the media data that follows the header. */
  offsets: ArrayLike<number>;
  sizes: ArrayLike<number>;
  /** Duration of each sample in `timescale` units. */
  durations: ArrayLike<number>;
  /** Composition time offset of each sample, or null when display order equals decode order. */
  cts: ArrayLike<number> | null;
  /** Key-frame flag per sample, or null when every sample is a key frame. */
  sync: ArrayLike<number | boolean> | null;
  /** Media time presented at the start of the track (cancels the composition offset of B-frames). */
  mediaTime: number;
  /** Empty time before the first sample, in `timescale` units. */
  startDelay: number;
}

const MOVIE_TIMESCALE = 1000;

function runLength(values: ArrayLike<number>): number[] {
  const runs: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (runs.length && runs[runs.length - 1] === values[i]) runs[runs.length - 2]++;
    else runs.push(1, values[i]);
  }
  return runs;
}

function trackBox(id: number, t: OutTrack, base: number): { box: Uint8Array; seconds: number } {
  const n = t.sizes.length;
  let mediaDuration = 0;
  for (let i = 0; i < n; i++) mediaDuration += t.durations[i];
  const toMovie = (v: number) => Math.round((v / t.timescale) * MOVIE_TIMESCALE);
  const movieDuration = toMovie(mediaDuration);
  const delay = toMovie(t.startDelay);

  const stbl: Uint8Array[] = [fullBox("stsd", 0, new Bytes().u32(1).done(), t.entry)];
  const stts = runLength(t.durations);
  stbl.push(fullBox("stts", 0, new Bytes().u32(stts.length / 2).done(), u32Table(stts)));
  if (t.cts) {
    const runs = runLength(t.cts);
    const negative = runs.some((v, i) => i % 2 === 1 && v < 0);
    const table = new Uint8Array(runs.length * 4);
    const dv = new DataView(table.buffer);
    runs.forEach((v, i) => dv.setInt32(i * 4, v));
    stbl.push(box("ctts", new Bytes().u32(negative ? 0x01000000 : 0).u32(runs.length / 2).done(), table));
  }
  if (t.sync) {
    const keys: number[] = [];
    for (let i = 0; i < n; i++) if (t.sync[i]) keys.push(i + 1);
    stbl.push(fullBox("stss", 0, new Bytes().u32(keys.length).done(), u32Table(keys)));
  }

  // Consecutive samples form one chunk.
  const chunkOffsets: number[] = [];
  const stsc: number[] = [];
  let run = 0;
  let lastRun = -1;
  const flush = () => {
    if (run && run !== lastRun) {
      stsc.push(chunkOffsets.length, run, 1);
      lastRun = run;
    }
  };
  for (let i = 0; i < n; i++) {
    if (i === 0 || t.offsets[i] !== t.offsets[i - 1] + t.sizes[i - 1]) {
      flush();
      chunkOffsets.push(t.offsets[i]);
      run = 0;
    }
    run++;
  }
  flush();
  const co = new Uint8Array(chunkOffsets.length * 8);
  const cdv = new DataView(co.buffer);
  chunkOffsets.forEach((o, i) => {
    const abs = o + base;
    cdv.setUint32(i * 8, Math.floor(abs / 2 ** 32));
    cdv.setUint32(i * 8 + 4, abs >>> 0);
  });
  const sizes = new Uint8Array(n * 4);
  const sdv = new DataView(sizes.buffer);
  for (let i = 0; i < n; i++) sdv.setUint32(i * 4, t.sizes[i]);
  stbl.push(
    fullBox("stsc", 0, new Bytes().u32(stsc.length / 3).done(), u32Table(stsc)),
    fullBox("stsz", 0, new Bytes().u32(0).u32(n).done(), sizes),
    fullBox("co64", 0, new Bytes().u32(chunkOffsets.length).done(), co),
  );

  const audio = t.kind === "soun";
  const tkhd = fullBox(
    "tkhd",
    3,
    new Bytes()
      .zeros(8)
      .u32(id)
      .zeros(4)
      .u32(delay + movieDuration)
      .zeros(8)
      .u16(0)
      .u16(audio ? 1 : 0)
      .u16(audio ? 0x100 : 0)
      .u16(0)
      .raw(t.matrix ?? IDENTITY_MATRIX)
      .u32(t.width)
      .u32(t.height)
      .done(),
  );
  const edits = new Bytes().u32(delay > 0 ? 2 : 1);
  if (delay > 0) edits.u32(delay).u32(0xffffffff).u32(0x10000); // empty edit
  edits.u32(movieDuration).u32(t.mediaTime).u32(0x10000);
  const edts = box("edts", fullBox("elst", 0, edits.done()));
  const mdhd = fullBox("mdhd", 0, new Bytes().zeros(8).u32(t.timescale).u32(mediaDuration).u16(0x55c4).u16(0).done());
  const hdlr = fullBox(
    "hdlr",
    0,
    new Bytes()
      .zeros(4)
      .str(t.kind)
      .zeros(12)
      .str(audio ? "SoundHandler" : "VideoHandler")
      .u8(0)
      .done(),
  );
  const mediaHeader = audio ? fullBox("smhd", 0, new Uint8Array(4)) : fullBox("vmhd", 1, new Uint8Array(8));
  const dinf = box("dinf", fullBox("dref", 0, new Bytes().u32(1).done(), fullBox("url ", 1)));
  return {
    box: box("trak", tkhd, edts, box("mdia", mdhd, hdlr, box("minf", mediaHeader, dinf, box("stbl", ...stbl)))),
    seconds: (t.startDelay + mediaDuration) / t.timescale,
  };
}

/**
 * Build `ftyp + moov + mdat header`. The media data (dataSize bytes) is expected to follow
 * immediately, so the index sits in front of the data and the file starts playing at once.
 * `ftyp` may carry over the original file's box; otherwise a generic one is written.
 */
export function buildHeader(tracks: OutTrack[], dataSize: number, ftyp?: Uint8Array | null): Uint8Array {
  const hevc = tracks.some((t) => t.kind === "vide" && ["hvc1", "hev1"].includes(fourcc(t.entry, 4)));
  const head = ftyp ?? box("ftyp", new Bytes().str("isom").u32(0x200).str("isomiso2").str(hevc ? "hvc1" : "avc1").str("mp41").done());

  const build = (base: number): Uint8Array => {
    const traks = tracks.map((t, i) => trackBox(i + 1, t, base));
    const seconds = Math.max(0, ...traks.map((t) => t.seconds));
    const mvhd = fullBox(
      "mvhd",
      0,
      new Bytes()
        .zeros(8)
        .u32(MOVIE_TIMESCALE)
        .u32(Math.round(seconds * MOVIE_TIMESCALE))
        .u32(0x10000)
        .u16(0x100)
        .zeros(10)
        .raw(IDENTITY_MATRIX)
        .zeros(24)
        .u32(traks.length + 1)
        .done(),
    );
    return box("moov", mvhd, ...traks.map((t) => t.box));
  };

  // The chunk offsets depend on the size of the moov that contains them; its size does not
  // depend on the offsets, so build once to measure and once for real.
  const mdatHeader = 16;
  const base = head.length + build(0).length + mdatHeader;
  const moov = build(base);
  const total = dataSize + mdatHeader;
  const mdat = new Bytes()
    .u32(1)
    .str("mdat")
    .u32(Math.floor(total / 2 ** 32))
    .u32(total >>> 0)
    .done();
  return new Bytes().raw(head).raw(moov).raw(mdat).done();
}

// ---------------------------------------------------------------------------------------------
// Reading a complete index (for files whose moov survived)
// ---------------------------------------------------------------------------------------------

/**
 * Look for a moov box anywhere in the file. A damaged file header stops the normal box walk,
 * but the index itself is often intact further on (cameras write it at the very end).
 */
export async function findMoov(blob: Blob, boxes: TopBox[]): Promise<Uint8Array | null> {
  const top = boxes.find((b) => b.type === "moov");
  if (top && top.size <= MAX_MOOV && top.start + top.size <= blob.size) {
    return readBytes(blob, top.start, top.start + top.size);
  }
  // Signature search: "moov" followed by an mvhd child. Search the tail first, then the rest.
  const CHUNK = 4 * 1024 * 1024;
  const order: number[] = [];
  for (let pos = Math.max(0, blob.size - CHUNK); ; pos -= CHUNK - 16) {
    order.push(Math.max(0, pos));
    if (pos <= 0) break;
  }
  for (const pos of order) {
    const buf = await readBytes(blob, pos, pos + CHUNK);
    for (let i = 4; i + 16 <= buf.length; i++) {
      if (buf[i] !== 0x6d || buf[i + 1] !== 0x6f || buf[i + 2] !== 0x6f || buf[i + 3] !== 0x76) continue;
      if (fourcc(buf, i + 8) !== "mvhd") continue;
      const size = u32(buf, i - 4);
      const start = pos + i - 4;
      if (size < 100 || size > MAX_MOOV) continue;
      // A moov cut off by the end of the file is still worth reading: whole tracks may survive.
      return readBytes(blob, start, start + size);
    }
  }
  return null;
}

export interface InTrack {
  kind: "vide" | "soun";
  format: string;
  entry: Uint8Array;
  timescale: number;
  matrix: Uint8Array;
  width: number;
  height: number;
  offsets: Float64Array;
  sizes: Uint32Array;
  durations: Uint32Array;
  cts: Int32Array | null;
  sync: Uint8Array | null;
  mediaTime: number;
  /** Empty time before the first sample, in `timescale` units. */
  startDelay: number;
}

function readTrack(buf: Uint8Array, trak: Box, movieTimescale: number): InTrack | null {
  const tkhd = find(buf, trak.body, trak.end, "tkhd");
  const mdia = find(buf, trak.body, trak.end, "mdia");
  if (!tkhd || !mdia) return null;
  const mdhd = find(buf, mdia.body, mdia.end, "mdhd");
  const hdlr = find(buf, mdia.body, mdia.end, "hdlr");
  const minf = find(buf, mdia.body, mdia.end, "minf");
  const stbl = minf && find(buf, minf.body, minf.end, "stbl");
  if (!mdhd || !hdlr || !stbl) return null;
  const kind = fourcc(buf, hdlr.body + 8);
  if (kind !== "vide" && kind !== "soun") return null;
  const get = (type: string) => find(buf, stbl.body, stbl.end, type);
  const stsd = get("stsd");
  const stts = get("stts");
  const stsc = get("stsc");
  const stsz = get("stsz");
  const stco = get("stco");
  const co64 = get("co64");
  if (!stsd || !stts || !stsc || !stsz || !(stco || co64)) return null;

  const entryStart = stsd.body + 8;
  if (entryStart + 16 > stsd.end) return null;
  const entry = buf.slice(entryStart, Math.min(stsd.end, entryStart + u32(buf, entryStart)));
  const timescale = u32(buf, mdhd.body + (buf[mdhd.body] === 1 ? 20 : 12));
  if (!timescale) return null;

  const fixedSize = u32(buf, stsz.body + 4);
  const count = u32(buf, stsz.body + 8);
  if (count === 0 || count > 20_000_000) return null;
  if (!fixedSize && stsz.body + 12 + count * 4 > stsz.end) return null;
  const sizes = new Uint32Array(count);
  for (let i = 0; i < count; i++) sizes[i] = fixedSize || u32(buf, stsz.body + 12 + i * 4);

  // Sample offsets: chunk offsets + sample-to-chunk runs.
  const co = (stco ?? co64)!;
  const chunks = u32(buf, co.body + 4);
  if (co.body + 8 + chunks * (stco ? 4 : 8) > co.end) return null;
  const chunkOffset = (i: number) =>
    stco ? u32(buf, co.body + 8 + i * 4) : u32(buf, co.body + 8 + i * 8) * 2 ** 32 + u32(buf, co.body + 12 + i * 8);
  const runs = u32(buf, stsc.body + 4);
  if (stsc.body + 8 + runs * 12 > stsc.end || runs === 0) return null;
  const offsets = new Float64Array(count);
  let sample = 0;
  for (let r = 0; r < runs && sample < count; r++) {
    const first = u32(buf, stsc.body + 8 + r * 12) - 1;
    const perChunk = u32(buf, stsc.body + 12 + r * 12);
    const next = r + 1 < runs ? u32(buf, stsc.body + 8 + (r + 1) * 12) - 1 : chunks;
    if (perChunk === 0 || first < 0 || next > chunks) return null;
    for (let c = first; c < next && sample < count; c++) {
      let pos = chunkOffset(c);
      for (let k = 0; k < perChunk && sample < count; k++) {
        offsets[sample] = pos;
        pos += sizes[sample++];
      }
    }
  }
  if (sample < count) return null;

  const durations = new Uint32Array(count);
  const sttsCount = u32(buf, stts.body + 4);
  if (stts.body + 8 + sttsCount * 8 > stts.end) return null;
  sample = 0;
  for (let i = 0; i < sttsCount; i++) {
    const n = u32(buf, stts.body + 8 + i * 8);
    const delta = u32(buf, stts.body + 12 + i * 8);
    for (let k = 0; k < n && sample < count; k++) durations[sample++] = delta;
  }
  for (; sample < count; sample++) durations[sample] = sample ? durations[sample - 1] : 0;

  let cts: Int32Array | null = null;
  const ctts = get("ctts");
  if (ctts) {
    const n = u32(buf, ctts.body + 4);
    if (ctts.body + 8 + n * 8 > ctts.end) return null;
    cts = new Int32Array(count);
    sample = 0;
    for (let i = 0; i < n; i++) {
      const run = u32(buf, ctts.body + 8 + i * 8);
      const off = u32(buf, ctts.body + 12 + i * 8) | 0;
      for (let k = 0; k < run && sample < count; k++) cts[sample++] = off;
    }
  }

  let sync: Uint8Array | null = null;
  const stss = get("stss");
  if (stss) {
    const n = u32(buf, stss.body + 4);
    if (stss.body + 8 + n * 4 > stss.end) return null;
    sync = new Uint8Array(count);
    for (let i = 0; i < n; i++) {
      const k = u32(buf, stss.body + 8 + i * 4) - 1;
      if (k >= 0 && k < count) sync[k] = 1;
    }
  }

  // Edit list: an optional empty edit (start delay) followed by the media segment.
  let mediaTime = 0;
  let startDelay = 0;
  const edts = find(buf, trak.body, trak.end, "edts");
  const elst = edts && find(buf, edts.body, edts.end, "elst");
  if (elst) {
    const v1 = buf[elst.body] === 1;
    const n = u32(buf, elst.body + 4);
    let o = elst.body + 8;
    for (let i = 0; i < n && o + (v1 ? 20 : 12) <= elst.end; i++, o += v1 ? 20 : 12) {
      const duration = v1 ? u32(buf, o) * 2 ** 32 + u32(buf, o + 4) : u32(buf, o);
      const time = v1 ? (u32(buf, o + 8) | 0) * 2 ** 32 + u32(buf, o + 12) : u32(buf, o + 4) | 0;
      if (time < 0) {
        if (movieTimescale) startDelay += Math.round((duration / movieTimescale) * timescale);
      } else {
        mediaTime = time;
        break;
      }
    }
  }

  const v1 = buf[tkhd.body] === 1;
  const matrixAt = tkhd.body + (v1 ? 52 : 40);
  return {
    kind,
    format: fourcc(entry, 4),
    entry,
    timescale,
    matrix: buf.slice(matrixAt, matrixAt + 36),
    width: u32(buf, matrixAt + 36),
    height: u32(buf, matrixAt + 40),
    offsets,
    sizes,
    durations,
    cts,
    sync,
    mediaTime,
    startDelay,
  };
}

/** Read every video and audio track with its complete sample tables. Damaged tracks are skipped. */
export function readTracks(moov: Uint8Array): InTrack[] {
  const tracks: InTrack[] = [];
  const start = moovHeaderSize(moov);
  const mvhd = find(moov, start, moov.length, "mvhd");
  const movieTimescale = mvhd ? u32(moov, mvhd.body + (moov[mvhd.body] === 1 ? 20 : 12)) : 0;
  for (const trak of children(moov, start, moov.length)) {
    if (trak.type !== "trak") continue;
    try {
      const t = readTrack(moov, trak, movieTimescale);
      if (t) tracks.push(t);
    } catch {
      // unreadable track
    }
  }
  return tracks;
}
