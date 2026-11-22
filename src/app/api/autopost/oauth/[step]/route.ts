import { guardApi } from "@/lib/access/locks";
import { encryptJson, sign, verifySigned } from "@/lib/autopost/crypto";
import { credsOf, db, getSiteRow, must, UserError } from "@/lib/autopost/db";

export const runtime = "nodejs";

/**
 * YouTube（Google）との連携。
 *   GET /api/autopost/oauth/start?site=<投稿先>   … Google の許可画面へ送る
 *   GET /api/autopost/oauth/callback              … 許可のあと戻ってくる先。更新用トークンを暗号化して保存
 * Google のパスワードはこのサイトを通らない（Google の画面で直接入れる）。
 */
export async function GET(request: Request, { params }: { params: Promise<{ step: string }> }) {
  const denied = await guardApi(request, "/api/autopost");
  if (denied) return denied;
  const { step } = await params;
  const url = new URL(request.url);
  const redirectUri = `${url.origin}/api/autopost/oauth/callback`;
  const back = (message: string) => Response.redirect(`${url.origin}/autopost?tab=sites&notice=${encodeURIComponent(message)}`, 302);

  try {
    if (step === "start") {
      const site = await getSiteRow(url.searchParams.get("site") ?? "");
      const { clientId } = credsOf(site);
      if (site.kind !== "youtube" || !clientId) throw new UserError("先に YouTube のクライアント ID とシークレットを保存してください");
      const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      auth.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "https://www.googleapis.com/auth/youtube.upload",
        access_type: "offline",
        prompt: "consent",
        // 戻ってきたのが自分で始めた連携かを確かめるための署名
        state: `${site.id}.${sign(`oauth|${site.id}`)}`,
      }).toString();
      return Response.redirect(auth.toString(), 302);
    }

    if (step === "callback") {
      const [siteId, signature] = (url.searchParams.get("state") ?? "").split(".");
      const code = url.searchParams.get("code");
      if (!siteId || !signature || !verifySigned(`oauth|${siteId}`, signature)) throw new UserError("連携の確認に失敗しました。もう一度お試しください");
      if (!code) throw new UserError(`Google で許可されませんでした（${url.searchParams.get("error") ?? "取り消し"}）`);
      const site = await getSiteRow(siteId);
      const creds = credsOf(site);
      const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        body: new URLSearchParams({ code, client_id: creds.clientId, client_secret: creds.clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
      });
      const token = (await res.json().catch(() => ({}))) as { refresh_token?: string; error_description?: string };
      if (!res.ok || !token.refresh_token) throw new UserError(`Google との連携に失敗しました：${token.error_description ?? res.status}`);
      must(await db().from("autopost_sites").update({ cred_enc: encryptJson({ ...creds, refreshToken: token.refresh_token }) }).eq("id", site.id).select("id").single());
      return back("YouTube と連携しました");
    }
    return Response.json({ error: "その操作はありません" }, { status: 404 });
  } catch (e) {
    if (e instanceof UserError) return back(e.message);
    console.error("autopost oauth failed", e);
    return back("連携に失敗しました");
  }
}
