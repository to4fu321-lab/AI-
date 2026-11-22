import "server-only";
import { kindFromContentType, youtubeId } from "./extract";
import { FetchBlockedError, safeFetch } from "./safeFetch";
import { looksLikeVideo, readHead } from "./sniff";

/**
 * リンク切れの確認。動画の先頭だけ取りに行き、本当に動画が返ってくるか確かめる。
 *
 * yes: 動画が返ってきた / no: リンク切れ（404・サイトがない・中身が動画ではない）/
 * unknown: 断られた・時間切れなどで確かめられなかった（手元の端末からは見られるかもしれない）
 */
export type LinkCheck = "yes" | "no" | "unknown";

/** 確認結果（同じサーバーが動いている間は使い回す） */
const cache = new Map<string, Promise<LinkCheck>>();
function cached(key: string, run: () => Promise<LinkCheck>): Promise<LinkCheck> {
  let check = cache.get(key);
  if (!check) {
    check = run();
    cache.set(key, check);
    if (cache.size > 5000) cache.delete(cache.keys().next().value!);
    // 確かめられなかったものは覚えない（次に聞かれたらもう一度試す）
    void check.then((r) => r === "unknown" && cache.delete(key));
  }
  return check;
}

/** サイトそのものがない・つながらないときのエラーか */
function isGone(err: unknown): boolean {
  if (err instanceof FetchBlockedError) return /見つかりません/.test(err.message);
  const code = (err as { cause?: { code?: string } })?.cause?.code;
  return code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "EAI_AGAIN";
}

async function probeVideo(url: string, referer: string | undefined, signal: AbortSignal): Promise<LinkCheck> {
  try {
    const headers: Record<string, string> = { range: "bytes=0-375", accept: "video/*,*/*;q=0.5" };
    if (referer) headers.referer = referer;
    const { res } = await safeFetch(url, { headers, timeoutMs: 5000, signal });
    if (res.status !== 200 && res.status !== 206) {
      await res.body?.cancel().catch(() => {});
      return res.status === 404 || res.status === 410 ? "no" : "unknown";
    }
    const type = res.headers.get("content-type");
    // 「動画」と名乗っていても中身が HTML のサーバーがあるので、先頭のバイトで確かめる
    const head = await readHead(res, 376);
    if (looksLikeVideo(head)) return "yes";
    const text = new TextDecoder("latin1").decode(head).trimStart().toLowerCase();
    const isText = text.startsWith("<") || text.startsWith("{");
    return kindFromContentType(type) === "video" && !isText && head.length >= 16 ? "yes" : "no";
  } catch (err) {
    return isGone(err) ? "no" : "unknown";
  }
}

/**
 * 動画ファイルのリンクが生きているか。
 * 直リンク禁止のサーバーもあるので、まず見つけたページ（プレーヤー）を Referer として名乗り、
 * 断られたら Referer なしでもう一度試す
 */
export function checkVideo(url: string, referer: string | undefined, signal: AbortSignal): Promise<LinkCheck> {
  return cached(url, () =>
    probeVideo(url, referer, signal).then((first) => (first === "unknown" && referer && !signal.aborted ? probeVideo(url, undefined, signal) : first)),
  );
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
      const { res } = await safeFetch(target, { timeoutMs: 5000, signal, headers: { accept: "application/json,text/html,*/*;q=0.5" } });
      await res.body?.cancel().catch(() => {});
      if (res.ok) return "yes";
      const dead = yt || vimeo ? [400, 401, 404, 410] : [404, 410];
      return dead.includes(res.status) ? "no" : "unknown";
    } catch (err) {
      return isGone(err) ? "no" : "unknown";
    }
  });
}
