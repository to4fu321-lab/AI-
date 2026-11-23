import { runPatrol } from "@/lib/thumbs/patrol";

/**
 * サムネ収集の自動巡回（Vercel の定期実行から呼ばれる）。
 * 画面のパスワードの外にあるので、Vercel が付ける合言葉（CRON_SECRET）で、定期実行からの呼び出しだけを通す。
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    return Response.json(await runPatrol((maxDuration - 30) * 1000));
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message.slice(0, 200) : String(err) }, { status: 500 });
  }
}
