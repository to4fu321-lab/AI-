import { randomBytes } from "node:crypto";
import { guardApi, safeEqual } from "@/lib/access/locks";
import { authUrl, finishConnect, googleConfigured } from "@/lib/migrate/gmail";

/**
 * Gmail をつなぐ手続き。
 * - /api/migrate/oauth/connect  … Google の許可画面へ送る
 * - /api/migrate/oauth/callback … 許可画面から戻ってくるところ
 * 戻ってきたのが本人の操作か確かめる合言葉を、短い間だけ Cookie に入れておく
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COOKIE = "migrate_oauth_state";
const cookie = (value: string, maxAge: number) => `${COOKIE}=${value}; Path=/api/migrate/oauth; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

export async function GET(request: Request, { params }: { params: Promise<{ step: string }> }) {
  const { step } = await params;
  const denied = await guardApi(request, `/api/migrate/oauth/${step}`);
  if (denied) return denied;
  const url = new URL(request.url);
  const back = (result: string, message?: string) =>
    new Response(null, {
      status: 303,
      headers: {
        location: `${url.origin}/migrate?${new URLSearchParams({ gmail: result, ...(message ? { message: message.slice(0, 200) } : {}) })}`,
        "set-cookie": cookie("", 0),
        "cache-control": "no-store",
      },
    });

  if (step === "connect") {
    if (!googleConfigured()) return back("error", "Google Cloud の設定（GOOGLE_MIGRATE_CLIENT_ID・GOOGLE_MIGRATE_CLIENT_SECRET）がまだです");
    const state = randomBytes(24).toString("base64url");
    return new Response(null, { status: 303, headers: { location: authUrl(url.origin, state), "set-cookie": cookie(state, 600), "cache-control": "no-store" } });
  }

  if (step === "callback") {
    const state = url.searchParams.get("state") ?? "";
    const saved = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(request.headers.get("cookie") ?? "")?.[1] ?? "";
    if (!state || !saved || !safeEqual(state, saved)) return back("error", "つなぐ手続きの確認ができませんでした。もう一度「Gmail をつなぐ」からやり直してください");
    if (url.searchParams.get("error")) return back("error", `Google で許可されませんでした（${url.searchParams.get("error")}）`);
    const code = url.searchParams.get("code");
    if (!code) return back("error", "Google から許可の印が届きませんでした");
    try {
      const r = await finishConnect(code, url.origin);
      return back("connected", r.email);
    } catch (err) {
      return back("error", err instanceof Error ? err.message : String(err));
    }
  }

  return Response.json({ error: "その操作はありません" }, { status: 404 });
}
