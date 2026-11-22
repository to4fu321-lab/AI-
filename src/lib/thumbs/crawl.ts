import "server-only";
import { extractFromHtml, formatOf, isPageLikeUrl, kindFromContentType, kindFromUrl } from "./extract";
import { RenderDeferred, renderPage, type NetworkMedia } from "./render";
import { safeFetch } from "./safeFetch";
import type { CrawlEvent, CrawlOptions, CrawlState, MediaItem, QueueItem } from "./types";

/**
 * 入力 URL から「同じサイトの、同じ階層より下」のページを幅優先で辿り、メディアを集める。
 * 結果はページを読むたびに少しずつ yield する（画面に順次出すため）。
 */

const MAX_HTML_BYTES = 3 * 1024 * 1024;
const CONCURRENCY = 6;

/** 入力 URL の「階層」。/gallery/page.html → /gallery/ 、/gallery → /gallery/ */
export function scopeOf(url: URL): string {
  let path = url.pathname;
  const last = path.split("/").pop() ?? "";
  if (last.includes(".")) path = path.slice(0, path.length - last.length);
  return path.endsWith("/") ? path : `${path}/`;
}

function inScope(candidate: string, origin: string, scope: string, startPath: string): boolean {
  try {
    const u = new URL(candidate);
    if (u.origin !== origin) return false;
    return u.pathname === startPath || u.pathname.startsWith(scope) || `${u.pathname}/` === scope;
  } catch {
    return false;
  }
}

