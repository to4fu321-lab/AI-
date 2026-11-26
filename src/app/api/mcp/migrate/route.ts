import { authenticate, bearerOf } from "@/lib/migrate/grants";
import { handleMcp } from "@/lib/migrate/mcp";
import { resourceMetadataUrl, resourceUrl, SCOPE } from "@/lib/migrate/oauth";
import { selfOrigin } from "@/lib/migrate/scan";

/**
 * アカウント引っ越しの MCP サーバーの入口（AI 秘書から呼ぶ）。
 *
 * 画面のパスワードの鍵の外にある（AI 秘書は画面のパスワードを入れられないため）。
 * そのかわり、呼び出しごとに次のどちらかを必ず確かめる。なければ、何も返さない：
 *  - 利用者が画面で作った鍵（Authorization: Bearer mgk_...）
 *  - 利用者が AI 秘書の側でログインして許可した合言葉（Authorization: Bearer mga_...。OAuth）
 * 鍵がないときは 401 と一緒に「許可はここで取れる」という案内を返す（AI 秘書はそれを見て、許可の手続きを始める）。
 * 状態を持たない作り（呼び出しごとに、鍵の持ち主のためのサーバーを組み立てる）。
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function unauthorized(origin: string | null, presented: boolean): Response {
  const parts = ['Bearer realm="account-migrate"'];
  // 鍵を出したのに通らなかったときだけ、理由（invalid_token）を付ける。AI 秘書は、これを見て合言葉を取り替える
  if (presented) parts.push('error="invalid_token"');
  if (origin) parts.push(`resource_metadata="${resourceMetadataUrl(origin)}"`, `scope="${SCOPE}"`);
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32001, message: "許可がないか、期限が切れています。AI 秘書の側でつなぎ直すか、アカウント引っ越しの画面で鍵を作ってください" }, id: null },
    { status: 401, headers: { "www-authenticate": parts.join(", "), "cache-control": "no-store" } },
  );
}

async function handle(request: Request): Promise<Response> {
  // ブラウザのページからの呼び出しは断る（ほかのサイトが、利用者のブラウザを使って呼ぶのを防ぐ）。AI 秘書のサーバーからの呼び出しには Origin が付かない
  const from = request.headers.get("origin");
  if (from && from !== new URL(request.url).origin) return Response.json({ error: "forbidden" }, { status: 403 });
  const origin = selfOrigin(request);
  let principal = null;
  try {
    principal = origin ? await authenticate(request, resourceUrl(origin)) : null;
  } catch (err) {
    // データベースの一時的な不調を「鍵が違う」と答えない（AI 秘書が、正しい合言葉を捨ててしまう）。少し待ってもう一度、と答える
    console.error("[migrate] mcp authenticate", err instanceof Error ? err.message : err);
    return Response.json({ jsonrpc: "2.0", error: { code: -32000, message: "Temporarily unavailable" }, id: null }, { status: 503, headers: { "retry-after": "5", "cache-control": "no-store" } });
  }
  if (!principal) return unauthorized(origin, bearerOf(request) !== "");
  // 状態を持たない作りなので、サーバーからの通知の流れ（GET）とセッションの終了（DELETE）は受け付けない。
  // 受け付けると、AI 秘書がつないでいる間ずっと通信が開いたままになり、サーバーの時間を使い続ける
  if (request.method !== "POST") return Response.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }, { status: 405, headers: { allow: "POST", "cache-control": "no-store" } });
  return handleMcp(request, principal, origin);
}

export const POST = handle;
// GET と DELETE も、鍵の確かめまでは同じ（鍵がなければ 401 と案内を返す）
export const GET = handle;
export const DELETE = handle;
