import { mediaKey } from "./dedupe";

/**
 * 「復活したら保存」で、同じ動画かを見分けるための鍵。画面とサーバーの両方で使う。
 *
 * 一番確かなのは中身の指紋（fp ＝ "ファイルの大きさ:先頭の要約"）。
 * ただ、指紋を作る前に集めた動画や、大きさを名乗らないサーバーの動画には指紋がない。
 * そういう動画も見張れるように、次の 2 つでも見分ける：
 *   - u:… … ファイルの URL（合言葉などの違いは無視）。同じ URL で上げ直されたとき
 *   - n:… … ファイル名・題名。別の URL に上げ直されても、名前はそのままのことが多い
 */

/** 文字列から、16 文字の決まった要約を作る（暗号用ではなく、見分けるだけ） */
export function shortHash(s: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
    b ^= b >>> 15;
  }
  return a.toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

type Keyed = { kind: "image" | "video" | "embed"; src: string; pageUrl: string; fp?: string };

/** ファイルの URL から作る鍵 */
export function urlKey(item: Keyed): string {
  return `u:${shortHash(mediaKey(item))}`;
}

/** 名前として役に立たない言葉（これだけの名前は、別の動画でも同じになりやすい） */
const GENERIC_RE =
  /^(?:video|movie|mov|clip|file|download|dl|untitled|noname|output|sample|test|stream|play|player|watch|index|master|playlist|media|image|img|dsc|pxl|vid|trim|record|recording|screen|screenrecording|動画|ムービー|無題|新規|ダウンロード)?\d*$/;

/**
 * ファイル名・題名から作る鍵（見分けに使えない名前なら null）。
 * 大文字小文字・全角半角・記号・拡張子の違いは無視する
 */
export function nameKey(title: string | null | undefined): string | null {
  if (!title) return null;
  const clean = title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\.(?:mp4|m4v|mov|webm|mkv|avi|wmv|flv|ts|m3u8|3gp|mpg|mpeg|ogv)$/i, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
  if (clean.length < 6 || GENERIC_RE.test(clean) || /^\d+$/.test(clean)) return null;
  return `n:${shortHash(clean)}`;
}

/** 見張りに使う鍵（指紋があれば指紋、なければ URL の鍵） */
export function reviveKeyOf(item: Keyed): string | undefined {
  if (item.kind !== "video") return undefined;
  return item.fp || urlKey(item);
}

/** 鍵として正しい形か（指紋 "大きさ:要約"・URL の鍵・名前の鍵） */
export const isReviveKey = (k: unknown): k is string =>
  typeof k === "string" && (/^\d{1,13}:[a-z0-9]{2,40}$/.test(k) || /^[un]:[0-9a-f]{16}$/.test(k));
