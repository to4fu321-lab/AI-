import { guardApi } from "@/lib/access/locks";
import { dbConfigured } from "@/lib/thumbs/db";
import { disconnect, driveSelfTest, driveStatus, redirectUri } from "@/lib/thumbs/drive";
import { saveUrlToDrive } from "@/lib/thumbs/revive";

/**
 * 「復活したら保存」の保存先としての Google ドライブ。
 * GET：つながっているか（つなぐのに Google Cloud に登録する戻り先 URL も返す）
 * POST { action: "disconnect" }：つながりを切る（保存した動画はドライブに残る）
 *      { action: "save", item: { src, pageUrl, referer, cookie, title } }：一覧の動画・画像をドライブに保存
 *      { action: "test" }：テスト保存（9MB を保存→読み戻し→消す）
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

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
  const body = (await request.json().catch(() => ({}))) as { action?: unknown; item?: Record<string, unknown> };
  if (body.action === "save") {
    const it = body.item ?? {};
    const str = (v: unknown) => (typeof v === "string" && v.length <= 4000 ? v : undefined);
    const src = str(it.src);
    if (!src || !/^https?:\/\//.test(src)) return Response.json({ error: "保存するものの URL が正しくありません" }, { status: 400 });
    const ref = str(it.referer) ?? str(it.pageUrl);
    try {
      const r = await saveUrlToDrive({
        src,
        referer: ref && /^https?:\/\//.test(ref) ? ref : undefined,
        cookie: str(it.cookie),
        title: str(it.title)?.slice(0, 200),
        budgetMs: 280000,
      });
      return Response.json({ ok: true, ...r });
    } catch (err) {
      const message = err instanceof Error ? (err.name === "TimeoutError" ? "時間内に保存し終わりませんでした（大きすぎるか、元のサイトが遅いです）" : err.message) : String(err);
      return Response.json({ ok: false, error: message.slice(0, 300) }, { status: 502 });
    }
  }
  if (body.action === "test") return Response.json(await driveSelfTest(), { headers: { "cache-control": "no-store" } });
  if (body.action !== "disconnect") return Response.json({ error: "action が正しくありません" }, { status: 400 });
  await disconnect();
  return Response.json({ ok: true });
}
