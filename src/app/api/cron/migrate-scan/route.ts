import { after } from "next/server";
import { safeEqual } from "@/lib/access/locks";
import { kick, runPending, selfOrigin } from "@/lib/migrate/scan";

/**
 * アカウント引っ越しの「調べる」の続き。
 * 「調べる」を押した回が時間で区切れたときの続きと、中断で止まったものを、ここで続きから進める。
 * 呼ぶのは、Vercel の定期実行（15 分ごと）と、区切れた回からの引き継ぎ（kick）。
 * 返事はすぐ返し、進めるのはそのあと裏で（呼んだ側を待たせないので、引き継ぎが途中で切れない）。
 * 画面のパスワードの外にあるので、Vercel が付ける合言葉（CRON_SECRET）を持つ呼び出しだけを通す。
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const BUDGET_MS = 240_000;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !safeEqual(request.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const origin = selfOrigin(request);
  const deadline = Date.now() + BUDGET_MS;
  after(async () => {
    try {
      // 時間で区切れたものがあれば、続きを進める回を起こす（15 分後の定期実行を待たない）
      if ((await runPending(deadline)).more) await kick(origin);
    } catch (err) {
      console.error("[migrate] cron", err);
    }
  });
  return Response.json({ started: true });
}
