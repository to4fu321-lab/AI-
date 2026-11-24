import { guardApi } from "@/lib/access/locks";
import { dbConfigured } from "@/lib/thumbs/db";
import { isPrint, listRevive, reviveConfigured, saveFound, unwatchPrints, watchPrints } from "@/lib/thumbs/revive";

/**
 * 「復活したら保存」の窓口。
 * GET：見張っている動画と、その状態（見張り中・見つけた・保存済み・失敗）
 * POST：{ action: "watch", items: [{ fp, title, thumb, pageUrl }] } 見張りを始める
 *       { action: "unwatch", fps: [...] } 見張りをやめる（保存済みは残す）
 *       { action: "delete", fps: [...] } 保存した動画ごと消す
 *       { action: "save" } 見つけた動画を、今すぐ保存する（巡回を待たずに）
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const denied = await guardApi(request, "/api/thumbs/revive");
  if (denied) return denied;
  const configured = dbConfigured() && reviveConfigured();
  if (!configured) return Response.json({ configured: false, rows: [] });
  try {
    return Response.json({ configured: true, rows: await listRevive() }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return Response.json({ configured: true, rows: [], error: err instanceof Error ? err.message.slice(0, 200) : String(err) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const denied = await guardApi(request, "/api/thumbs/revive");
  if (denied) return denied;
  if (!dbConfigured() || !reviveConfigured()) {
    return Response.json({ error: "保存先（データベース・Blob）が設定されていません" }, { status: 400 });
  }
  let body: { action?: unknown; items?: unknown; fps?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "リクエストの形式が正しくありません" }, { status: 400 });
  }
  const str = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : undefined);
  const fps = Array.isArray(body.fps) ? body.fps.filter(isPrint) : [];
  try {
    if (body.action === "watch") {
      const items = (Array.isArray(body.items) ? body.items : [])
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
        .map((x) => ({
          fp: str(x.fp, 60) ?? "",
          title: str(x.title, 300),
          thumb: str(x.thumb, 2000)?.match(/^https?:\/\//) ? str(x.thumb, 2000) : undefined,
          pageUrl: str(x.pageUrl, 2000)?.match(/^https?:\/\//) ? str(x.pageUrl, 2000) : undefined,
        }))
        .filter((x) => isPrint(x.fp));
      return Response.json({ watched: await watchPrints(items) });
    }
    if (body.action === "unwatch") return Response.json({ removed: await unwatchPrints(fps, false) });
    if (body.action === "delete") return Response.json({ removed: await unwatchPrints(fps, true) });
    if (body.action === "save") return Response.json(await saveFound((maxDuration - 20) * 1000));
    return Response.json({ error: "action が正しくありません" }, { status: 400 });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message.slice(0, 200) : String(err) }, { status: 500 });
  }
}
