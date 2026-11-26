import { guardApi } from "@/lib/access/locks";
import { dbConfigured } from "@/lib/thumbs/db";
import { addToken, MAX_TOKENS, removeToken, tokenView } from "@/lib/thumbs/gofileTokens";

/**
 * 自動巡回で使う Gofile のトークン（利用者ごとに 1 つずつ）。
 * GET：一覧（名前・最後の 4 文字・断られているか）。トークンそのものは返さない
 * POST { action: "add", label, token } / { action: "remove", tag }
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = await guardApi(request, "/api/thumbs/gofile-tokens");
  if (denied) return denied;
  if (!dbConfigured()) return Response.json({ configured: false, tokens: [] });
  return Response.json({ configured: true, max: MAX_TOKENS, tokens: await tokenView() }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  const denied = await guardApi(request, "/api/thumbs/gofile-tokens");
  if (denied) return denied;
  if (!dbConfigured()) return Response.json({ error: "データベースが設定されていません" }, { status: 400 });
  const body = (await request.json().catch(() => ({}))) as { action?: unknown; label?: unknown; token?: unknown; tag?: unknown };
  try {
    if (body.action === "add" && typeof body.token === "string") await addToken(typeof body.label === "string" ? body.label : "", body.token);
    else if (body.action === "remove" && typeof body.tag === "string") await removeToken(body.tag);
    else return Response.json({ error: "action が正しくありません" }, { status: 400 });
    return Response.json({ ok: true, tokens: await tokenView() });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
