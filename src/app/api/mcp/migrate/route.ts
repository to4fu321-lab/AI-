import { authenticate } from "@/lib/migrate/grants";
import { handleMcp } from "@/lib/migrate/mcp";
import { selfOrigin } from "@/lib/migrate/scan";

/**
 * アカウント引っ越しの MCP サーバーの入口（AI 秘書から呼ぶ）。
 *
 * 画面のパスワードの鍵の外にある（AI 秘書は画面のパスワードを入れられないため）。
 * そのかわり、利用者が画面で作った鍵（Authorization: Bearer mgk_...）を必ず確かめる。鍵がなければ、何も返さない。
 * 状態を持たない作り（呼び出しごとに、鍵の持ち主のためのサーバーを組み立てる）。
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const unauthorized = () =>
  Response.json(
    { jsonrpc: "2.0", error: { code: -32001, message: "鍵がないか、使えない鍵です。アカウント引っ越しの画面で、AI 秘書用の鍵を作ってください" }, id: null },
    { status: 401, headers: { "www-authenticate": 'Bearer realm="account-migrate", error="invalid_token"', "cache-control": "no-store" } },
  );

async function handle(request: Request): Promise<Response> {
  // ブラウザのページからの呼び出しは断る（ほかのサイトが、利用者のブラウザを使って呼ぶのを防ぐ）。AI 秘書のサーバーからの呼び出しには Origin が付かない
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return Response.json({ error: "forbidden" }, { status: 403 });
  const principal = await authenticate(request).catch(() => null);
  if (!principal) return unauthorized();
  return handleMcp(request, principal, selfOrigin(request));
}

export const POST = handle;
// 状態を持たない作りなので、サーバーからの通知の流れ（GET）とセッションの終了（DELETE）は受け付けない
export const GET = handle;
export const DELETE = handle;
