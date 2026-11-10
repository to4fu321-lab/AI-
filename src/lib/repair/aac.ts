// AAC-LC raw_data_block syntax parser.
//
// Raw AAC frames inside an MP4 carry no length field: the sizes live in the moov index that the
// broken file has lost. The only way to find where each frame ends is to walk the bitstream
// syntax (ISO/IEC 14496-3 §4.4) up to the END element. No audio is decoded here.

import { BitReader } from "./bits";
import { SCALEFACTOR_BOOK, SPECTRAL_BOOKS } from "./aacTables";

// Scalefactor band offsets (ISO/IEC 14496-3 tables 4.110 - 4.128).
const L96 = [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 64, 72, 80, 88, 96, 108, 120, 132, 144, 156, 172, 188, 212, 240, 276, 320, 384, 448, 512, 576, 640, 704, 768, 832, 896, 960, 1024];
const L64 = [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 64, 72, 80, 88, 100, 112, 124, 140, 156, 172, 192, 216, 240, 268, 304, 344, 384, 424, 464, 504, 544, 584, 624, 664, 704, 744, 784, 824, 864, 904, 944, 984, 1024];
const L48 = [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 80, 88, 96, 108, 120, 132, 144, 160, 176, 196, 216, 240, 264, 292, 320, 352, 384, 416, 448, 480, 512, 544, 576, 608, 640, 672, 704, 736, 768, 800, 832, 864, 896, 928, 1024];
const L32 = [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 80, 88, 96, 108, 120, 132, 144, 160, 176, 196, 216, 240, 264, 292, 320, 352, 384, 416, 448, 480, 512, 544, 576, 608, 640, 672, 704, 736, 768, 800, 832, 864, 896, 928, 960, 992, 1024];
const L24 = [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 52, 60, 68, 76, 84, 92, 100, 108, 116, 124, 136, 148, 160, 172, 188, 204, 220, 240, 260, 284, 308, 336, 364, 396, 432, 468, 508, 552, 600, 652, 704, 768, 832, 896, 960, 1024];
const L16 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88, 100, 112, 124, 136, 148, 160, 172, 184, 196, 212, 228, 244, 260, 280, 300, 320, 344, 368, 396, 424, 456, 492, 532, 572, 616, 664, 716, 772, 832, 896, 960, 1024];
const L8 = [0, 12, 24, 36, 48, 60, 72, 84, 96, 108, 120, 132, 144, 156, 172, 188, 204, 220, 236, 252, 268, 288, 308, 328, 348, 372, 396, 420, 448, 476, 508, 544, 580, 620, 664, 712, 764, 820, 880, 944, 1024];
const S96 = [0, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 92, 128];
const S48 = [0, 4, 8, 12, 16, 20, 28, 36, 44, 56, 68, 80, 96, 112, 128];
const S24 = [0, 4, 8, 12, 16, 20, 24, 28, 36, 44, 52, 64, 76, 92, 108, 128];
const S16 = [0, 4, 8, 12, 16, 20, 24, 28, 32, 40, 48, 60, 72, 88, 108, 128];
const S8 = [0, 4, 8, 12, 16, 20, 24, 28, 36, 44, 52, 60, 72, 88, 108, 128];

// Indexed by sampling_frequency_index (96k, 88.2k, 64k, 48k, 44.1k, 32k, 24k, 22.05k, 16k, 12k, 11.025k, 8k, 7.35k).
const SWB_LONG = [L96, L96, L64, L48, L48, L32, L24, L24, L16, L16, L16, L8, L8];
const SWB_SHORT = [S96, S96, S96, S48, S48, S48, S24, S24, S16, S16, S16, S8, S8];

export const AAC_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

interface Book {
  map: Map<number, number>;
  maxLen: number;
}

function buildBook(entries: number[]): Book {
  const map = new Map<number, number>();
  let maxLen = 0;
  for (const e of entries) {
    const len = e & 31;
    const code = (e >>> 5) & 0x7ffff;
    map.set(len * 0x80000 + code, e);
    if (len > maxLen) maxLen = len;
  }
  return { map, maxLen };
}

