/**
 * 動画の再生時間（秒）を、ファイルの一部だけから読む。画面とサーバーの両方で使う。
 *
 * - MP4 / MOV：ファイルの中の「moov」箱の中にある「mvhd」箱に、長さが書いてある。
 *   moov が先頭にあるファイル（ネット配信向け）なら、先頭の数 KB だけで読める。
 *   moov が最後にあるファイルは、先頭の箱の大きさを足していけば moov の場所がわかるので、そこだけ読み直す
 * - WebM / MKV：先頭近くの「Segment Info」に Duration が書いてある
 * - HLS（.m3u8）：目次に並ぶ断片の長さ（#EXTINF）を足す
 */

const u32 = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const u64 = (b: Uint8Array, i: number) => u32(b, i) * 2 ** 32 + u32(b, i + 4);
const fourcc = (b: Uint8Array, i: number) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);

/** 長さとして信じてよい値か（0 秒や 1 週間を超えるものは壊れた値） */
const sane = (s: number) => Number.isFinite(s) && s >= 0.5 && s < 7 * 24 * 3600;

/** バイト列の中から mvhd 箱を探して長さを読む */
function mvhdDuration(b: Uint8Array): number | undefined {
  for (let i = 4; i + 32 <= b.length; i++) {
    if (b[i] !== 0x6d || fourcc(b, i) !== "mvhd") continue; // "m"
    const version = b[i + 4];
    let timescale: number;
    let duration: number;
    if (version === 1) {
      if (i + 40 > b.length) return undefined;
      timescale = u32(b, i + 24);
      duration = u64(b, i + 28);
    } else {
      timescale = u32(b, i + 16);
      duration = u32(b, i + 20);
    }
    if (!timescale || duration === 0xffffffff) return undefined;
    const s = duration / timescale;
    return sane(s) ? s : undefined;
  }
  return undefined;
}

/** EBML の可変長の数（サイズ・ID の長さ）を読む */
function vint(b: Uint8Array, i: number): { len: number; value: number } | null {
  const first = b[i];
  if (first === undefined || first === 0) return null;
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || i + len > b.length) return null;
  let value = first & (0xff >> len);
  for (let k = 1; k < len; k++) value = value * 256 + b[i + k];
  return { len, value };
}

/** WebM / MKV の Duration を読む */
function webmDuration(b: Uint8Array): number | undefined {
  let scale = 1_000_000; // TimecodeScale の初期値（ナノ秒）
  let raw: number | undefined;
  for (let i = 0; i + 4 < b.length; i++) {
    // TimecodeScale: 2A D7 B1
    if (b[i] === 0x2a && b[i + 1] === 0xd7 && b[i + 2] === 0xb1) {
      const size = vint(b, i + 3);
      if (size && size.value > 0 && size.value <= 8 && i + 3 + size.len + size.value <= b.length) {
        let v = 0;
        for (let k = 0; k < size.value; k++) v = v * 256 + b[i + 3 + size.len + k];
        if (v > 0) scale = v;
      }
    }
    // Duration: 44 89（4 か 8 バイトの小数）
    if (raw === undefined && b[i] === 0x44 && b[i + 1] === 0x89) {
      const size = vint(b, i + 2);
      if (!size || (size.value !== 4 && size.value !== 8)) continue;
      const at = i + 2 + size.len;
      if (at + size.value > b.length) continue;
      const view = new DataView(b.buffer, b.byteOffset + at, size.value);
      const v = size.value === 4 ? view.getFloat32(0) : view.getFloat64(0);
      if (Number.isFinite(v) && v > 0) raw = v;
    }
  }
  if (raw === undefined) return undefined;
  const s = (raw * scale) / 1e9;
  return sane(s) ? s : undefined;
}

/** ファイルの先頭の数 KB から長さを読む（わからなければ undefined） */
export function durationFromHead(b: Uint8Array): number | undefined {
  if (b.length < 12) return undefined;
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return webmDuration(b);
  return mvhdDuration(b);
}

/**
 * MP4 の先頭の箱をたどって、moov 箱が始まる位置を返す（先頭で読めた場合・MP4 でない場合は null）。
 * moov が最後にあるファイルで、そこだけ読み直すのに使う
 */
export function moovOffset(b: Uint8Array, total: number): number | null {
  if (b.length < 12 || fourcc(b, 4) !== "ftyp") return null;
  let at = 0;
  for (let n = 0; n < 50; n++) {
    if (at + 8 > b.length) return at < total ? at : null;
    let size = u32(b, at);
    const type = fourcc(b, at + 4);
    if (type === "moov") return null; // 先頭にあるので、もう読んである
    if (size === 1) {
      if (at + 16 > b.length) return null;
      size = u64(b, at + 8);
    } else if (size === 0) return null; // 最後まで続く箱（moov はない）
    if (size < 8) return null;
    at += size;
    if (at >= total) return null;
  }
  return null;
}

/** 秒数を「1:02:03」「12:34」の形にする */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** 「12:34」「1:02:03」を秒数にする */
export function parseClock(text: string): number | undefined {
  const m = /(?:^|[^\d:])(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?=$|[^\d:])/.exec(text);
  if (!m) return undefined;
  const s = Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return Number(m[3]) < 60 && sane(s) ? s : undefined;
}

/** ISO 8601 の長さ（PT1H2M3S、構造化データの duration）や、ただの秒数を秒数にする */
export function parseIsoDuration(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const t = text.trim();
  if (/^\d+(?:\.\d+)?$/.test(t)) {
    const s = Number(t);
    return sane(s) ? s : undefined;
  }
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(t);
  if (!m) return parseClock(t);
  const s = Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
  return sane(s) ? s : undefined;
}

/**
 * HLS の目次の長さ。最後まで決まっている配信（#EXT-X-ENDLIST）のときだけ、断片の長さを足して返す。
 * 全体の目次（画質ごとの目次の一覧）なら、最初の画質の目次の URL を返す
 */
export function playlistDuration(text: string): { duration?: number; variant?: string } {
  if (/#EXT-X-STREAM-INF/i.test(text)) {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!/^#EXT-X-STREAM-INF/i.test(lines[i])) continue;
      for (let k = i + 1; k < lines.length; k++) {
        const line = lines[k].trim();
        if (line && !line.startsWith("#")) return { variant: line };
      }
    }
    return {};
  }
  if (!/#EXT-X-ENDLIST/i.test(text)) return {};
  let total = 0;
  for (const m of text.matchAll(/#EXTINF:\s*([\d.]+)/gi)) total += Number(m[1]) || 0;
  return sane(total) ? { duration: total } : {};
}
