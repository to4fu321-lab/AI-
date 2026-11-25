import { guardApi } from "@/lib/access/locks";
import { dbConfigured } from "@/lib/thumbs/db";
import { addSub, hasSub, isPushSub, pushAll, pushPublicKey, removeSub } from "@/lib/thumbs/push";

/**
 * 新着のプッシュ通知。
 * GET ?endpoint=…：公開鍵と、この端末が登録済みか
 * POST { action: "subscribe", sub, label }：この端末で受け取る
 *      { action: "unsubscribe", endpoint }：この端末ではもう受け取らない
 *      { action: "test" }：試しに送る
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = await guardApi(request, "/api/thumbs/push");
  if (denied) return denied;
  if (!dbConfigured()) return Response.json({ configured: false });
  const endpoint = new URL(request.url).searchParams.get("endpoint");
  return Response.json(
    { configured: true, publicKey: await pushPublicKey(), subscribed: endpoint ? await hasSub(endpoint) : false },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const denied = await guardApi(request, "/api/thumbs/push");
  if (denied) return denied;
  const body = (await request.json().catch(() => ({}))) as { action?: unknown; sub?: unknown; endpoint?: unknown; label?: unknown };
  try {
    if (body.action === "subscribe") {
      if (!isPushSub(body.sub)) return Response.json({ error: "宛先が正しくありません" }, { status: 400 });
      await addSub(body.sub, typeof body.label === "string" ? body.label : "");
      return Response.json({ ok: true });
    }
    if (body.action === "unsubscribe") {
      if (typeof body.endpoint === "string") await removeSub(body.endpoint);
      return Response.json({ ok: true });
    }
    if (body.action === "test") {
      const sent = await pushAll({ title: "サムネ収集", body: "🔔 通知のテストです。新しい動画が見つかると、こんなふうに届きます", tag: "test" });
      return Response.json({ ok: sent > 0, sent });
    }
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
  return Response.json({ error: "action が正しくありません" }, { status: 400 });
}
