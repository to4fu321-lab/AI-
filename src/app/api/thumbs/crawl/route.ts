import { crawl } from "@/lib/thumbs/crawl";
import { assertPublicUrl, FetchBlockedError } from "@/lib/thumbs/safeFetch";
import type { CrawlEvent } from "@/lib/thumbs/types";

export const runtime = "nodejs";
/** Vercel の関数の最大実行時間（秒）。クロールはこの手前で打ち切る */
export const maxDuration = 60;

const clamp = (n: unknown, min: number, max: number, fallback: number) => {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : fallback;
  return Math.min(max, Math.max(min, v));
};

/**
 * POST { url, depth, maxPages } → 見つかったものを NDJSON（1 行 1 JSON）で少しずつ返す。
 * 全部終わるまで待たずに、ページを読むたびに画面へ流せる（ストリーミング）。
 */
export async function POST(request: Request) {
  let body: { url?: unknown; depth?: unknown; maxPages?: unknown };
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
    depth: clamp(body.depth, 0, 3, 1),
    maxPages: clamp(body.maxPages, 1, 100, 30),
  };
  const deadline = Date.now() + (maxDuration - 8) * 1000;
  const encoder = new TextEncoder();
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort());

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: CrawlEvent) => controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      try {
        for await (const event of crawl(raw, options, abort.signal, deadline)) send(event);
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
