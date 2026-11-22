import "server-only";
import { extractFromHtml, formatOf, type LinkCandidate, isPageLikeUrl, kindFromContentType, kindFromUrl } from "./extract";
import { isExcluded, isItemExcluded } from "./exclude";
import { RenderDeferred, renderPage } from "./render";
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

/**
 * 先頭 64 バイトだけ取りに行き、本当に動画ファイルが返ってくるか確かめる。
 * 直リンク禁止のサーバーもあるので、見つけたページ（プレーヤー）を Referer として名乗る
 */
function isRealVideo(url: string, referer: string, signal: AbortSignal): Promise<boolean> {
  let check = videoCheckCache.get(url);
  if (!check) {
    check = safeFetch(url, { headers: { range: "bytes=0-63", referer }, timeoutMs: 4000, signal })
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

/** 1 ページで確かめる動画候補の数と、確認にかけてよい時間の上限（サーバーの時間切れを防ぐ） */
const MAX_VERIFY_PER_PAGE = 40;
const VERIFY_BUDGET_MS = 15000;

/**
 * URL の見た目だけで動画とした候補を確かめ、動画ファイルでないもの（ダウンロードページへのリンクなど）を外す。
 * 一度に 16 件ずつ確かめる。
 */
async function verifyVideos(items: MediaItem[], signal: AbortSignal, deadline: number): Promise<MediaItem[]> {
  const ok = new Map<MediaItem, boolean>();
  const pending = items.filter((m) => m.unverified).slice(0, MAX_VERIFY_PER_PAGE);
  const stopAt = Math.min(deadline, Date.now() + VERIFY_BUDGET_MS);
  for (let i = 0; i < pending.length; i += 16) {
    // 時間が足りなくなったら、残りは確認せずに外す（確かめられないものは出さない）
    if (Date.now() > stopAt || signal.aborted) break;
    const batch = pending.slice(i, i + 16);
    const results = await Promise.all(batch.map((m) => isRealVideo(m.src, m.referer ?? m.pageUrl, signal)));
    batch.forEach((m, j) => ok.set(m, results[j]));
  }
  return items
    .filter((m) => !m.unverified || ok.get(m))
    .map((m) => (m.unverified ? { ...m, unverified: undefined } : m));
}

/**
 * サムネイルのない動画に、代わりのサムネイルを付ける。
 * 1. このページへのリンクに付いていたサムネイル（一覧ページの画像）… 動画が 3 本以下のとき
 * 2. ページの代表画像（og:image）… 動画が 2 本以下のとき（多いと全部同じ画像になるため）
 *    ただしサイト共通のロゴらしい画像は渡さない（呼ぶ側で判定）。
 * どちらもなければ、画面側で動画から 1 コマ取り出してサムネイルを作る。
 */
function fillThumbs(media: MediaItem[], linkThumb: string | undefined, ogImage: string | undefined) {
  const videos = media.filter((m) => m.kind !== "image");
  if (videos.length === 0) return;
  for (const v of videos) {
    if (v.thumb) continue;
    if (linkThumb && videos.length <= 3) v.thumb = linkThumb;
    else if (ogImage && videos.length <= 2) v.thumb = ogImage;
  }
}

/** iframe の中を読みに行く数・深さ・大きさの上限 */
const MAX_FRAMES_PER_PAGE = 3;
const MAX_FRAME_LEVEL = 2;
const MAX_FRAME_BYTES = 1.5 * 1024 * 1024;

/** 途中経過の記録を送る間隔 */
const CHECKPOINT_MS = 8000;

/** 途中経過を送り返してもらうときの大きさの上限（巨大なデータを送りつけられないように） */
export const MAX_QUEUE = 5000;
export const MAX_SEEN = 20000;

/** 読む順番：段（rank）の小さい順、同じ段なら優先度（prio）の大きい順 */
function byOrder(a: QueueItem, b: QueueItem) {
  return (a.rank ?? a.depth) - (b.rank ?? b.depth) || (b.prio ?? 0) - (a.prio ?? 0);
}

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
  const wantsVideo = options.kinds !== "image";

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
  const queue: QueueItem[] = resume?.queue ?? [{ url: startUrl, depth: 0, rank: 0 }];
  let pages = resume?.pages ?? 0;
  let paginationUsed = resume?.paginationUsed ?? 0;
  let mediaCount = 0;

  /** 列に入っているページを URL から引くための索引（サムネイル・優先度を後から補うとき用） */
  const queuedByUrl = new Map<string, QueueItem>(queue.map((q) => [q.url, q]));

  const enqueue = (url: string, depth: number, rank: number, prio: number, thumb?: string) => {
    if (!isPageLikeUrl(url) || isExcluded(url, options.exclude)) return false;
    const key = normalizePageUrl(url);
    if (seenPages.has(key)) {
      // すでに列にあるページなら、サムネイルと優先度だけ補う
      if (thumb || prio > 0) {
        const queued = queuedByUrl.get(url);
        if (queued) {
          queued.thumb ??= thumb;
          queued.prio = Math.max(queued.prio ?? 0, prio);
        }
      }
      return false;
    }
    if (seenPages.size >= MAX_SEEN || queue.length >= MAX_QUEUE) return false;
    seenPages.add(key);
    const entry: QueueItem = { url, depth, rank, prio, thumb };
    queue.push(entry);
    queuedByUrl.set(url, entry);
    return true;
  };

  /** og:image ごとの、それを使っていたページ数（サイト共通のロゴを見分ける） */
  const ogPages = new Map<string, number>();
  /** 時間切れで次の回に回すページ */
  const deferred: QueueItem[] = [];
  let renderStarts = 0;
  let lastCheckpoint = Date.now();

  /**
   * iframe で埋め込まれたページ（外部の動画プレーヤーなど）を読み、中の動画を集める。
   * 動画が見つからなければ、その中の iframe をもう 1 段だけ読む。
   * 見つけた動画の「元ページ」は外側のページ、Referer はそのプレーヤーのページにする。
   */
  const readFrames = async (frameUrls: string[], topPage: string, parent: string, level: number): Promise<{ media: MediaItem[]; playerHint: boolean }> => {
    const media: MediaItem[] = [];
    let playerHint = false;
    const targets = frameUrls.filter((u) => !isExcluded(u, options.exclude)).slice(0, MAX_FRAMES_PER_PAGE);
    await Promise.all(
      targets.map(async (frameUrl) => {
        if (Date.now() > deadline || signal.aborted) return;
        try {
          if (!(await allowed(frameUrl))) return;
          const { res, url: frameFinal } = await safeFetch(frameUrl, {
            signal,
            timeoutMs: 10000,
            headers: { accept: "text/html,*/*;q=0.5", referer: parent },
          });
          if (!res.ok || !/html/i.test(res.headers.get("content-type") ?? "")) {
            await res.body?.cancel().catch(() => {});
            return;
          }
          const ex = extractFromHtml(await readLimited(res, MAX_FRAME_BYTES), frameFinal);
          playerHint ||= ex.playerHint;
          let found: MediaItem[] = ex.media
            .filter((m) => m.kind !== "image")
            .map((m) => ({ ...m, pageUrl: topPage, referer: m.referer ?? frameFinal }));
          fillThumbs(found, undefined, ex.ogImage);
          if (found.length === 0 && level < MAX_FRAME_LEVEL && ex.frames.length) {
            const nested = await readFrames(ex.frames, topPage, frameFinal, level + 1);
            found = nested.media;
            playerHint ||= nested.playerHint;
          }
          media.push(...found);
        } catch {
          /* 読めない iframe は飛ばす */
        }
      }),
    );
    return { media, playerHint };
  };

  const visit = async (item: QueueItem): Promise<CrawlEvent[]> => {
    const { url, depth } = item;
    const rank = item.rank ?? depth;
    const events: CrawlEvent[] = [];
    if (isExcluded(url, options.exclude)) {
      events.push({ type: "skip", url, reason: "除外リストのサイトです" });
      return events;
    }
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
      // リダイレクトで除外リストのサイトに飛ばされた場合も読まない
      if (finalUrl !== url && isExcluded(finalUrl, options.exclude)) {
        await res.body?.cancel();
        events.push({ type: "skip", url, reason: "除外リストのサイトです" });
        return events;
      }
      const type = res.headers.get("content-type");
      // 入力がメディアの直 URL だった場合は、それ自体を 1 件として返す
      const directKind = kindFromContentType(type) ?? (type?.includes("html") ? null : kindFromUrl(finalUrl));
      if (directKind) {
        await res.body?.cancel();
        const direct: MediaItem = {
          id: finalUrl,
          kind: directKind,
          src: finalUrl,
          pageUrl: finalUrl,
          thumb: directKind === "video" ? item.thumb : undefined,
          format: (type?.split("/")[1]?.split(";")[0] ?? "").toUpperCase().replace("JPEG", "JPG") || undefined,
        };
        events.push({ type: "page", url: finalUrl, depth, found: 1 }, { type: "media", items: [direct] });
        return events;
      }
      if (type && !/html|xml|text\/plain/i.test(type)) {
        await res.body?.cancel();
        events.push({ type: "skip", url, reason: `ページではありません（${type.split(";")[0]}）` });
        return events;
      }
      const html = await readLimited(res, MAX_HTML_BYTES);
      const extracted = extractFromHtml(html, finalUrl);
      const media: MediaItem[] = [...extracted.media];
      const links: LinkCandidate[] = [...extracted.links];
      const pagination = new Set(extracted.pagination);
      let ogImage = extracted.ogImage;

      // iframe の中の動画プレーヤー（動画を探すときだけ）
      let frameHint = false;
      if (wantsVideo && extracted.frames.length) {
        const fr = await readFrames(extracted.frames, finalUrl, finalUrl, 1);
        media.push(...fr.media);
        frameHint = fr.playerHint;
      }

      // ブラウザで開き直すか
      // - JavaScript で描くページで、画像やリンクがほとんど取れなかったとき
      // - 動画プレーヤーがありそうなのに、確かな動画が 1 本も見つからないとき（再生ボタンを押して探す）
      const trustedVideos = media.filter((m) => m.kind !== "image" && !m.unverified).length;
      const looksEmpty = extracted.media.length <= 2 || extracted.links.length < 3;
      const wantRender =
        options.render === "always" ||
        (options.render === "auto" &&
          ((extracted.clientRendered && looksEmpty) || (wantsVideo && (extracted.playerHint || frameHint) && trustedVideos === 0)));
      let rendered = false;
      let renderError: string | null = null;
      if (wantRender) {
        try {
          // 1 回の実行で最初のブラウザ表示は必ず行う（次の回へ回し続けて進まなくなるのを防ぐ）
          const startBy = renderStarts++ === 0 ? Number.POSITIVE_INFINITY : deadline;
          const r = await renderPage(finalUrl, signal, startBy, { play: wantsVideo });
          const again = extractFromHtml(r.html, r.finalUrl);
          media.push(...again.media);
          links.push(...again.links);
          for (const p of again.pagination) pagination.add(p);
          ogImage ??= again.ogImage;
          // ブラウザの中で開いていた iframe の中身
          for (const f of r.frames) {
            const fx = extractFromHtml(f.html, f.url);
            const found = fx.media
              .filter((m) => m.kind !== "image")
              .map((m) => ({ ...m, pageUrl: finalUrl, referer: m.referer ?? f.url }));
            fillThumbs(found, undefined, fx.ogImage);
            media.push(...found);
          }
          // 表示・再生の間にブラウザが受け取った画像・動画
          for (const n of r.network) {
            media.push({ id: n.url, kind: n.kind, src: n.url, pageUrl: finalUrl, referer: n.referer, format: formatOf(n.url, n.kind) });
          }
          rendered = true;
        } catch (err) {
          if (signal.aborted) return events;
          if (err instanceof RenderDeferred) {
            // 区切りまでに始められなかった。数えずに、続きの回で開き直す
            deferred.push(item);
            return events;
          }
          renderError = err instanceof Error ? err.message : String(err);
        }
      }

      // 同じページ内の重複をまとめる（サムネイルなどの情報は補い合う）
      const merged = new Map<string, MediaItem>();
      for (const m of media) {
        const prev = merged.get(m.id);
        if (!prev) merged.set(m.id, { ...m });
        else {
          prev.thumb ??= m.thumb;
          prev.title ??= m.title;
          prev.referer ??= m.referer;
          if (!m.unverified) prev.unverified = undefined;
        }
      }
      const pageMedia = [...merged.values()];
      // og:image が複数のページで同じなら、サイト共通のロゴ。最初のページ（一覧ページのことが多い）の og:image も使わない
      // （ロゴを付けるより、画面側で動画から本物のコマを取り出すほうがよい）
      if (ogImage) ogPages.set(ogImage, (ogPages.get(ogImage) ?? 0) + 1);
      const usableOg = ogImage && depth > 0 && (ogPages.get(ogImage) ?? 0) < 2 ? ogImage : undefined;
      fillThumbs(pageMedia, item.thumb, usableOg);

      const candidates: MediaItem[] = [];
      for (const m of pageMedia) {
        if (seenMedia.has(m.id)) continue;
        seenMedia.add(m.id);
        candidates.push(m);
      }
      // 取得する種類の指定（動画のみ・画像のみ）。埋め込み動画は動画に含める
      const wanted = candidates
        .filter((m) => !isItemExcluded(m, options.exclude))
        .filter((m) => (options.kinds === "video" ? m.kind !== "image" : options.kinds === "image" ? m.kind === "image" : true));
      const fresh = await verifyVideos(wanted, signal, deadline);
      events.push({ type: "page", url: finalUrl, depth, found: fresh.length });
      if (fresh.length) events.push({ type: "media", items: fresh });
      if (depth === 0) {
        const message = renderError
          ? `ブラウザで開けませんでした（${renderError.slice(0, 80)}）`
          : rendered && pageMedia.length <= 2
            ? "ブラウザで開いても画像が見つかりませんでした（ログインや年齢確認が必要なページかもしれません）"
            : !rendered && pageMedia.length <= 2 && extracted.clientRendered
              ? "このページは画像を JavaScript で後から読み込むため、取れない画像があります（「ブラウザで開く」を試してください）"
              : null;
        if (message) events.push({ type: "note", url: finalUrl, message });
      }

      // ページ送り（2ページ目・次へ）は同じ階層として辿る。読む順番は 1 段後ろ
      // → 「このページの詳細ページ」と「次の一覧ページ」が同じ段に並び、詳細ページが先に読まれる
      for (const link of pagination) {
        if (paginationUsed >= options.maxPagination) break;
        if (enqueue(link, depth, rank + 1, 1)) paginationUsed++;
      }
      // 普通のリンクは 1 階層下として辿る（サムネイル付き・動画らしいリンクが先）
      if (depth < options.depth) {
        for (const link of links) {
          if (pagination.has(link.url)) continue;
          if (!options.crossSite && !inScope(link.url, origin, scope, startPath)) continue;
          enqueue(link.url, depth + 1, rank + 1, link.prio, link.thumb);
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

  // 段の小さい順・優先度の高い順に、最大 CONCURRENCY 件ずつ並列に読む
  while (queue.length && !signal.aborted && pages < options.maxPages) {
    if (Date.now() > deadline) {
      // 時間切れ。続きを画面に預けて、もう一度呼んでもらう
      yield { type: "continue", state: { queue, seen: [...seenPages], pages, paginationUsed } };
      return;
    }
    queue.sort(byOrder);
    const batch = queue.splice(0, Math.min(CONCURRENCY, options.maxPages - pages));
    for (const b of batch) queuedByUrl.delete(b.url);
    pages += batch.length;
    const results = await Promise.all(batch.map((p) => visit(p)));
    for (const events of results) {
      for (const e of events) {
        if (e.type === "media") mediaCount += e.items.length;
        yield e;
      }
    }
    // 数秒おきに途中経過を記録として送る（画面を閉じたり止めたりしても、ここから再開できる）
    if (Date.now() - lastCheckpoint > CHECKPOINT_MS && queue.length) {
      lastCheckpoint = Date.now();
      yield { type: "checkpoint", state: { queue: [...queue], seen: [...seenPages], pages, paginationUsed } };
    }
    if (deferred.length) {
      // 次の回に回したページは、読んだ数から引いて列の先頭に戻す
      pages -= deferred.length;
      for (const d of deferred) queuedByUrl.set(d.url, d);
      queue.unshift(...deferred.splice(0));
      yield { type: "continue", state: { queue, seen: [...seenPages], pages, paginationUsed } };
      return;
    }
  }
  const truncated = queue.length > 0;
  yield {
    type: "done",
    pages,
    media: mediaCount,
    truncated,
    state: truncated ? { queue, seen: [...seenPages], pages, paginationUsed } : undefined,
  };
}
