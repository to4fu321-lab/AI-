import { selfOrigin } from "@/lib/migrate/scan";
import { authorizationServerMetadata } from "@/lib/migrate/oauth";

/**
 * 許可を出す側の案内（RFC 8414）。申し込み・引き換え・登録の入口の場所と、対応している方式を知らせる。
 * 誰が読んでもよい中身（秘密は入っていない）
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const origin = selfOrigin(request);
  if (!origin) return Response.json({ error: "server_error" }, { status: 503 });
  return Response.json(authorizationServerMetadata(origin), { headers: { "cache-control": "public, max-age=300" } });
}
