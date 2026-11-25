import { noticeFound, watchedPrints, type Watched } from "@/lib/thumbs/revive";
import { guardApi } from "@/lib/access/locks";
import { MAX_EXCLUDES, normalizeRule } from "@/lib/thumbs/exclude";
import { crawl, type CrawlProgress, markStuck, MAX_PENDING, MAX_PRINTS, MAX_QUEUE, MAX_RESERVE, MAX_SEEN } from "@/lib/thumbs/crawl";
import { assertPublicUrl, FetchBlockedError, thumbsLog } from "@/lib/thumbs/safeFetch";
import type { CrawlEvent, CrawlHome, CrawlOptions, CrawlState, MediaItem, QueueItem } from "@/lib/thumbs/types";

export const runtime = "nodejs";
/** Vercel の関数の最大実行時間（秒）。クロールはこの手前で打ち切る */
export const maxDuration = 120;

const clamp = (n: unknown, min: number, max: number, fallback: number) => {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : fallback;
  return Math.min(max, Math.max(min, v));
};

/**
 * POST { url, depth, maxPages } → 見つかったものを NDJSON（1 行 1 JSON）で少しずつ返す。
 * 全部終わるまで待たずに、ページを読むたびに画面へ流せる（ストリーミング）。
 */
export async function POST(request: Request) {
  const denied = await guardApi(request, "/api/thumbs/crawl");
  if (denied) return denied;
  let body: {
    url?: unknown;
    depth?: unknown;
    maxPages?: unknown;
    maxPagination?: unknown;
    crossSite?: unknown;
    render?: unknown;
    kinds?: unknown;
    exclude?: unknown;
    robots?: unknown;
    hunt?: unknown;
    gofileOnly?: unknown;
    skipHosts?: unknown;
    html?: unknown;
    knownGofile?: unknown;
    knownPages?: unknown;
    knownTweets?: unknown;
    gofileToken?: unknown;
    resume?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "リクエストの形式が正しくありません" }, { status: 400 });
  }
  let raw = typeof body.url === "string" ? body.url.trim() : "";
  if (raw && !/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  try {
    await assertPublicUrl(raw);
  } catch (err) {
    const message = err instanceof FetchBlockedError ? err.message : "URL を確認してください";
    return Response.json({ error: message }, { status: 400 });
  }

  const options = {
    depth: clamp(body.depth, 0, 20, 1),
    maxPages: clamp(body.maxPages, 1, 1000, 100),
    maxPagination: clamp(body.maxPagination, 0, 50, 50),
    crossSite: body.crossSite === true,
    exclude: Array.isArray(body.exclude)
      ? body.exclude
          .filter((r): r is string => typeof r === "string")
          .map(normalizeRule)
          .filter((r): r is string => !!r)
          .slice(0, MAX_EXCLUDES)
      : [],
    kinds: (body.kinds === "video" || body.kinds === "image" ? body.kinds : "all") as CrawlOptions["kinds"],
    render: (body.render === "always" || body.render === "off" ? body.render : "auto") as CrawlOptions["render"],
    robots: body.robots !== false,
    hunt: body.hunt === true,
    gofileOnly: body.gofileOnly === true,
    knownGofile: Array.isArray(body.knownGofile)
      ? body.knownGofile.filter((c): c is string => typeof c === "string" && /^[\w-]{4,40}$/.test(c)).slice(0, 5000)
      : [],
    knownPages: Array.isArray(body.knownPages)
      ? body.knownPages.filter((u): u is string => typeof u === "string" && u.length < 2000 && /^https?:\/\//i.test(u)).slice(0, 5000)
      : [],
    knownTweets: Array.isArray(body.knownTweets)
      ? body.knownTweets.filter((t): t is string => typeof t === "string" && /^\d{8,20}$/.test(t)).slice(0, 5000)
      : [],
    rootHtml: typeof body.html === "string" && body.html.length > 50 ? body.html.slice(0, 3_000_000) : undefined,
    skipHosts: Array.isArray(body.skipHosts) ? body.skipHosts.filter((h): h is string => typeof h === "string" && h.length < 30).slice(0, 10) : [],
    gofileToken: typeof body.gofileToken === "string" && /^[A-Za-z0-9]{10,128}$/.test(body.gofileToken.trim()) ? body.gofileToken.trim() : undefined,
  };
  const resume = parseResume(body.resume);
  // ブラウザ表示（最大 35 秒）と動画の確認（最大 15 秒）が区切りの直前に始まっても収まるよう、上限の 70 秒前で区切る
  // （THUMBS_CHUNK_MS はテストで区切りを短くするためのもの。本番では設定しない）
  const startedAt = Date.now();
  const chunkMs = Number(process.env.THUMBS_CHUNK_MS) || (maxDuration - 70) * 1000;
  const deadline = Date.now() + chunkMs;
  const encoder = new TextEncoder();
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort());

  const progress: CrawlProgress = { inFlight: new Map() };
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      // 動作の記録：この回に何が起きたかを、最後に 1 行にまとめる
      const tally = { pages: 0, media: 0, videos: 0, skips: 0, errors: [] as string[], notes: [] as string[], end: "" };
      thumbsLog(
        `start ${raw.slice(0, 120)} depth=${options.depth} kinds=${options.kinds} render=${options.render} cross=${options.crossSite} robots=${options.robots}` +
          ` gofileToken=${options.gofileToken ? "あり" : "なし"} resume=${resume ? `queue ${resume.queue.length}・pages ${resume.pages}` : "なし"}`,
      );
      const send = (e: CrawlEvent) => {
        if (e.type === "page") tally.pages++;
        else if (e.type === "media") {
          tally.media += e.items.length;
          tally.videos += e.items.filter((m) => m.kind !== "image").length;
        } else if (e.type === "skip") tally.skips++;
        else if (e.type === "error") tally.errors.push(`${e.message.slice(0, 80)} @ ${e.url.slice(0, 70)}`);
        else if (e.type === "note") tally.notes.push(e.message.slice(0, 300));
        else if (e.type === "continue" || e.type === "done") tally.end = e.type;
        if (!closed) controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        controller.close();
      };
      // 最後の守り：サーバーの実行時間の上限の少し前になっても終わらなければ（時間のかかるページに捕まった）、
      // いま読んでいる組を始める前の途中経過を「続き」として返して閉じる。
      // 読み終わらなかったページには印を付け、次の回は時間のかかる処理をせずに読む（2 回目は飛ばす）。
      // こうしないと、サーバーに打ち切られて通信が切れ、同じところで何度も止まってしまう
      const hardStop = setTimeout(
        () => {
          if (closed) return;
          const now = Date.now();
          const running = [...progress.inFlight];
          thumbsLog(`時間切れの手前で区切りました。読んでいたページ：${running.map(([u, at]) => `${u.slice(0, 80)}（${Math.round((now - at) / 1000)}秒）`).join(" / ") || "なし"}`);
          const slow = running.filter(([, at]) => now - at > 20000).map(([u]) => u);
          const base = progress.safe ?? resume;
          if (base) send({ type: "continue", state: markStuck(base, slow.length ? slow : running.map(([u]) => u)) });
          else send({ type: "error", url: raw, message: "時間切れ（このページを読むのに時間がかかりすぎます）" });
          abort.abort();
          close();
        },
        // THUMBS_HARD_MS はテストで短くするためのもの。本番では設定しない
        Number(process.env.THUMBS_HARD_MS) || Math.max(10000, startedAt + (maxDuration - 12) * 1000 - Date.now()),
      );
      // 「復活したら保存」で見張っている動画（同じ指紋の動画が見つかったら、保存待ちにする）
      const watched = await watchedPrints().catch((): Watched => new Map());
      try {
        for await (const event of crawl(raw, options, abort.signal, deadline, resume, progress)) {
          if (closed) break;
          send(event);
          if (event.type === "media" && watched.size) await noticeFound(event.items, watched).catch(() => 0);
        }
      } catch (err) {
        send({ type: "error", url: raw, message: err instanceof Error ? err.message : String(err) });
        send({ type: "done", pages: 0, media: 0, truncated: false });
      } finally {
        clearTimeout(hardStop);
        close();
        thumbsLog(
          `end ${tally.end || (abort.signal.aborted ? "中断" : "?")} ${Date.now() - startedAt}ms pages=${tally.pages} media=${tally.media} videos=${tally.videos} skips=${tally.skips}` +
            ` errors=${tally.errors.length}${tally.errors.length ? `［${tally.errors.slice(0, 6).join(" ｜ ")}］` : ""}` +
            `${tally.notes.length ? ` notes［${tally.notes.slice(-3).join(" ｜ ")}］` : ""}`,
        );
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}

const isHttpUrl = (v: unknown, max = 4000): v is string => typeof v === "string" && v.length < max && /^https?:\/\//i.test(v);

/** 画面から送り返された「これから読むページ」の列を検査する */
function parseQueue(value: unknown, max: number): QueueItem[] {
  if (!Array.isArray(value)) return [];
  const out: QueueItem[] = [];
  for (const q of value.slice(0, max)) {
    if (!q || typeof q !== "object") continue;
    const v = q as Record<string, unknown>;
    if (!isHttpUrl(v.url) || typeof v.depth !== "number") continue;
    const depth = clamp(v.depth, 0, 30, 0);
    const item: QueueItem = { url: v.url, depth, rank: clamp(v.rank, 0, 1000, depth), prio: clamp(v.prio, 0, 10, 0) };
    if (isHttpUrl(v.thumb, 2000)) item.thumb = v.thumb;
    const zone = clamp(v.zone, 0, 2, 0);
    if (zone) item.zone = zone;
    if (v.root === true) item.root = true;
    if (isHttpUrl(v.from)) item.from = v.from;
    if (isHttpUrl(v.preview)) item.preview = v.preview;
    const duration = seconds(v.duration);
    if (duration) item.duration = duration;
    const title = shortText(v.title, 120);
    if (title) item.title = title;
    const retry = clamp(v.retry, 0, 10, 0);
    if (retry) item.retry = retry;
    if (v.feed === true) item.feed = true;
    out.push(item);
  }
  return out;
}

/** 再生時間（秒）として正しい値か */
const seconds = (v: unknown) => (typeof v === "number" && v > 0 && v < 7 * 24 * 3600 ? Math.round(v * 10) / 10 : undefined);

const shortText = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : undefined);

