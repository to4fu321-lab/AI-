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
/**
 * PNG の印（先頭 8 バイト）。TextDecoder の "latin1" は実は Windows-1252 なので、
 * 0x89 が「‰」になってしまい、文字で "\x89PNG" と比べても一致しない。バイトのまま比べる
 */
const isPng = (b: Uint8Array) => b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

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
  if (b[0] === 0x30 && b[1] === 0x26 && b[2] === 0xb2 && b[3] === 0x75) return true; // WMV / ASF
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && (b[3] === 0xba || b[3] === 0xb3)) return true; // MPEG-1/2（.mpg）
  return false;
}

/**
 * 先頭のバイトから、正しい「中身の種類」（Content-Type）を決める。わからなければ null。
 * サーバーが「ダウンロード用」（application/force-download など）と名乗っていても、
 * ブラウザで再生できるように正しい種類を名乗り直すために使う
 */
export function mediaMime(b: Uint8Array): string | null {
  if (b.length < 4) return null;
  const text = latin1(b);
  if (text.slice(4, 8) === "ftyp") {
    const brand = text.slice(8, 12);
    if (/^(?:avif|avis)/.test(brand)) return "image/avif";
    if (/^(?:heic|heix|mif1|msf1)/.test(brand)) return "image/heic";
    if (brand === "qt  ") return "video/quicktime";
    if (/^3g/.test(brand)) return "video/3gpp";
    return "video/mp4";
  }
  if (/^....(moov|mdat|wide|free|skip|styp|moof|sidx)/.test(text)) return "video/mp4";
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return /matroska/.test(text) ? "video/x-matroska" : "video/webm";
  if (b[0] === 0x47 && b.length >= 189 && b[188] === 0x47) return "video/mp2t";
  if (looksLikePlaylist(b)) return "application/vnd.apple.mpegurl";
  if (text.startsWith("OggS")) return "video/ogg";
  if (text.startsWith("FLV\x01")) return "video/x-flv";
  if (text.startsWith("RIFF") && text.slice(8, 12) === "AVI ") return "video/x-msvideo";
  if (/<MPD[\s>]/.test(text)) return "application/dash+xml";
  if (b[0] === 0x30 && b[1] === 0x26 && b[2] === 0xb2 && b[3] === 0x75) return "video/x-ms-asf";
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && (b[3] === 0xba || b[3] === 0xb3)) return "video/mpeg";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (isPng(b)) return "image/png";
  if (text.startsWith("GIF8")) return "image/gif";
  if (text.startsWith("RIFF") && text.slice(8, 12) === "WEBP") return "image/webp";
  if (text.startsWith("BM")) return "image/bmp";
  return null;
}

/**
 * サーバーが名乗った種類が「中身を表していない」か
 * （ダウンロードさせるための指定・何でもありの指定など。この場合は中身を見て決める）
 */
export function isVagueType(type: string | null): boolean {
  const t = (type ?? "").split(";")[0].trim().toLowerCase();
  return (
    !t ||
    /octet-stream|force-download|x-download|^application\/download$|^application\/binary$|^application\/unknown$|^application\/x-unknown|^application\/save|^application\/file$|^text\/plain$|^content\/unknown$/.test(t)
  );
}

/** 先頭のバイトが画像の形式に見えるか（JPEG・PNG・GIF・WebP・AVIF/HEIC・BMP） */
export function looksLikeImage(b: Uint8Array): boolean {
  if (b.length < 4) return false;
  const text = latin1(b);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;
  if (isPng(b) || text.startsWith("GIF8") || text.startsWith("BM")) return true;
  if (text.startsWith("RIFF") && text.slice(8, 12) === "WEBP") return true;
  if (text.slice(4, 8) === "ftyp" && /^(?:avif|avis|heic|heix|mif1|msf1)/.test(text.slice(8, 12))) return true;
  return false;
}
