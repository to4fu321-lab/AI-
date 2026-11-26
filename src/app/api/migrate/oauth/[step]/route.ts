import { randomBytes } from "node:crypto";
import { guardApi, safeEqual } from "@/lib/access/locks";
import { createSession, currentUser, finishLogin, loginUrl, sessionCookie } from "@/lib/migrate/auth";
import { authUrl, finishConnect, googleConfigured } from "@/lib/migrate/gmail";

/**
 * Google とのやり取りの入口。
 * - /api/migrate/oauth/login    … 「Google でログイン」。受け取るのは「誰か」だけ
 * - /api/migrate/oauth/connect  … メールボックスをつなぐ（ログイン済みの利用者だけ）。Gmail を読む許可を受け取る
 * - /api/migrate/oauth/callback … どちらも、Google からここへ戻ってくる（戻り先の登録が 1 つで済む）
 * 始めた手続きの種類と合言葉を、短い間だけ Cookie に入れておき、戻ってきたときに照らし合わせる
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COOKIE = "migrate_oauth_state";
const flowCookie = (value: string, maxAge: number) => `${COOKIE}=${value}; Path=/api/migrate/oauth; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
const random = () => randomBytes(24).toString("base64url");

export async function GET(request: Request, { params }: { params: Promise<{ step: string }> }) {
  const { step } = await params;
  const denied = await guardApi(request, `/api/migrate/oauth/${step}`);
  if (denied) return denied;
  const url = new URL(request.url);
  const back = (query: Record<string, string>, cookies: string[] = []) => {
    const headers = new Headers({ location: `${url.origin}/migrate?${new URLSearchParams(query)}`, "cache-control": "no-store" });
    for (const c of [flowCookie("", 0), ...cookies]) headers.append("set-cookie", c);
    return new Response(null, { status: 303, headers });
  };
  const fail = (message: string) => back({ result: "error", message: message.slice(0, 200) });
  const start = (location: string, flow: string) =>
    new Response(null, { status: 303, headers: { location, "set-cookie": flowCookie(flow, 600), "cache-control": "no-store" } });

  if (step !== "login" && step !== "connect" && step !== "callback") return Response.json({ error: "その操作はありません" }, { status: 404 });
  if (!googleConfigured()) return fail("Google Cloud の設定（GOOGLE_MIGRATE_CLIENT_ID・GOOGLE_MIGRATE_CLIENT_SECRET）がまだです");

  try {
    if (step === "login") {
      const state = random();
      const nonce = random();
      return start(loginUrl(url.origin, state, nonce), `login.${state}.${nonce}`);
    }

    if (step === "connect") {
      if (!(await currentUser(request))) return fail("先にログインしてください");
      const state = random();
      return start(authUrl(url.origin, state), `gmail.${state}`);
    }

    // callback
    const [kind, saved, nonce] = (new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(request.headers.get("cookie") ?? "")?.[1] ?? "").split(".");
    const state = url.searchParams.get("state") ?? "";
    if (!state || !saved || !safeEqual(state, saved)) return fail("手続きの確認ができませんでした。もう一度やり直してください");
    if (url.searchParams.get("error")) return fail(`Google で許可されませんでした（${url.searchParams.get("error")}）`);
    const code = url.searchParams.get("code");
    if (!code) return fail("Google から許可の印が届きませんでした");

    if (kind === "login" && nonce) {
      const user = await finishLogin(code, url.origin, nonce);
      return back({ result: "login" }, [sessionCookie(await createSession(user.id))]);
    }
    if (kind === "gmail") {
      // つなぐ先は、いまログインしている利用者。手続きの途中でログインが切れていたら、つながない
      const user = await currentUser(request);
      if (!user) return fail("ログインが切れました。ログインしてから、もう一度つないでください");
      const r = await finishConnect(user.id, code, url.origin);
      return back({ result: "connected", message: r.email });
    }
    return fail("手続きの確認ができませんでした。もう一度やり直してください");
  } catch (err) {
    console.error(`[migrate] oauth ${step}`, err);
    return fail(err instanceof Error ? err.message : String(err));
  }
}
