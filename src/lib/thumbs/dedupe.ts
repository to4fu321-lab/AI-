import type { MediaItem } from "./types";

/**
 * 同じ動画を 2 個出さないための見分け方。画面とサーバーの両方で使う。
 *
 * 同じ動画でも URL が少しずつ違うことがある：
 *   - 期限付きの合言葉などが後ろに付く（a.mp4?token=1 と a.mp4?token=2）
 *   - 画質や形式ごとにファイルが分かれている（a_720p.mp4・a_480p.mp4・a/master.m3u8）
 *   - 配信元が違う（cdn1 と cdn2）
 */

const VIDEO_EXT_RE = /\.(?:mp4|m4v|mov|webm|ogv|m3u8|mpd)$/i;
/** 画質・形式を表す言葉（ファイル名からこれを除いた残りが同じなら、同じ動画） */
const VARIANT_RE =
  /(?:^|[_\-. ])(?:(?:240|360|480|540|720|1080|1440|2160)p?|4k|hd|sd|fhd|uhd|hq|lq|low|high|mid|medium|mobile|h264|h265|hevc|avc|hls|mp4|master|index|playlist|manifest|chunklist|video|stream)(?=$|[_\-. ])/gi;

/** 期限・署名・画質など、動画そのものを区別しない「?」より後ろの項目名 */
const TOKEN_PARAM_RE =
  /^(?:token|tok|t|e|exp|expires?|expiry|sig|sign|signature|hash|h|md5|key|auth|st|s|ts|time|ttl|validfrom|validto|hmac|policy|key-pair-id|x-amz-.*|x-goog-.*|rnd|rand|random|_|cb|v|ver|br|rate|bitrate|ip|sid|session|nonce|secure|hdnts|hdnea|verify|wssecret|wstime|download|dl|start|end|range)$/i;

/**
 * 「?」より後ろのうち、動画を区別している項目だけを残す（id=3 など）。
 * 合言葉らしいもの（決まった項目名、長い英数字の列、時刻の数字）は捨てる
 */
function meaningfulQuery(u: URL): string {
  const kept: string[] = [];
  for (const [name, value] of u.searchParams) {
    if (TOKEN_PARAM_RE.test(name) || /^[\w\-+/=%.~]{16,}$/.test(value) || /^1\d{9,12}$/.test(value)) continue;
    kept.push(`${name}=${value}`);
  }
  return kept.length ? `?${kept.sort().join("&")}` : "";
}

type Keyed = Pick<MediaItem, "kind" | "src" | "pageUrl">;

/** ファイルそのものを表すキー。動画ファイルなら、合言葉の違いと http/https の違いを無視する */
export function mediaKey(item: Keyed): string {
  if (item.kind !== "video") return item.src;
  try {
    const u = new URL(item.src);
    const path = u.pathname.replace(/\/+$/, "");
    return VIDEO_EXT_RE.test(path) ? `${u.host.toLowerCase()}${path}${meaningfulQuery(u)}` : item.src;
  } catch {
    return item.src;
  }
}

/**
 * 「同じページの中の、同じ動画の画質・形式違い」を表すキー（見分けられないときは null）。
 * ファイル名から拡張子と画質の言葉を除いた残り。何も残らなければ、上のフォルダ名を使う
 */
export function variantKey(item: Keyed): string | null {
  if (item.kind !== "video") return null;
  try {
    const u = new URL(item.src);
    const parts = u.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    const file = parts.pop() ?? "";
    if (!VIDEO_EXT_RE.test(file)) return null;
    const clean = (s: string) => {
      let out = s;
      for (let i = 0; i < 4; i++) {
        const next = out.replace(VARIANT_RE, "");
        if (next === out) break;
        out = next;
      }
      return out.replace(/^[_\-. ]+|[_\-. ]+$/g, "").toLowerCase();
    };
    let stem = clean(decodeURIComponent(file.replace(VIDEO_EXT_RE, "")));
    for (let up = 0; !stem && up < 2 && parts.length; up++) stem = clean(decodeURIComponent(parts.pop()!));
    return stem ? `${item.pageUrl}\n${stem}${meaningfulQuery(u)}` : null;
  } catch {
    return null;
  }
}

/** すでに出したものを覚えておき、同じ動画かどうかを答える */
export class SeenMedia {
  private keys = new Set<string>();
  constructor(items: Keyed[] = []) {
    for (const i of items) this.add(i);
  }
  has(item: Keyed): boolean {
    const v = variantKey(item);
    return this.keys.has(mediaKey(item)) || (!!v && this.keys.has(v));
  }
  add(item: Keyed) {
    this.keys.add(mediaKey(item));
    const v = variantKey(item);
    if (v) this.keys.add(v);
  }
}

/** 並び順はそのままで、同じ動画の 2 個目以降を除く */
export function dedupeMedia<T extends Keyed>(items: T[]): T[] {
  const seen = new SeenMedia();
  return items.filter((i) => {
    if (seen.has(i)) return false;
    seen.add(i);
    return true;
  });
}
