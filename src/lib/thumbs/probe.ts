import "server-only";
import type { MediaItem } from "./types";
import { kindFromContentType, youtubeId } from "./extract";
import { CookieJar, FetchBlockedError, safeFetch } from "./safeFetch";
import { looksLikeImage, looksLikePlaylist, looksLikeVideo, readHead } from "./sniff";
import { durationFromHead, moovOffset, playlistDuration } from "./duration";

/**
 * リンク切れの確認。画像・動画の先頭だけ取りに行き、本当に画像・動画が返ってくるか確かめる。
 *
 * yes: 見られる / no: リンク切れ（404・断られる・サイトがない・中身が違う）/
 * unknown: 時間切れ・通信の失敗で確かめられなかった
 * 一覧には yes のものだけを出す
 */
export type LinkCheck = "yes" | "no" | "unknown";

/**
 * 確認の結果。fp は中身の指紋（ファイル全体の大きさ＋先頭の数 KB の要約）。
 * URL がまったく違っても、指紋が同じなら同じファイル（同じ動画を 2 個出さないために使う）
 */
export interface Probe {
  result: LinkCheck;
  fp?: string;
  /**
   * no のうち「ファイルがない」ではなく「こちらのサーバーが断られた」もの（401・403 など、接続を切られた）。
   * 本物のブラウザからなら見られることがあるので、ブラウザで確かめ直す目安にする
   */
  refused?: boolean;
  /** 動画の再生時間（秒）。ファイルの中に書いてあれば */
  duration?: number;
  /** 埋め込み動画のサムネイル（動画サービスが教えてくれたとき） */
  thumb?: string;
}

/** ファイルがない・中身が違う、とはっきりわかる返事 */
const goneStatus = (s: number) => s === 404 || s === 410;

/** 先頭のバイトの要約（FNV-1a 方式。同じ中身なら必ず同じ値） */
function digest(b: Uint8Array): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < b.length; i++) {
    h1 = Math.imul(h1 ^ b[i], 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ b[i] ^ (i & 0xff), 0x85ebca6b) >>> 0;
  }
  return h1.toString(36) + h2.toString(36);
}

/** 返事からファイル全体の大きさを読む（わからなければ undefined） */
function totalSize(res: Response): number | undefined {
  if (res.headers.get("content-encoding")) return undefined;
  const range = /\/(\d+)\s*$/.exec(res.headers.get("content-range") ?? "");
  if (range) return Number(range[1]);
  const length = Number(res.headers.get("content-length"));
  return res.status === 200 && length > 0 ? length : undefined;
}

/** 確認結果（同じサーバーが動いている間は使い回す。確かめられなかったものは覚えない） */
const cache = new Map<string, Promise<Probe>>();
function cached(key: string, run: () => Promise<Probe>): Promise<Probe> {
  let check = cache.get(key);
  if (!check) {
    check = run();
    cache.set(key, check);
    if (cache.size > 20000) cache.delete(cache.keys().next().value!);
    void check.then((r) => r.result === "unknown" && cache.delete(key));
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
): Promise<Probe> {
  try {
    // 動画は先頭 4 KB（MP4 なら長さ・作成日時の入った部分まで）を読んで指紋にする
    const n = kind === "video" ? 4096 : 1024;
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
      return { result: transientStatus(res.status) ? "unknown" : "no", refused: !goneStatus(res.status) };
    }
    const type = res.headers.get("content-type");
    const total = totalSize(res);
    // 「画像・動画」と名乗っていても中身が HTML（エラーページ）のサーバーがあるので、先頭のバイトで確かめる
    const head = await readHead(res, n);
    // 大きさがわかるときだけ指紋を作る（先頭だけだと、別の動画でも同じになることがあるため）
    const yes = async (): Promise<Probe> => ({
      result: "yes",
      fp: total ? `${total}:${digest(head)}` : undefined,
      duration: kind === "video" ? await readDuration(url, head, total, headers, signal, jar) : undefined,
    });
    if (kind === "video" ? looksLikeVideo(head) : looksLikeImage(head)) return yes();
    const text = new TextDecoder("latin1").decode(head).trimStart().toLowerCase();
    const isText = text.startsWith("<") || text.startsWith("{");
    if (kind === "image" && /svg/i.test(type ?? "") && text.includes("<svg")) return yes();
    // 中身が HTML だった＝エラーページや「人間か確かめる」ページ。断られた扱いにして、ブラウザで確かめ直せるようにする
    return kindFromContentType(type) === kind && !isText && head.length >= 12 ? yes() : { result: "no", refused: isText };
  } catch (err) {
    return { result: isTransient(err) ? "unknown" : "no", refused: !(err instanceof FetchBlockedError) };
  }
}

/**
 * 動画の再生時間を読む（読めなければ undefined。読めなくても確認の結果は変えない）。
 * - 先頭に長さが書いてあればそれ
 * - MP4 で長さの書いてある部分（moov）が最後にあれば、そこだけ取りに行く
 * - HLS の目次なら、断片の長さを足す（全体の目次なら、最初の画質の目次を読む）
 */