let spectralBooks: Book[] | null = null;
let sfBook: Book | null = null;

/** Read one Huffman codeword; returns the packed table entry or -1. */
function readCode(br: BitReader, book: Book): number {
  let code = 0;
  for (let len = 1; len <= book.maxLen; len++) {
    code = code * 2 + br.bit();
    const e = book.map.get(len * 0x80000 + code);
    if (e !== undefined) return e;
  }
  return -1;
}

interface IcsInfo {
  short: boolean;
  maxSfb: number;
  /** Number of windows in each window group. */
  groups: number[];
}

function parseIcsInfo(br: BitReader, sr: number): IcsInfo | null {
  if (br.bit() !== 0) return null; // ics_reserved_bit
  const seq = br.bits(2);
  br.bit(); // window_shape
  if (seq === 2) {
    const maxSfb = br.bits(4);
    const grouping = br.bits(7);
    const groups = [1];
    for (let i = 6; i >= 0; i--) {
      if ((grouping >> i) & 1) groups[groups.length - 1]++;
      else groups.push(1);
    }
    if (maxSfb > SWB_SHORT[sr].length - 1) return null;
    return { short: true, maxSfb, groups };
  }
  const maxSfb = br.bits(6);
  if (br.bit() !== 0) return null; // predictor_data_present: not AAC-LC
  if (maxSfb > SWB_LONG[sr].length - 1) return null;
  return { short: false, maxSfb, groups: [1] };
}

const sectCb = new Uint8Array(8 * 64);

function parseIcs(br: BitReader, sr: number, shared: IcsInfo | null): boolean {
  br.bits(8); // global_gain
  const info = shared ?? parseIcsInfo(br, sr);
  if (!info) return false;
  const { short, maxSfb, groups } = info;

  // section_data
  const lenBits = short ? 3 : 5;
  const esc = (1 << lenBits) - 1;
  for (let g = 0; g < groups.length; g++) {
    let k = 0;
    while (k < maxSfb) {
      const cb = br.bits(4);
      if (cb === 12) return false;
      let len = 0;
      for (;;) {
        const incr = br.bits(lenBits);
        len += incr;
        if (incr !== esc) break;
        if (len > maxSfb) return false;
      }
      if (len === 0 || k + len > maxSfb || br.overrun) return false;
      sectCb.fill(cb, g * 64 + k, g * 64 + k + len);
      k += len;
    }
  }

  // scale_factor_data
  let noiseFirst = true;
  for (let g = 0; g < groups.length; g++) {
    for (let sfb = 0; sfb < maxSfb; sfb++) {
      const cb = sectCb[g * 64 + sfb];
      if (cb === 0) continue;
      if (cb === 13 && noiseFirst) {
        noiseFirst = false;
        br.bits(9);
      } else if (readCode(br, sfBook!) < 0) {
        return false;
      }
    }
  }
  if (br.overrun) return false;

  // pulse_data
  if (br.bit()) {
    if (short) return false;
    const count = br.bits(2) + 1;
    if (br.bits(6) > maxSfb) return false;
    br.skip(count * 9);
  }

  // tns_data
  if (br.bit()) {
    const windows = short ? 8 : 1;
    for (let w = 0; w < windows; w++) {
      const nFilt = br.bits(short ? 1 : 2);
      if (!nFilt) continue;
      const coefRes = br.bit();
      for (let f = 0; f < nFilt; f++) {
        br.bits(short ? 4 : 6); // length
        const order = br.bits(short ? 3 : 5);
        if (order > (short ? 7 : 12)) return false;
        if (order) {
          br.bit(); // direction
          const compress = br.bit();
          br.skip(order * (coefRes + 3 - compress));
        }
      }
    }
  }

  if (br.bit()) return false; // gain_control_data_present: not AAC-LC
  if (br.overrun) return false;

  // spectral_data
  const swb = short ? SWB_SHORT[sr] : SWB_LONG[sr];
  for (let g = 0; g < groups.length; g++) {
    const windows = groups[g];
    for (let sfb = 0; sfb < maxSfb; sfb++) {
      const cb = sectCb[g * 64 + sfb];
      if (cb === 0 || cb >= 13) continue;
      const book = spectralBooks![cb - 1];
      const step = cb < 5 ? 4 : 2;
      const count = ((swb[sfb + 1] - swb[sfb]) * windows) / step;
      for (let i = 0; i < count; i++) {
        const e = readCode(br, book);
        if (e < 0) return false;
        const signBits = (e >>> 24) & 7;
        if (signBits) br.skip(signBits);
        let escapes = e >>> 27;
        while (escapes-- > 0) {
          let n = 4;
          while (br.bit()) {
            if (++n > 12) return false;
          }
          br.skip(n);
        }
      }
      if (br.overrun) return false;
    }
  }
  return !br.overrun;
}

