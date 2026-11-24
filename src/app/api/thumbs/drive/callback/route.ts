import { guardApi, safeEqual } from "@/lib/access/locks";
import { finishConnect } from "@/lib/thumbs/drive";

/** Google の許可画面から戻ってくるところ。合言葉を確かめて、ドライブを使う合言葉を保存し、アプリの画面へ戻す */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = await guardApi(request, "/api/thumbs/drive/callback");
  if (denied) return denied;
  const url = new URL(request.url);
  const back = (result: string, message?: string) =>
    new Response(null, {
      status: 303,
      headers: {
        location: `${url.origin}/thumbs?${new URLSearchParams({ drive: result, ...(message ? { driveMessage: message.slice(0, 200) } : {}) })}`,
        "set-cookie": "thumbs_drive_state=; Path=/api/thumbs/drive; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
        "cache-control": "no-store",
      },
    });
  const state = url.searchParams.get("state") ?? "";
  const cookie = /(?:^|;\s*)thumbs_drive_state=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1] ?? "";
  if (!state || !cookie || !safeEqual(state, cookie)) return back("error", "つなぐ手続きの確認ができませんでした。もう一度「Google ドライブとつなぐ」からやり直してください");
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