/** 同じページを別 URL で二重に読まないための正規化 */
function normalizePageUrl(url: string): string {
  const u = new URL(url);
  u.hash = "";
  for (const key of [...u.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|ref$|ref_src)/.test(key)) u.searchParams.delete(key);
  }
  if (u.pathname !== "/" && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

async function readLimited(res: Response, limit: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  const buf = new Uint8Array(Math.min(size, limit));
  let offset = 0;
  for (const c of chunks) {
    const part = c.subarray(0, Math.min(c.byteLength, buf.byteLength - offset));
    buf.set(part, offset);
    offset += part.byteLength;
    if (offset >= buf.byteLength) break;
  }
  const charset = /charset=([\w-]+)/i.exec(res.headers.get("content-type") ?? "")?.[1];
  const sniff = new TextDecoder("latin1").decode(buf.subarray(0, 2048));
  const metaCharset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(sniff)?.[1];
  try {
    return new TextDecoder(charset || metaCharset || "utf-8").decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

/** robots.txt の「User-agent: *」の Disallow を守る（行儀のよいクローラーにするため） */
async function loadRobots(origin: string, signal: AbortSignal): Promise<(path: string) => boolean> {
  try {
    const { res } = await safeFetch(`${origin}/robots.txt`, { timeoutMs: 5000, signal });
    if (!res.ok) return () => true;
    const text = await readLimited(res, 256 * 1024);
    const disallow: string[] = [];
    const allow: string[] = [];
    let applies = false;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.replace(/#.*/, "").trim();
      const m = /^([\w-]+)\s*:\s*(.*)$/.exec(line);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const value = m[2].trim();
      if (key === "user-agent") applies = value === "*";
      else if (applies && key === "disallow" && value) disallow.push(value);
      else if (applies && key === "allow" && value) allow.push(value);
    }
    const matches = (path: string, rule: string) => {
      const re = new RegExp(
        "^" + rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"),
      );
      return re.test(path);
    };
    return (path) => {
      const a = Math.max(-1, ...allow.filter((r) => matches(path, r)).map((r) => r.length));
      const d = Math.max(-1, ...disallow.filter((r) => matches(path, r)).map((r) => r.length));
      return d < 0 || a >= d;
    };
  } catch {
    return () => true;
  }
}

async function readHead(res: Response, n: number): Promise<Uint8Array> {
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

/** 先頭のバイトが動画の形式に見えるか（MP4/MOV・WebM・MPEG-TS・HLS） */
function looksLikeVideo(b: Uint8Array): boolean {
  if (b.length < 4) return false;
  const text = new TextDecoder("latin1").decode(b);
  if (text.slice(4, 8) === "ftyp" || /^....(moov|mdat|wide|free|skip)/.test(text)) return true; // MP4 / MOV
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return true; // WebM / MKV
  if (b[0] === 0x47 && (b.length < 189 || b[188] === 0x47)) return true; // MPEG-TS
  if (text.startsWith("#EXTM3U")) return true; // HLS
  if (text.startsWith("OggS")) return true;
  return false;
}

/** 動画ファイルかどうかの確認結果（同じ実行中は使い回す） */
const videoCheckCache = new Map<string, Promise<boolean>>();

/** 先頭 2 バイトだけ取りに行き、本当に動画ファイルが返ってくるか確かめる */
function isRealVideo(url: string, signal: AbortSignal): Promise<boolean> {
  let check = videoCheckCache.get(url);
  if (!check) {
    check = safeFetch(url, { headers: { range: "bytes=0-63" }, timeoutMs: 4000, signal })
      .then(async ({ res, url: finalUrl }) => {
        if (res.status !== 200 && res.status !== 206) {
          await res.body?.cancel().catch(() => {});
          return false;
        }
        const type = res.headers.get("content-type");
        const labeled =
          kindFromContentType(type) === "video" || ((!type || type.includes("octet-stream")) && kindFromUrl(finalUrl) === "video");
        if (!labeled) {
          await res.body?.cancel().catch(() => {});
          return false;
        }
        // 「動画」と名乗っていても中身が HTML のサーバーがあるので、先頭のバイトも確かめる
        const head = await readHead(res, 64);
        return looksLikeVideo(head);
      })
      .catch(() => false);
    videoCheckCache.set(url, check);
    if (videoCheckCache.size > 5000) videoCheckCache.delete(videoCheckCache.keys().next().value!);
  }
  return check;
}

/**
 * URL の見た目だけで動画とした候補を確かめ、動画ファイルでないもの（ダウンロードページへのリンクなど）を外す。
 * 一度に確かめる数は 8 件まで。
 */
/** 1 ページで確かめる動画候補の数と、確認にかけてよい時間の上限（サーバーの時間切れを防ぐ） */
const MAX_VERIFY_PER_PAGE = 40;
const VERIFY_BUDGET_MS = 15000;

async function verifyVideos(items: MediaItem[], signal: AbortSignal, deadline: number): Promise<MediaItem[]> {
  const ok = new Map<MediaItem, boolean>();
  const pending = items.filter((m) => m.unverified).slice(0, MAX_VERIFY_PER_PAGE);
  const stopAt = Math.min(deadline, Date.now() + VERIFY_BUDGET_MS);
  for (let i = 0; i < pending.length; i += 16) {
    // 時間が足りなくなったら、残りは確認せずに外す（確かめられないものは出さない）
    if (Date.now() > stopAt || signal.aborted) break;
    const batch = pending.slice(i, i + 16);
    const results = await Promise.all(batch.map((m) => isRealVideo(m.src, signal)));
    batch.forEach((m, j) => ok.set(m, results[j]));
  }
  return items
    .filter((m) => !m.unverified || ok.get(m))
    .map((m) => (m.unverified ? { ...m, unverified: undefined } : m));
}

/** 途中経過を送り返してもらうときの大きさの上限（巨大なデータを送りつけられないように） */
export const MAX_QUEUE = 5000;
export const MAX_SEEN = 20000;

export async function* crawl(
  startUrl: string,
  options: CrawlOptions,
  signal: AbortSignal,
  deadline: number,
  resume?: CrawlState,
): AsyncGenerator<CrawlEvent> {
  const start = new URL(startUrl);
  const origin = start.origin;
  const scope = scopeOf(start);
  const startPath = start.pathname;

  // robots.txt はサイトごとに 1 回だけ読む
  const robots = new Map<string, Promise<(path: string) => boolean>>();
  const allowed = async (url: string) => {
    const u = new URL(url);
    let rule = robots.get(u.origin);
    if (!rule) {
      rule = loadRobots(u.origin, signal);
      robots.set(u.origin, rule);
    }
    return (await rule)(u.pathname);
  };

  const seenPages = new Set<string>(resume?.seen ?? [normalizePageUrl(startUrl)]);
  const seenMedia = new Set<string>();
  const queue: QueueItem[] = resume?.queue ?? [{ url: startUrl, depth: 0 }];
  let pages = resume?.pages ?? 0;
  let paginationUsed = resume?.paginationUsed ?? 0;
  let mediaCount = 0;

  const enqueue = (url: string, depth: number) => {
    if (!isPageLikeUrl(url) || seenPages.size >= MAX_SEEN || queue.length >= MAX_QUEUE) return false;
    const key = normalizePageUrl(url);
    if (seenPages.has(key)) return false;
    seenPages.add(key);
    queue.push({ url, depth });
    return true;
  };

  /** 時間切れで次の回に回すページ */
  const deferred: QueueItem[] = [];
  let renderStarts = 0;

  const visit = async (url: string, depth: number): Promise<CrawlEvent[]> => {
    const events: CrawlEvent[] = [];
    if (!(await allowed(url))) {
      events.push({ type: "skip", url, reason: "robots.txt で禁止されています" });
      return events;
    }
    try {
      const { res, url: finalUrl } = await safeFetch(url, {
        signal,
        headers: { accept: "text/html,application/xhtml+xml,image/*,video/*;q=0.8,*/*;q=0.5" },
      });
      if (!res.ok) {
        await res.body?.cancel();
        events.push({ type: "error", url, message: `HTTP ${res.status}` });
        return events;
      }
      const type = res.headers.get("content-type");
      // 入力がメディアの直 URL だった場合は、それ自体を 1 件として返す
      const directKind = kindFromContentType(type) ?? (type?.includes("html") ? null : kindFromUrl(finalUrl));
      if (directKind) {
        await res.body?.cancel();
        const item: MediaItem = {
          id: finalUrl,
          kind: directKind,
          src: finalUrl,
          pageUrl: finalUrl,
          format: (type?.split("/")[1]?.split(";")[0] ?? "").toUpperCase().replace("JPEG", "JPG") || undefined,
        };
        events.push({ type: "page", url: finalUrl, depth, found: 1 }, { type: "media", items: [item] });
        return events;
      }
      if (type && !/html|xml|text\/plain/i.test(type)) {
        await res.body?.cancel();
        events.push({ type: "skip", url, reason: `ページではありません（${type.split(";")[0]}）` });
        return events;
      }
      const html = await readLimited(res, MAX_HTML_BYTES);
      let extracted = extractFromHtml(html, finalUrl);
      let network: NetworkMedia[] = [];
      let rendered = false;
      let renderError: string | null = null;
      // JavaScript で描くページで、画像やリンクがほとんど取れなかったときは、ブラウザで開き直す
      const looksEmpty = extracted.media.length <= 2 || extracted.links.length < 3;
      const wantRender =
        options.render === "always" || (options.render === "auto" && extracted.clientRendered && looksEmpty);
      if (wantRender) {
        try {
          // 1 回の実行で最初のブラウザ表示は必ず行う（次の回へ回し続けて進まなくなるのを防ぐ）
          const startBy = renderStarts++ === 0 ? Number.POSITIVE_INFINITY : deadline;
          const r = await renderPage(finalUrl, signal, startBy);
          const again = extractFromHtml(r.html, r.finalUrl);
          extracted = {
            ...again,
            media: [...extracted.media, ...again.media],
            links: [...new Set([...again.links, ...extracted.links])],
            pagination: [...new Set([...again.pagination, ...extracted.pagination])],
          };
          network = r.network;
          rendered = true;
        } catch (err) {
          if (signal.aborted) return events;
          if (err instanceof RenderDeferred) {
            // 区切りまでに始められなかった。数えずに、続きの回で開き直す
            deferred.push({ url, depth });
            return events;
          }
          renderError = err instanceof Error ? err.message : String(err);
        }
      }
      const { links, pagination, clientRendered } = extracted;
      const media: MediaItem[] = [
        ...extracted.media,
        ...network.map((n) => ({ id: n.url, kind: n.kind, src: n.url, pageUrl: finalUrl, format: formatOf(n.url, n.kind) })),
      ];
      const candidates: MediaItem[] = [];
      for (const m of media) {
        if (seenMedia.has(m.id)) continue;
        seenMedia.add(m.id);
        candidates.push(m);
      }
      // 取得する種類の指定（動画のみ・画像のみ）。埋め込み動画は動画に含める
      const wanted = candidates.filter((m) =>
        options.kinds === "video" ? m.kind !== "image" : options.kinds === "image" ? m.kind === "image" : true,
      );
      const fresh = await verifyVideos(wanted, signal, deadline);
      events.push({ type: "page", url: finalUrl, depth, found: fresh.length });
      if (fresh.length) events.push({ type: "media", items: fresh });
      if (depth === 0) {
        const message = renderError
          ? `ブラウザで開けませんでした（${renderError.slice(0, 80)}）`
          : rendered && media.length <= 2
            ? "ブラウザで開いても画像が見つかりませんでした（ログインや年齢確認が必要なページかもしれません）"
            : !rendered && media.length <= 2 && clientRendered
              ? "このページは画像を JavaScript で後から読み込むため、取れない画像があります（「ブラウザで開く」を試してください）"
              : null;
        if (message) events.push({ type: "note", url: finalUrl, message });
      }

      // ページ送り（2ページ目・次へ）は同じ階層として辿る
      for (const link of pagination) {
        if (paginationUsed >= options.maxPagination) break;
        if (enqueue(link, depth)) paginationUsed++;
      }
      // 普通のリンクは 1 階層下として辿る
      if (depth < options.depth) {
        for (const link of links) {
          if (!options.crossSite && !inScope(link, origin, scope, startPath)) continue;
          enqueue(link, depth + 1);
        }
      }
    } catch (err) {
      if (signal.aborted) return events;
      const message =
        err instanceof Error
          ? err.name === "TimeoutError"
            ? "時間切れ（サイトの応答が遅すぎます）"
            : err.message
          : String(err);
      events.push({ type: "error", url, message });
    }
    return events;
  };

  // 幅優先：浅い階層から順に、最大 CONCURRENCY 件ずつ並列に読む
  while (queue.length && !signal.aborted && pages < options.maxPages) {
    if (Date.now() > deadline) {
      // 時間切れ。続きを画面に預けて、もう一度呼んでもらう
      yield { type: "continue", state: { queue, seen: [...seenPages], pages, paginationUsed } };
      return;
    }
    queue.sort((a, b) => a.depth - b.depth);
    const batch = queue.splice(0, Math.min(CONCURRENCY, options.maxPages - pages));
    pages += batch.length;
    const results = await Promise.all(batch.map((p) => visit(p.url, p.depth)));
    for (const events of results) {
      for (const e of events) {
        if (e.type === "media") mediaCount += e.items.length;
        yield e;
      }
    }
    if (deferred.length) {
      // 次の回に回したページは、読んだ数から引いて列の先頭に戻す
      pages -= deferred.length;
      queue.unshift(...deferred.splice(0));
      yield { type: "continue", state: { queue, seen: [...seenPages], pages, paginationUsed } };
      return;
    }
  }
  yield { type: "done", pages, media: mediaCount, truncated: queue.length > 0 };
}