export interface AacFrame {
  /** Frame length in bytes. */
  length: number;
  channels: number;
}

/**
 * Try to parse one raw AAC-LC frame starting at `off`.
 * Returns null unless the syntax is valid all the way to the END element.
 */
export function parseAacFrame(buf: Uint8Array, off: number, end: number, srIndex: number): AacFrame | null {
  if (!spectralBooks) {
    spectralBooks = SPECTRAL_BOOKS.map(buildBook);
    sfBook = buildBook(SCALEFACTOR_BOOK);
  }
  // Camera and phone encoders open every frame with a channel element (SCE or CPE). Accepting
  // frames that open with fill or data elements lets binary metadata pass as audio.
  if (buf[off] >> 5 > 1) return null;

  const br = new BitReader(buf, off, Math.min(end, off + 8192));
  let channels = 0;
  let seenPairs = 0;
  let seen = 0; // bit per (element type, instance tag) to catch duplicates
  for (let elements = 0; elements < 24; elements++) {
    const id = br.bits(3);
    if (br.overrun) return null;
    if (id === 7) {
      if (channels === 0) return null;
      br.alignByte();
      const length = (br.pos >> 3) - off;
      if (length > 768 * channels + 512) return null;
      return { length, channels };
    }
    switch (id) {
      case 0: // single_channel_element
      case 3: {
        // lfe_channel_element
        const bit = 1 << ((id === 0 ? 0 : 16) + br.bits(4));
        if (seen & bit) return null;
        seen |= bit;
        if (!parseIcs(br, srIndex, null)) return null;
        channels++;
        break;
      }
      case 1: {
        // channel_pair_element
        const tag = br.bits(4);
        if (seenPairs & (1 << tag)) return null;
        seenPairs |= 1 << tag;
        let shared: IcsInfo | null = null;
        if (br.bit()) {
          shared = parseIcsInfo(br, srIndex);
          if (!shared) return null;
          const msMask = br.bits(2);
          if (msMask === 3) return null;
          if (msMask === 1) br.skip(shared.groups.length * shared.maxSfb);
        }
        if (!parseIcs(br, srIndex, shared) || !parseIcs(br, srIndex, shared)) return null;
        channels += 2;
        break;
      }
      case 4: {
        // data_stream_element
        br.bits(4);
        const align = br.bit();
        let count = br.bits(8);
        if (count === 255) count += br.bits(8);
        if (align) br.alignByte();
        br.skip(count * 8);
        break;
      }
      case 5: {
        // program_config_element
        br.bits(10);
        const front = br.bits(4);
        const side = br.bits(4);
        const back = br.bits(4);
        const lfe = br.bits(2);
        const assoc = br.bits(3);
        const cc = br.bits(4);
        if (br.bit()) br.bits(4);
        if (br.bit()) br.bits(4);
        if (br.bit()) br.bits(3);
        br.skip((front + side + back) * 5 + lfe * 4 + assoc * 4 + cc * 5);
        br.alignByte();
        br.skip(br.bits(8) * 8);
        break;
      }
      case 6: {
        // fill_element (also carries SBR / PS extension payloads)
        let count = br.bits(4);
        if (count === 15) count += br.bits(8) - 1;
        br.skip(count * 8);
        break;
      }
      default:
        return null; // coupling_channel_element: not expected in camera footage
    }
    if (br.overrun || channels > 8) return null;
  }
  return null;
}
