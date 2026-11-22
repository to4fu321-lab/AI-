import { guardApi } from "@/lib/access/locks";
import { crawl, MAX_QUEUE, MAX_SEEN } from "@/lib/thumbs/crawl";
import { assertPublicUrl, FetchBlockedError } from "@/lib/thumbs/safeFetch";
import type { CrawlEvent, CrawlOptions, CrawlState } from "@/lib/thumbs/types";

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
    kinds: (body.kinds === "video" || body.kinds === "image" ? body.kinds : "all") as CrawlOptions["kinds"],
    render: (body.render === "always" || body.render === "off" ? body.render : "auto") as CrawlOptions["render"],
  };
  const resume = parseResume(body.resume);
  // ブラウザ表示（最大 35 秒）と動画の確認（最大 15 秒）が区切りの直前に始まっても収まるよう、上限の 70 秒前で区切る
  // （THUMBS_CHUNK_MS はテストで区切りを短くするためのもの。本番では設定しない）
  const chunkMs = Number(process.env.THUMBS_CHUNK_MS) || (maxDuration - 70) * 1000;
  const deadline = Date.now() + chunkMs;
  const encoder = new TextEncoder();
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort());

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: CrawlEvent) => controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      try {
        for await (const event of crawl(raw, options, abort.signal, deadline, resume)) send(event);
      } catch (err) {
        send({ type: "error", url: raw, message: err instanceof Error ? err.message : String(err) });
        send({ type: "done", pages: 0, media: 0, truncated: false });
      } finally {
        controller.close();
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

/** 画面から送り返された途中経過を検査する（形が崩れていれば最初からやり直す） */
function parseResume(value: unknown): CrawlState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.queue) || !Array.isArray(v.seen)) return undefined;
  const queue = v.queue
    .slice(0, MAX_QUEUE)
    .filter(
      (q): q is { url: string; depth: number } =>
        !!q && typeof q === "object" && typeof (q as { url: unknown }).url === "string" && typeof (q as { depth: unknown }).depth === "number",
    )
    .map((q) => ({ url: q.url, depth: Math.min(20, Math.max(0, Math.round(q.depth))) }));
  const seen = v.seen.slice(0, MAX_SEEN).filter((s): s is string => typeof s === "string");
  return {
    queue,
    seen,
    pages: clamp(v.pages, 0, 1000, 0),
    paginationUsed: clamp(v.paginationUsed, 0, 50, 0),
  };
}
