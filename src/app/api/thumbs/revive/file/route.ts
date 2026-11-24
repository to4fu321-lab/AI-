import { guardApi } from "@/lib/access/locks";
import { openSaved } from "@/lib/thumbs/revive";

/**
 * GET /api/thumbs/revive/file?fp=<指紋>&dl=1
 * 「復活したら保存」で Blob に保存した動画を流す（パスワードの内側だけ。Blob 自体は非公開）。
 * Range に対応するので、途中から再生・シークできる。dl=1 なら「保存」させる
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const denied = await guardApi(request, "/api/thumbs/revive/file");
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const fp = params.get("fp") ?? "";
  const range = request.headers.get("range");
  let saved;
  try {
    saved = await openSaved(fp, range && /^bytes=\d*-\d*$/.test(range.trim()) ? range.trim() : null);
  } catch (err) {
    return new Response(`保存した動画を読めませんでした（${err instanceof Error ? err.message.slice(0, 100) : String(err)}）`, { status: 502 });
  }
  if (!saved) return new Response("保存した動画が見つかりません", { status: 404 });
  const out = new Headers();
  out.set("content-type", saved.contentType || "video/mp4");
  out.set("accept-ranges", "bytes");
  out.set("cache-control", "private, max-age=3600");
  out.set("x-content-type-options", "nosniff");
  for (const name of ["content-length", "content-range", "etag", "last-modified"]) {
    const v = saved.headers.get(name);
    if (v) out.set(name, v);
  }
  if (params.get("dl") === "1") {
    const ext = saved.path.split(".").pop() || "mp4";
    const base = (saved.title || fp).replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 100);
    const name = `${base}.${ext}`;
    out.set("content-disposition", `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  }
  return new Response(saved.stream, { status: saved.headers.get("content-range") ? 206 : 200, headers: out });
}
