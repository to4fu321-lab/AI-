import { createHash, randomBytes } from "node:crypto";
import { guardApi, safeEqual } from "@/lib/access/locks";
import { createSession, currentUser, finishLogin, loginUrl, sessionCookie } from "@/lib/migrate/auth";
import { UserError } from "@/lib/migrate/db";
import { authUrl, finishConnect, googleConfigured } from "@/lib/migrate/gmail";

/**
 * Google とのやり取りの入口。
 * - /api/migrate/oauth/login    … 「Google でログイン」。受け取るのは「誰か」だけ
 * - /api/migrate/oauth/connect  … メールボックスをつなぐ（ログイン済みの利用者だけ）。Gmail を読む許可を受け取る
 * - /api/migrate/oauth/callback … どちらも、Google からここへ戻ってくる（戻り先の登録が 1 つで済む）
 * 始めた手続きの種類・合言葉・（つなぐときは）始めた利用者を、短い間だけ Cookie に入れておき、戻ってきたときに照らし合わせる。
 * 画面へ戻すときに渡すのは、結果の記号だけ（自由な文は URL に載せない。にせの文を画面に出させないため）
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COOKIE = "__Host-mg_oauth";
const flowCookie = (value: string, maxAge: number) => `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
const random = () => randomBytes(24).toString("base64url");
/** 手続きを始めた利用者の印（番号そのものは Cookie に入れない） */
const userMark = (userId: string, state: string) => createHash("sha256").update(`${userId}|${state}`).digest("base64url");

export async function GET(request: Request, { params }: { params: Promise<{ step: string }> }) {
  const { step } = await params;
  const denied = await guardApi(request, `/api/migrate/oauth/${step}`);
  if (denied) return denied;
  const url = new URL(request.url);
  const back = (result: string, cookies: string[] = []) => {
    const headers = new Headers({ location: `${url.origin}/migrate?${new URLSearchParams({ result })}`, "cache-control": "no-store" });
    for (const c of [flowCookie("", 0), ...cookies]) headers.append("set-cookie", c);
    return new Response(null, { status: 303, headers });
  };
  const start = (location: string, flow: string) =>
    new Response(null, { status: 303, headers: { location, "set-cookie": flowCookie(flow, 600), "cache-control": "no-store" } });

  if (step !== "login" && step !== "connect" && step !== "callback") return Response.json({ error: "その操作はありません" }, { status: 404 });
  if (!googleConfigured()) return back("not-configured");

  try {
    if (step === "login") {
      const state = random();
      const nonce = random();
      return start(loginUrl(url.origin, state, nonce), `login.${state}.${nonce}`);
    }

    if (step === "connect") {
      const user = await currentUser(request);
      if (!user) return back("login-required");
      const state = random();
      return start(authUrl(url.origin, state), `gmail.${state}.${userMark(user.id, state)}`);
    }

    // callback
    const [kind, saved, extra] = (new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(request.headers.get("cookie") ?? "")?.[1] ?? "").split(".");
    const state = url.searchParams.get("state") ?? "";
    if (!state || !saved || !safeEqual(state, saved)) return back("bad-state");
    if (url.searchParams.get("error")) return back("denied");
    const code = url.searchParams.get("code");
    if (!code) return back("denied");

    if (kind === "login" && extra) {
      const user = await finishLogin(code, url.origin, extra);
      return back("login", [sessionCookie(await createSession(user.id))]);
    }
    if (kind === "gmail" && extra) {
      // つなぐ先は、手続きを始めた利用者。途中でログインが切れたり、別の人に替わっていたら、つながない
      const user = await currentUser(request);
      if (!user || !safeEqual(extra, userMark(user.id, state))) return back("login-changed");
      await finishConnect(user.id, code, url.origin);
      return back("connected");
    }
    return back("bad-state");
  } catch (err) {
    // 利用者に見せてよい理由（UserError）は、記号に直して渡す。それ以外は中身を見せない
    console.error(`[migrate] oauth ${step}`, err);
    const known = ["too-many", "scope", "unverified", "no-token-key"];
    return back(err instanceof UserError && known.includes(err.code) ? err.code : "failed");
  }
}
