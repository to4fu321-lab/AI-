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
  if (moovBox.size > 512 * 1024 * 1024) throw new Error("MOOV_TOO_LARGE");
  const buf = await readBytes(blob, moovBox.start, moovBox.start + moovBox.size);
  const ref: Reference = { video: null, audio: null, unsupportedAudio: null };

  for (const trak of children(buf, moovBox.headerSize, buf.length)) {
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

/** VisualSampleEntry for H.264 built from scratch (used when there is no reference file). */
export function buildAvc1Entry(avcC: Uint8Array, width: number, height: number): Uint8Array {
  return box(
    "avc1",
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
    box("avcC", avcC),
  );
}

function buildMp4aEntry(a: MuxAudio): Uint8Array {
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

export interface MuxVideo {
  codec: VideoCodec;
  entry: Uint8Array;
  width: number;
  height: number;
  timescale: number;
  sampleDelta: number;
  matrix: Uint8Array | null;
  /** Sample positions relative to the start of the recovered media data. */
  offsets: number[];
  sizes: number[];
  keys: boolean[];
  /** Composition offset per sample in frames (display index − decode index), or null. */
  reorder: number[] | null;
}

export interface MuxAudio {
  asc: Uint8Array;
  sampleRate: number;
  channels: number;
  timescale: number;
  sampleDelta: number;
  offsets: number[];
  sizes: number[];
}

const MOVIE_TIMESCALE = 1000;

function sampleTables(offsets: number[], sizes: number[], base: number): Uint8Array[] {
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
  for (let i = 0; i < offsets.length; i++) {
    if (i === 0 || offsets[i] !== offsets[i - 1] + sizes[i - 1]) {
      flush();
      chunkOffsets.push(offsets[i]);
      run = 0;
    }
    run++;
  }
  flush();

  const co = new Uint8Array(chunkOffsets.length * 8);
  const dv = new DataView(co.buffer);
  chunkOffsets.forEach((o, i) => {
    const abs = o + base;
    dv.setUint32(i * 8, Math.floor(abs / 2 ** 32));
    dv.setUint32(i * 8 + 4, abs >>> 0);
  });
  return [
    fullBox("stsc", 0, new Bytes().u32(stsc.length / 3).done(), u32Table(stsc)),
    fullBox("stsz", 0, new Bytes().u32(0).u32(sizes.length).done(), u32Table(sizes)),
    fullBox("co64", 0, new Bytes().u32(chunkOffsets.length).done(), co),
  ];
}

function trak(
  id: number,
  kind: "vide" | "soun",
  timescale: number,
  mediaDuration: number,
  matrix: Uint8Array,
  width: number,
  height: number,
  mediaTime: number,
  stbl: Uint8Array,
): Uint8Array {
  const movieDuration = Math.round((mediaDuration / timescale) * MOVIE_TIMESCALE);
  const tkhd = fullBox(
    "tkhd",
    3,
    new Bytes()
      .zeros(8)
      .u32(id)
      .zeros(4)
      .u32(movieDuration)
      .zeros(8)
      .u16(0)
      .u16(kind === "soun" ? 1 : 0)
      .u16(kind === "soun" ? 0x100 : 0)
      .u16(0)
      .raw(matrix)
      .u32(width * 65536)
      .u32(height * 65536)
      .done(),
  );
  const edts = box("edts", fullBox("elst", 0, new Bytes().u32(1).u32(movieDuration).u32(mediaTime).u32(0x10000).done()));
  const mdhd = fullBox("mdhd", 0, new Bytes().zeros(8).u32(timescale).u32(mediaDuration).u16(0x55c4).u16(0).done());
  const hdlr = fullBox(
    "hdlr",
    0,
    new Bytes()
      .zeros(4)
      .str(kind)
      .zeros(12)
      .str(kind === "vide" ? "VideoHandler" : "SoundHandler")
      .u8(0)
      .done(),
  );
  const mediaHeader = kind === "vide" ? fullBox("vmhd", 1, new Uint8Array(8)) : fullBox("smhd", 0, new Uint8Array(4));
  const dinf = box("dinf", fullBox("dref", 0, new Bytes().u32(1).done(), fullBox("url ", 1)));
  return box("trak", tkhd, edts, box("mdia", mdhd, hdlr, box("minf", mediaHeader, dinf, stbl)));
}

/**
 * Build `ftyp + moov + mdat header`. The recovered media data (dataSize bytes) is expected to
 * follow immediately, so the index sits in front of the data and the file starts playing at once.
 */
export function buildHeader(video: MuxVideo, audio: MuxAudio | null, dataSize: number): Uint8Array {
  const ftyp = box("ftyp", new Bytes().str("isom").u32(0x200).str("isomiso2").str(video.codec === "h264" ? "avc1" : "hvc1").str("mp41").done());

  const build = (base: number): Uint8Array => {
    const n = video.sizes.length;
    const vStbl: Uint8Array[] = [
      fullBox("stsd", 0, new Bytes().u32(1).done(), video.entry),
      fullBox("stts", 0, new Bytes().u32(1).u32(n).u32(video.sampleDelta).done()),
    ];
    let shift = 0;
    if (video.reorder) {
      for (const r of video.reorder) if (-r > shift) shift = -r;
      const runs: number[] = [];
      for (let i = 0; i < n; i++) {
        const off = (video.reorder[i] + shift) * video.sampleDelta;
        if (runs.length && runs[runs.length - 1] === off) runs[runs.length - 2]++;
        else runs.push(1, off);
      }
      vStbl.push(fullBox("ctts", 0, new Bytes().u32(runs.length / 2).done(), u32Table(runs)));
    }
    const keys: number[] = [];
    video.keys.forEach((k, i) => k && keys.push(i + 1));
    vStbl.push(fullBox("stss", 0, new Bytes().u32(keys.length).done(), u32Table(keys)));
    vStbl.push(...sampleTables(video.offsets, video.sizes, base));

    const vDuration = n * video.sampleDelta;
    const traks = [
      trak(1, "vide", video.timescale, vDuration, video.matrix ?? IDENTITY_MATRIX, video.width, video.height, shift * video.sampleDelta, box("stbl", ...vStbl)),
    ];
    let seconds = vDuration / video.timescale;
    if (audio && audio.sizes.length) {
      const aDuration = audio.sizes.length * audio.sampleDelta;
      seconds = Math.max(seconds, aDuration / audio.timescale);
      const aStbl = box(
        "stbl",
        fullBox("stsd", 0, new Bytes().u32(1).done(), buildMp4aEntry(audio)),
        fullBox("stts", 0, new Bytes().u32(1).u32(audio.sizes.length).u32(audio.sampleDelta).done()),
        ...sampleTables(audio.offsets, audio.sizes, base),
      );
      traks.push(trak(2, "soun", audio.timescale, aDuration, IDENTITY_MATRIX, 0, 0, 0, aStbl));
    }
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
    return box("moov", mvhd, ...traks);
  };

  // The chunk offsets depend on the size of the moov that contains them; its size does not
  // depend on the offsets, so build once to measure and once for real.
  const mdatHeader = 16;
  const base = ftyp.length + build(0).length + mdatHeader;
  const moov = build(base);
  const total = dataSize + mdatHeader;
  const mdat = new Bytes()
    .u32(1)
    .str("mdat")
    .u32(Math.floor(total / 2 ** 32))
    .u32(total >>> 0)
    .done();
  return new Bytes().raw(ftyp).raw(moov).raw(mdat).done();
}
