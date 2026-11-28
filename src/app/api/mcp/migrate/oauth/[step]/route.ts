import { randomBytes } from "node:crypto";
import { UserError } from "@/lib/migrate/db";
import { callerKey, exchangeToken, OAuthError, registerClient, revokeToken, startAuthorization, throttle } from "@/lib/migrate/oauth";
import { selfOrigin } from "@/lib/migrate/scan";

/**
 * OAuth の入口（AI 秘書が「ログインして許可する」方式でつなぐとき）。中身は lib/migrate/oauth.ts。
 * - GET  authorize … 利用者のブラウザが来る。申し込みを確かめて、許可の画面（/migrate/authorize）へ送る
 * - POST token     … AI 秘書のサーバーが、引換券や refresh を合言葉に換える
 * - POST register  … AI 秘書が、その場で自分を登録する
 * - POST revoke    … AI 秘書が、合言葉を取り消す
 * 画面のパスワードの鍵の外にある（AI 秘書のサーバーは、画面のパスワードを入れられない）。
 * ここではログインの印（Cookie）を一切使わない。利用者の許可は、鍵の内側の画面でだけ受け付ける
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store", pragma: "no-cache", "x-content-type-options": "nosniff" };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
const oauthError = (code: string, description: string, status = 400) => json({ error: code, error_description: description }, status);

/** 戻り先へ飛ばせないときに、その場で見せる画面（相手から届いた文字は、いっさい載せない） */
function rejectPage(reason: string, status = 400): Response {
  const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>つなげませんでした</title><body style="font-family:sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.7"><h1 style="font-size:1.2rem">つなげませんでした</h1><p>${reason}。</p><p>AI 秘書の側で、もう一度つなぎ直してください。</p></body></html>`;
  return new Response(html, {
    status,
    headers: { ...NO_STORE, "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'", "x-frame-options": "DENY", "referrer-policy": "no-referrer" },
  });
}

/** 本文を、大きさの上限つきで読む */
async function readBody(request: Request, max: number): Promise<string> {
  if (Number(request.headers.get("content-length") ?? 0) > max) throw new OAuthError("invalid_request", "request body is too large", 413);
  const text = await request.text();
  if (Buffer.byteLength(text) > max) throw new OAuthError("invalid_request", "request body is too large", 413);
  return text;
}

const contentType = (request: Request) => (request.headers.get("content-type") ?? "").toLowerCase().split(";")[0].trim();

function failed(step: string, err: unknown): Response {
  if (err instanceof OAuthError) return oauthError(err.code, err.message, err.status);
  // 内部のエラーの文は見せない。照らし合わせ用の番号だけ返す（合言葉や引換券は、記録にも残さない）
  const ref = randomBytes(4).toString("hex");
  console.error(`[migrate] oauth ${step} ref=${ref}`, err instanceof UserError ? err.message : err);
  return oauthError("server_error", `internal error (ref ${ref})`, 500);
}

export async function GET(request: Request, { params }: { params: Promise<{ step: string }> }) {
  const { step } = await params;
  if (step !== "authorize") return json({ error: "not_found" }, 404);
  try {
    const origin = selfOrigin(request);
    if (!origin) return rejectPage("サーバーの設定が済んでいません", 503);
    if (!(await throttle(`authorize|${callerKey(request)}`, 30, 600))) return rejectPage("申し込みが多すぎます。10 分ほど待ってください", 429);
    const result = await startAuthorization(new URL(request.url).searchParams, origin);
    if (result.kind === "reject") return rejectPage(result.reason);
    return new Response(null, { status: 303, headers: { ...NO_STORE, location: result.location, "referrer-policy": "no-referrer" } });
  } catch (err) {
    const ref = randomBytes(4).toString("hex");
    console.error(`[migrate] oauth authorize ref=${ref}`, err instanceof UserError ? err.message : err);
    return rejectPage(`うまくいきませんでした（問い合わせ番号 ${ref}）`, 500);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ step: string }> }) {
  const { step } = await params;
  try {
    const origin = selfOrigin(request);
    if (!origin) return oauthError("server_error", "server is not configured", 503);

    if (step === "token" || step === "revoke") {
      // 決まりどおり、フォームの形だけ受け付ける
      if (contentType(request) !== "application/x-www-form-urlencoded") return oauthError("invalid_request", "content-type must be application/x-www-form-urlencoded");
      const form = new URLSearchParams(await readBody(request, 8 * 1024));
      if (step === "revoke") {
        await revokeToken(form);
        return json({});
      }
      return json(await exchangeToken(form, origin));
    }

    if (step === "register") {
      if (contentType(request) !== "application/json") return oauthError("invalid_client_metadata", "content-type must be application/json");
      // 登録はログインなしで呼べるので、回数に上限を付ける（1 つの住所から 1 時間 30 件・全体で 1 時間 2,000 件）
      if (!(await throttle(`register|${callerKey(request)}`, 30, 3600)) || !(await throttle("register|all", 2000, 3600))) return oauthError("temporarily_unavailable", "too many registrations, try again later", 429);
      let body: unknown;
      try {
        body = JSON.parse(await readBody(request, 16 * 1024));
      } catch (e) {
        if (e instanceof OAuthError) throw e;
        return oauthError("invalid_client_metadata", "body must be JSON");
      }
      return json(await registerClient(body), 201);
    }

    return json({ error: "not_found" }, 404);
  } catch (err) {
    return failed(step, err);
  }
}