async function readDuration(
  url: string,
  head: Uint8Array,
  total: number | undefined,
  baseHeaders: Record<string, string>,
  signal: AbortSignal,
  jar: CookieJar | undefined,
): Promise<number | undefined> {
  try {
    const direct = durationFromHead(head);
    if (direct) return direct;
    const headers = { ...baseHeaders };
    if (looksLikePlaylist(head)) {
      let text = new TextDecoder().decode(head);
      let at = url;
      for (let level = 0; level < 2; level++) {
        if (!/#EXT-X-ENDLIST|#EXT-X-STREAM-INF/i.test(text) || (level === 0 && total && total > head.length)) {
          delete headers.range;
          const { res, url: got } = await safeFetch(at, { headers, timeoutMs: 6000, signal, jar });
          if (!res.ok) return undefined;
          text = new TextDecoder().decode(await readHead(res, 1024 * 1024));
          at = got;
        }
        const p = playlistDuration(text);
        if (p.duration) return p.duration;
        if (!p.variant) return undefined;
        at = new URL(p.variant, at).toString();
        text = "";
      }
      return undefined;
    }
    const off = total ? moovOffset(head, total) : null;
    if (off === null || !total) return undefined;
    headers.range = `bytes=${off}-${Math.min(total - 1, off + 4095)}`;
    const { res } = await safeFetch(url, { headers, timeoutMs: 6000, signal, jar });
    if (res.status !== 206) {
      await res.body?.cancel().catch(() => {});
      return undefined;
    }
    return durationFromHead(await readHead(res, 4096));
  } catch {
    return undefined;
  }
}

/**
 * 画像・動画ファイルのリンクが生きているか。
 * 直リンク禁止のサーバーもあるので、見つけたページを Referer として名乗る → 名乗らない、の順に試す。
 * どちらかで見られれば yes
 */
function checkFile(url: string, kind: "image" | "video", referer: string | undefined, signal: AbortSignal, jar?: CookieJar): Promise<Probe> {
  return cached(`${kind}:${url}`, async () => {
    const first = await probe(url, kind, referer, signal, jar);
    if (first.result === "yes" || !referer || signal.aborted) return first;
    const second = await probe(url, kind, undefined, signal, jar);
    if (second.result === "yes") return second;
    if (first.result === "unknown" || second.result === "unknown") return { result: "unknown" };
    return { result: "no", refused: !!(first.refused && second.refused) };
  });
}

/**
 * 埋め込み動画（YouTube・Vimeo・その他のプレーヤー）が生きているか。
 * YouTube と Vimeo は、動画の情報を返す公式の窓口（oEmbed）に聞く。削除・非公開なら 404 や 401 が返る
 */
export function checkEmbed(src: string, signal: AbortSignal): Promise<Probe> {
  return cached(`embed:${src}`, async () => {
    try {
      const yt = youtubeId(src);
      const vimeo = /player\.vimeo\.com\/video\/(\d+)/.exec(src)?.[1];
      const daily = /dailymotion\.com\/embed\/video\/([a-z0-9]+)/i.exec(src)?.[1];
      // Vimeo の oEmbed と Dailymotion の公開 API は、再生時間とサムネイルも教えてくれる
      const target = yt
        ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${yt}`)}`
        : vimeo
          ? `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(`https://vimeo.com/${vimeo}`)}`
          : daily
            ? `https://api.dailymotion.com/video/${daily}?fields=duration,thumbnail_480_url`
            : src;
      const { res } = await safeFetch(target, { timeoutMs: 8000, signal, headers: { accept: "application/json,text/html,*/*;q=0.5" } });
      let info: { duration?: unknown; thumbnail_url?: unknown; thumbnail_480_url?: unknown } = {};
      if (res.ok && (vimeo || daily)) {
        try {
          info = JSON.parse(new TextDecoder().decode(await readHead(res, 64 * 1024)));
        } catch {
          /* 形が違えば使わない */
        }
      } else await res.body?.cancel().catch(() => {});
      // 埋め込み動画は URL そのものが動画を表すので、指紋は URL にする（YouTube は動画の番号）
      if (res.ok) {
        const duration = typeof info.duration === "number" && info.duration > 0 ? info.duration : undefined;
        const thumb = [info.thumbnail_url, info.thumbnail_480_url].find((t): t is string => typeof t === "string" && /^https:\/\//.test(t));
        return { result: "yes", fp: yt ? `yt:${yt}` : vimeo ? `vimeo:${vimeo}` : `embed:${src.slice(0, 70)}`, duration, thumb };
      }
      return { result: transientStatus(res.status) ? "unknown" : "no" };
    } catch (err) {
      return { result: isTransient(err) ? "unknown" : "no" };
    }
  });
}

/** 1 件の画像・動画・埋め込み動画を確かめる */
export function checkMedia(
  item: Pick<MediaItem, "kind" | "src" | "referer" | "pageUrl" | "cookie">,
  signal: AbortSignal,
  jar?: CookieJar,
): Promise<Probe> {
  const referer = item.referer ?? item.pageUrl;
  if (item.kind === "embed") return checkEmbed(item.src, signal);
  return checkFile(item.src, item.kind, referer, signal, CookieJar.withItemCookie(jar, item.cookie));
}