/** 画面から送り返された「確認待ちの画像・動画」を検査する */
function parsePending(value: unknown): MediaItem[] {
  if (!Array.isArray(value)) return [];
  const out: MediaItem[] = [];
  for (const raw of value.slice(0, MAX_PENDING)) {
    if (!raw || typeof raw !== "object") continue;
    const v = raw as Record<string, unknown>;
    if (v.kind !== "image" && v.kind !== "video" && v.kind !== "embed") continue;
    if (!isHttpUrl(v.src) || !isHttpUrl(v.pageUrl)) continue;
    const item: MediaItem = { id: shortText(v.id, 4000) ?? v.src, kind: v.kind, src: v.src, pageUrl: v.pageUrl };
    if (isHttpUrl(v.thumb)) item.thumb = v.thumb;
    if (isHttpUrl(v.referer)) item.referer = v.referer;
    item.format = shortText(v.format, 20);
    item.title = shortText(v.title, 300);
    if (typeof v.width === "number" && v.width > 0 && v.width < 100000) item.width = Math.round(v.width);
    if (typeof v.height === "number" && v.height > 0 && v.height < 100000) item.height = Math.round(v.height);
    const duration = seconds(v.duration);
    if (duration) item.duration = duration;
    if (v.unverified === true) item.unverified = true;
    if (v.guess === true) item.guess = true;
    const cookie = shortText(v.cookie, 600);
    if (cookie && /^[a-z0-9.-]+\|[^=;|]+=[^;|]+$/i.test(cookie)) item.cookie = cookie;
    item.tries = clamp(v.tries, 0, 10, 0);
    out.push(item);
  }
  return out;
}

