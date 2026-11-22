/**
 * ファイルの先頭のバイトから、動画・画像かどうかを見分ける。
 * サーバーが名乗る種類（Content-Type）は当てにならないことがあるため、中身で確かめる。
 */

/** 流れてくるデータの先頭 n バイトだけ読み、残りは捨てる */
export async function readHead(res: Response, n: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const out = new Uint8Array(n);
  let got = 0;
  while (got < n) {
    const { done, value } = await reader.read();
    if (done) break;
    const part = value.subarray(0, n - got);
    out.set(part, got);
    got += part.byteLength;
  }
  await reader.cancel().catch(() => {});
  return out.subarray(0, got);
}

const latin1 = (b: Uint8Array) => new TextDecoder("latin1").decode(b);

/** HLS（配信形式）の目次ファイルか */
export function looksLikePlaylist(b: Uint8Array): boolean {
  return /^(?:\xef\xbb\xbf)?\s*#EXTM3U/.test(latin1(b));
}

/** 先頭のバイトが動画の形式に見えるか（MP4/MOV・WebM・MPEG-TS・HLS・FLV・AVI・DASH） */
export function looksLikeVideo(b: Uint8Array): boolean {
  if (b.length < 4) return false;
  const text = latin1(b);
  if (text.slice(4, 8) === "ftyp") return !/^(?:avif|avis|heic|heix|mif1|msf1)/.test(text.slice(8, 12)); // MP4 / MOV（AVIF・HEIC の画像は除く）
  if (/^....(moov|mdat|wide|free|skip|styp|moof|sidx)/.test(text)) return true;
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return true; // WebM / MKV
  if (b[0] === 0x47 && b.length >= 189 && b[188] === 0x47) return true; // MPEG-TS
  if (looksLikePlaylist(b)) return true;
  if (text.startsWith("OggS") || text.startsWith("FLV\x01")) return true;
  if (text.startsWith("RIFF") && text.slice(8, 12) === "AVI ") return true;
  if (/<MPD[\s>]/.test(text)) return true; // DASH
  return false;
}

/** 先頭のバイトが画像の形式に見えるか（JPEG・PNG・GIF・WebP・AVIF/HEIC・BMP） */
export function looksLikeImage(b: Uint8Array): boolean {
  if (b.length < 4) return false;
  const text = latin1(b);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;
  if (text.startsWith("\x89PNG") || text.startsWith("GIF8") || text.startsWith("BM")) return true;
  if (text.startsWith("RIFF") && text.slice(8, 12) === "WEBP") return true;
  if (text.slice(4, 8) === "ftyp" && /^(?:avif|avis|heic|heix|mif1|msf1)/.test(text.slice(8, 12))) return true;
  return false;
}
