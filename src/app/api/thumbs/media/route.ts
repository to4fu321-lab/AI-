import { guardApi } from "@/lib/access/locks";
import { extensionOf, kindFromContentType, kindFromUrl } from "@/lib/thumbs/extract";
import { FetchBlockedError, safeFetch } from "@/lib/thumbs/safeFetch";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * GET /api/thumbs/media?url=<メディア>&ref=<見つかったページ>&dl=1
 *
 * 画像・動画をサーバー経由で中継する。
 * - 直リンク禁止（Referer チェック）のサイトでも表示・再生できるよう、元ページを Referer に付ける
 * - dl=1 のときは Content-Disposition: attachment を付けて「保存」させる
 *   （別ドメインのファイルは <a download> だけでは保存できないため）
 * - Range ヘッダーを転送するので、動画のシーク（途中から再生）もできる
 * 画像・動画以外（HTML など）は中継しない（何でも取ってくる踏み台にしないため）。
 */
export async function GET(request: Request) {
  const denied = await guardApi(request, "/api/thumbs/media");
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const target = params.get("url") ?? "";
  const ref = params.get("ref");
  const download = params.get("dl") === "1";

  const headers: Record<string, string> = { accept: "image/*,video/*,*/*;q=0.5" };
  const range = request.headers.get("range");
  if (range) headers.range = range;
  if (ref && /^https?:\/\//.test(ref)) headers.referer = ref;

  let upstream: Response;
  let finalUrl: string;
  try {
    ({ res: upstream, url: finalUrl } = await safeFetch(target, { headers, timeoutMs: 30000, signal: request.signal }));
  } catch (err) {
    const message = err instanceof FetchBlockedError ? err.message : "取得できませんでした";
    return new Response(message, { status: 400 });
  }
  if (!upstream.ok && upstream.status !== 206) {
    await upstream.body?.cancel();
    return new Response(`元のサイトがエラーを返しました（HTTP ${upstream.status}）`, { status: 502 });
  }

  const type = upstream.headers.get("content-type");
  const kind =
    kindFromContentType(type) ??
    (type?.includes("octet-stream") || !type ? kindFromUrl(finalUrl) : null);
  if (!kind) {
    await upstream.body?.cancel();
    return new Response("画像・動画ではないため中継できません", { status: 415 });
  }

  const out = new Headers();
  for (const name of ["content-length", "content-range", "accept-ranges", "last-modified", "etag"]) {
    const v = upstream.headers.get(name);
    if (v) out.set(name, v);
  }
  // 「中身の種類」を正しく名乗る。iPhone の Safari は video/mp4 などでないと再生しない
  // （元のサーバーが application/octet-stream などで返すことがある）
  out.set("content-type", properType(type, finalUrl, kind));

  let body: ReadableStream<Uint8Array> | null = upstream.body;
  let status = upstream.status;
  const wanted = parseRange(range);
  if (upstream.status === 206) {
    out.set("accept-ranges", "bytes");
  } else if (wanted && upstream.status === 200) {
    // 元のサーバーが部分取得（Range）に対応していないとき、こちらで切り出して 206 で返す。
    // Safari は Range に 206 で答えないと動画を再生しない
    const total = Number(upstream.headers.get("content-length"));
    if (Number.isFinite(total) && total > 0 && body) {
      const start = wanted.suffix !== undefined ? Math.max(0, total - wanted.suffix) : wanted.start;
      const end = Math.min(wanted.end ?? total - 1, total - 1);
      if (start > end || start >= total) {
        await upstream.body?.cancel();
        return new Response(null, { status: 416, headers: { "content-range": `bytes */${total}` } });
      }
      body = sliceStream(body, start, end);
      status = 206;
      out.set("content-range", `bytes ${start}-${end}/${total}`);
      out.set("content-length", String(end - start + 1));
      out.set("accept-ranges", "bytes");
    } else {
      // 全体の大きさがわからないと切り出せない。部分取得できるふりはしない
      out.delete("accept-ranges");
    }
  } else if (!out.has("accept-ranges") && upstream.headers.get("content-length")) {
    // 全体の大きさがわかっていれば、上の切り出しで部分取得に答えられる
    out.set("accept-ranges", "bytes");
  }
  out.set("cache-control", "public, max-age=3600");
  out.set("x-content-type-options", "nosniff");
  // SVG などにスクリプトが仕込まれていても、このドメインで実行させない
  out.set("content-security-policy", "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox");
  if (download) {
    const name = fileNameFor(finalUrl, type, params.get("name"));
    out.set(
      "content-disposition",
      `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    );
  }
  return new Response(body, { status, headers: out });
}

const MIME_BY_EXT: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  ogv: "video/ogg",
  ts: "video/mp2t",
  m3u8: "application/vnd.apple.mpegurl",
  mpd: "application/dash+xml",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  heic: "image/heic",
};

/** 元のサーバーが名乗った種類が曖昧（octet-stream など）なら、拡張子から正しい種類にする */
function properType(type: string | null, url: string, kind: "image" | "video"): string {
  const t = (type ?? "").split(";")[0].trim().toLowerCase();
  if (t && t !== "application/octet-stream" && t !== "binary/octet-stream" && t !== "application/binary" && t !== "text/plain") {
    return type!;
  }
  const ext = extensionOf(url);
  return MIME_BY_EXT[ext] ?? (kind === "video" ? "video/mp4" : "image/jpeg");
}

/** Range ヘッダー（1 区間だけ）を読む。bytes=100-、bytes=100-199、bytes=-500 */
function parseRange(range: string | null): { start: number; end?: number; suffix?: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec((range ?? "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") return { start: 0, suffix: Number(m[2]) };
  return { start: Number(m[1]), end: m[2] === "" ? undefined : Number(m[2]) };
}

/** 流れてくるデータの start〜end バイト目だけを通す */
function sliceStream(source: ReadableStream<Uint8Array>, start: number, end: number): ReadableStream<Uint8Array> {
  let offset = 0;
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        const chunkStart = offset;
        offset += value.byteLength;
        if (offset <= start) continue;
        const from = Math.max(0, start - chunkStart);
        const to = Math.min(value.byteLength, end - chunkStart + 1);
        if (to > from) controller.enqueue(value.subarray(from, to));
        if (offset > end) {
          controller.close();
          await reader.cancel().catch(() => {});
        }
        return;
      }
    },
    cancel() {
      void reader.cancel().catch(() => {});
    },
  });
}

const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "image/heic": "heic",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "application/vnd.apple.mpegurl": "m3u8",
  "application/x-mpegurl": "m3u8",
};

function fileNameFor(url: string, type: string | null, requested: string | null): string {
  const fromUrl = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
  let name = (requested || fromUrl || "media").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 120);
  const ext = EXT_BY_TYPE[(type ?? "").split(";")[0].trim().toLowerCase()];
  if (ext && !name.toLowerCase().endsWith(`.${ext}`) && !/\.[a-z0-9]{2,4}$/i.test(name)) name += `.${ext}`;
  return name;
}
