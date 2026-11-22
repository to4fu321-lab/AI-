import "server-only";
import { safeFetch } from "./safeFetch";

/**
 * pixeldrain のリスト（アルバム）の共有リンク https://pixeldrain.com/l/ID。
 * 公開の窓口（/api/list/ID）から、中のファイルの名前・種類をもらう。
 * ファイルそのものは /api/file/ID、サムネイルは /api/file/ID/thumbnail。
 */

export function pixeldrainListId(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.hostname.toLowerCase().replace(/^www\./, "") !== "pixeldrain.com") return null;
    return /^\/l\/(\w{6,20})/.exec(u.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

export interface PixeldrainFile {
  src: string;
  thumb: string;
  name: string;
  kind: "video" | "image";
}

export async function pixeldrainList(id: string, signal: AbortSignal): Promise<PixeldrainFile[]> {
  const { res } = await safeFetch(`https://pixeldrain.com/api/list/${encodeURIComponent(id)}`, {
    signal,
    timeoutMs: 10000,
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return [];
  }
  const json = (await res.json().catch(() => null)) as { files?: { id?: unknown; name?: unknown; mime_type?: unknown }[] } | null;
  const out: PixeldrainFile[] = [];
  for (const f of (json?.files ?? []).slice(0, 500)) {
    if (typeof f?.id !== "string" || !/^\w{6,20}$/.test(f.id)) continue;
    const mime = typeof f.mime_type === "string" ? f.mime_type : "";
    const kind = mime.startsWith("video/") ? "video" : mime.startsWith("image/") ? "image" : null;
    if (!kind) continue;
    out.push({
      src: `https://pixeldrain.com/api/file/${f.id}`,
      thumb: `https://pixeldrain.com/api/file/${f.id}/thumbnail`,
      name: typeof f.name === "string" ? f.name.slice(0, 120) : "",
      kind,
    });
  }
  return out;
}
