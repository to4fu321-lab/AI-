import { guardApi } from "@/lib/access/locks";
import { kindFromContentType, kindFromUrl } from "@/lib/thumbs/extract";
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
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag"]) {
    const v = upstream.headers.get(name);
    if (v) out.set(name, v);
  }
  if (!out.has("accept-ranges")) out.set("accept-ranges", "bytes");
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
  return new Response(upstream.body, { status: upstream.status, headers: out });
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
