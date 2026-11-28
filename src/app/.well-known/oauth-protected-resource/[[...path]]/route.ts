import { selfOrigin } from "@/lib/migrate/scan";
import { MCP_PATH, protectedResourceMetadata } from "@/lib/migrate/oauth";

/**
 * 「この MCP サーバーの許可は、どこで取れるか」の案内（RFC 9728）。AI 秘書が最初に読む。
 * 決まりの置き場所は 2 つあり、どちらでも同じものを返す：
 *   /.well-known/oauth-protected-resource/api/mcp/migrate（MCP の入口のパス付き）と、/.well-known/oauth-protected-resource
 * 誰が読んでもよい中身（秘密は入っていない）
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ path?: string[] }> }) {
  const { path } = await params;
  const suffix = path?.length ? `/${path.join("/")}` : "";
  if (suffix && suffix !== MCP_PATH) return Response.json({ error: "not_found" }, { status: 404 });
  const origin = selfOrigin(request);
  if (!origin) return Response.json({ error: "server_error" }, { status: 503 });
  return Response.json(protectedResourceMetadata(origin), { headers: { "cache-control": "public, max-age=300" } });
}
