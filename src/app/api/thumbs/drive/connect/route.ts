import { randomBytes } from "node:crypto";
import { guardApi } from "@/lib/access/locks";
import { authUrl, driveConfigured } from "@/lib/thumbs/drive";

/** Google の許可画面へ送る（戻ってきたのが本人の操作か確かめる合言葉を、短い間だけ Cookie に入れておく） */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = await guardApi(request, "/api/thumbs/drive/connect");
  if (denied) return denied;
  const origin = new URL(request.url).origin;
  if (!driveConfigured()) return Response.redirect(`${origin}/thumbs?drive=notconfigured`, 303);
  const state = randomBytes(24).toString("base64url");
  return new Response(null, {
    status: 303,
    headers: {
      location: authUrl(origin, state),
      "set-cookie": `thumbs_drive_state=${state}; Path=/api/thumbs/drive; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
      "cache-control": "no-store",
    },
  });
}