/** 画面から送り返された途中経過を検査する（形が崩れていれば最初からやり直す） */
function parseResume(value: unknown): CrawlState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.queue) || !Array.isArray(v.seen)) return undefined;
  const seen = v.seen.slice(0, MAX_SEEN).filter((s): s is string => typeof s === "string");
  let home: CrawlHome | undefined;
  const h = v.home as Record<string, unknown> | undefined;
  if (h && typeof h === "object" && Array.isArray(h.sites) && typeof h.scope === "string" && typeof h.path === "string") {
    const sites = h.sites.filter((s): s is string => typeof s === "string" && /^[a-z0-9.:-]{1,253}$/.test(s)).slice(0, 10);
    if (sites.length && h.scope.length < 2000 && h.path.length < 2000) home = { sites, scope: h.scope, path: h.path };
  }
  const cookies = Array.isArray(v.cookies)
    ? v.cookies
        .filter(
          (c): c is [string, string] =>
            Array.isArray(c) && typeof c[0] === "string" && typeof c[1] === "string" && /^[a-z0-9.-]{1,253}$/.test(c[0]) && c[1].length < 8000 && !/[\r\n]/.test(c[1]),
        )
        .slice(0, 50)
    : undefined;
  return {
    queue: parseQueue(v.queue, MAX_QUEUE),
    barren: Array.isArray(v.barren)
      ? v.barren
          .filter((b): b is [string, number] => Array.isArray(b) && typeof b[0] === "string" && b[0].length < 200 && typeof b[1] === "number")
          .slice(0, 500)
          .map(([k, n]) => [k, clamp(n, 0, 1000, 0)] as [string, number])
      : undefined,
    fruitful: Array.isArray(v.fruitful) ? v.fruitful.filter((f): f is string => typeof f === "string" && f.length < 200).slice(0, 500) : undefined,
    seen,
    pages: clamp(v.pages, 0, 1000, 0),
    paginationUsed: clamp(v.paginationUsed, 0, 50, 0),
    reserve: parseQueue(v.reserve, MAX_RESERVE),
    videos: clamp(v.videos, 0, 1_000_000, 0),
    found: clamp(v.found, 0, 1_000_000, 0),
    widened: clamp(v.widened, 0, 1000, 0),
    home,
    cookies,
    pending: parsePending(v.pending),
    stuck: Array.isArray(v.stuck)
      ? v.stuck
          .filter((x): x is [string, number] => Array.isArray(x) && isHttpUrl(x[0]) && typeof x[1] === "number")
          .map(([u, n]) => [u, clamp(n, 0, 10, 1)] as [string, number])
          .slice(-200)
      : undefined,
    dropped: Array.isArray(v.dropped) ? [clamp(v.dropped[0], 0, 100000, 0), clamp(v.dropped[1], 0, 100000, 0)] : undefined,
    prints: Array.isArray(v.prints)
      ? v.prints.filter((x): x is string => typeof x === "string" && x.length <= 80).slice(-MAX_PRINTS)
      : undefined,
  };
}
