import { guardApi } from "@/lib/access/locks";
import { dbConfigured } from "@/lib/thumbs/db";
import { disconnect, driveSelfTest, driveStatus, redirectUri } from "@/lib/thumbs/drive";

/**
 * 「復活したら保存」の保存先としての Google ドライブ。
 * GET：つながっているか（つなぐのに Google Cloud に登録する戻り先 URL も返す）
 * POST { action: "disconnect" }：つながりを切る（保存した動画はドライブに残る）
 *      { action: "test" }：テスト保存（9MB を保存→読み戻し→消す）
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

export async function GET(request: Request) {
  const denied = await guardApi(request, "/api/thumbs/drive");
  if (denied) return denied;
  const origin = new URL(request.url).origin;
  const status = await driveStatus();
  return Response.json({ ...status, database: dbConfigured(), redirectUri: redirectUri(origin) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  const denied = await guardApi(request, "/api/thumbs/drive");
  if (denied) return denied;
  const body = (await request.json().catch(() => ({}))) as { action?: unknown };
  if (body.action === "test") return Response.json(await driveSelfTest(), { headers: { "cache-control": "no-store" } });
  if (body.action !== "disconnect") return Response.json({ error: "action が正しくありません" }, { status: 400 });
  await disconnect();
  return Response.json({ ok: true });
}
