import "server-only";
import type { MediaItem } from "./types";
import { kindFromContentType, youtubeId } from "./extract";
import { type CookieJar, FetchBlockedError, safeFetch } from "./safeFetch";
import { looksLikeImage, looksLikeVideo, readHead } from "./sniff";

/**
 * リンク切れの確認。画像・動画の先頭だけ取りに行き、本当に画像・動画が返ってくるか確かめる。
 *
 * yes: 見られる / no: リンク切れ（404・断られる・サイトがない・中身が違う）/
 * unknown: 時間切れ・通信の失敗で確かめられなかった
 * 一覧には yes のものだけを出す
 */
export type LinkCheck = "yes" | "no" | "unknown";

/** 確認結果（同じサーバーが動いている間は使い回す。確かめられなかったものは覚えない） */
const cache = new Map<string, Promise<LinkCheck>>();
function cached(key: string, run: () => Promise<LinkCheck>): Promise<LinkCheck> {
  let check = cache.get(key);
  if (!check) {
    check = run();
    cache.set(key, check);
    if (cache.size > 20000) cache.delete(cache.keys().next().value!);
    void check.then((r) => r === "unknown" && cache.delete(key));
  }
  return check;
}

/** 時間切れ・一時的な通信の失敗か（それ以外のエラーはリンク切れ扱い） */
function isTransient(err: unknown): boolean {
  if (err instanceof FetchBlockedError) return false;
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return true;
  const code = (err as { cause?: { code?: string } })?.cause?.code;
  return !!code && !["ENOTFOUND", "ECONNREFUSED", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "DEPTH_ZERO_SELF_SIGNED_CERT"].includes(code);
}

/** 返事が「一時的な不調」か（少し待てば直るかもしれない） */
const transientStatus = (s: number) => s === 408 || s === 429 || s === 502 || s === 503 || s === 504;

async function probe(
  url: string,
  kind: "image" | "video",
  referer: string | undefined,
  signal: AbortSignal,
  jar: CookieJar | undefined,
): Promise<LinkCheck> {
  try {
    const n = kind === "video" ? 376 : 64;
    const headers: Record<string, string> = { range: `bytes=0-${n - 1}`, accept: kind === "video" ? "video/*,*/*;q=0.5" : "image/*,*/*;q=0.5" };
    if (referer) headers.referer = referer;
    let { res } = await safeFetch(url, { headers, timeoutMs: 8000, signal, jar });
    if (res.status !== 200 && res.status !== 206 && res.status !== 404 && res.status !== 410) {
      // ダウンロード用の仕組み（download.php など）には、部分取得（Range）を頼むとエラーを返すものがある。頼まずに読み直す
      await res.body?.cancel().catch(() => {});
      delete headers.range;
      ({ res } = await safeFetch(url, { headers, timeoutMs: 8000, signal, jar }));
    }
    if (res.status !== 200 && res.status !== 206) {
      await res.body?.cancel().catch(() => {});
      return transientStatus(res.status) ? "unknown" : "no";
    }
    const type = res.headers.get("content-type");
    // 「画像・動画」と名乗っていても中身が HTML（エラーページ）のサーバーがあるので、先頭のバイトで確かめる
    const head = await readHead(res, n);
    if (kind === "video" ? looksLikeVideo(head) : looksLikeImage(head)) return "yes";
    const text = new TextDecoder("latin1").decode(head).trimStart().toLowerCase();
    const isText = text.startsWith("<") || text.startsWith("{");
    if (kind === "image" && /svg/i.test(type ?? "") && text.includes("<svg")) return "yes";
    return kindFromContentType(type) === kind && !isText && head.length >= 12 ? "yes" : "no";
  } catch (err) {
    return isTransient(err) ? "unknown" : "no";
  }
}

/**
 * 画像・動画ファイルのリンクが生きているか。
 * 直リンク禁止のサーバーもあるので、見つけたページを Referer として名乗る → 名乗らない、の順に試す。
 * どちらかで見られれば yes
 */
function checkFile(url: string, kind: "image" | "video", referer: string | undefined, signal: AbortSignal, jar?: CookieJar): Promise<LinkCheck> {
  return cached(`${kind}:${url}`, async () => {
    const first = await probe(url, kind, referer, signal, jar);
    if (first === "yes" || !referer || signal.aborted) return first;
    const second = await probe(url, kind, undefined, signal, jar);
    return second === "yes" ? "yes" : first === "unknown" || second === "unknown" ? "unknown" : "no";
  });
}

export function checkVideo(url: string, referer: string | undefined, signal: AbortSignal, jar?: CookieJar): Promise<LinkCheck> {
  return checkFile(url, "video", referer, signal, jar);
}

export function checkImage(url: string, referer: string | undefined, signal: AbortSignal, jar?: CookieJar): Promise<LinkCheck> {
  return checkFile(url, "image", referer, signal, jar);
}

/**
 * 埋め込み動画（YouTube・Vimeo・その他のプレーヤー）が生きているか。
 * YouTube と Vimeo は、動画の情報を返す公式の窓口（oEmbed）に聞く。削除・非公開なら 404 や 401 が返る
 */
export function checkEmbed(src: string, signal: AbortSignal): Promise<LinkCheck> {
  return cached(`embed:${src}`, async () => {
    try {
      const yt = youtubeId(src);
      const vimeo = /player\.vimeo\.com\/video\/(\d+)/.exec(src)?.[1];
      const target = yt
        ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${yt}`)}`
        : vimeo
          ? `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(`https://vimeo.com/${vimeo}`)}`
          : src;
      const { res } = await safeFetch(target, { timeoutMs: 8000, signal, headers: { accept: "application/json,text/html,*/*;q=0.5" } });
      await res.body?.cancel().catch(() => {});
      if (res.ok) return "yes";
      return transientStatus(res.status) ? "unknown" : "no";
    } catch (err) {
      return isTransient(err) ? "unknown" : "no";
    }
  });
}

/** 1 件の画像・動画・埋め込み動画を確かめる */
export function checkMedia(item: Pick<MediaItem, "kind" | "src" | "referer" | "pageUrl">, signal: AbortSignal, jar?: CookieJar): Promise<LinkCheck> {
  const referer = item.referer ?? item.pageUrl;
  if (item.kind === "embed") return checkEmbed(item.src, signal);
  return checkFile(item.src, item.kind, referer, signal, jar);
}
