import { guardApi } from "@/lib/access/locks";
import { db, dbConfigured } from "@/lib/thumbs/db";
import { runPatrol } from "@/lib/thumbs/patrol";

/**
 * サーバー側の自動巡回の設定と、たまった結果の受け渡し。
 *   GET  ?since=時刻（ミリ秒）… 設定と、その時刻より後に見つかったもの
 *   POST { sites, intervalMin, exclude, gofileToken } … 巡回するサイトと間隔を保存
 *   POST { run: true } … 今すぐ巡回
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const isHttp = (v: unknown): v is string => typeof v === "string" && /^https?:\/\//.test(v) && v.length < 2000;

export async function GET(request: Request) {
  const denied = await guardApi(request, "/api/thumbs/patrol");
  if (denied) return denied;
  if (!dbConfigured()) return Response.json({ configured: false });
  try {
    const pool = await db();
    if (!pool) return Response.json({ configured: false });
    const since = Number(new URL(request.url).searchParams.get("since")) || 0;
    const sites = await pool.query(
      "select url, interval_min, extract(epoch from last_run) * 1000 as last_run, last_found, last_note from thumbs_patrol_sites order by created_at",
    );
    const items = await pool.query(
      `select id, site_url, kind, data, extract(epoch from found_at) * 1000 as found_at from thumbs_patrol_items
       where found_at > to_timestamp($1 / 1000.0) order by found_at asc limit 3000`,
      [since],
    );
    return Response.json({
      configured: true,
      now: Date.now(),
      sites: sites.rows.map((r) => ({ url: r.url, intervalMin: r.interval_min, lastRun: r.last_run ? Math.round(Number(r.last_run)) : null, lastFound: r.last_found, lastNote: r.last_note })),
      items: items.rows.map((r) => ({ id: r.id, siteUrl: r.site_url, kind: r.kind, data: r.data, foundAt: Math.round(Number(r.found_at)) })),
    });
  } catch (err) {
    return Response.json({ configured: true, error: err instanceof Error ? err.message.slice(0, 200) : String(err) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const denied = await guardApi(request, "/api/thumbs/patrol");
  if (denied) return denied;
  if (!dbConfigured()) return Response.json({ configured: false });
  let body: { run?: unknown; sites?: unknown; intervalMin?: unknown; exclude?: unknown; gofileToken?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "リクエストの形式が正しくありません" }, { status: 400 });
  }
  try {
    const pool = await db();
    if (!pool) return Response.json({ configured: false });
    if (body.run === true) return Response.json({ configured: true, ...(await runPatrol((maxDuration - 30) * 1000, true)) });

    const interval = typeof body.intervalMin === "number" && body.intervalMin >= 0 && body.intervalMin <= 1440 ? Math.round(body.intervalMin) : 0;
    const sites = (Array.isArray(body.sites) ? body.sites : [])
      .filter((s): s is { url: string; settings?: unknown } => !!s && typeof s === "object" && isHttp((s as { url?: unknown }).url))
      .slice(0, 10);
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("delete from thumbs_patrol_sites where not (url = any($1))", [sites.map((s) => s.url)]);
      for (const s of sites) {
        await client.query(
          `insert into thumbs_patrol_sites (url, settings, interval_min) values ($1, $2, $3)
           on conflict (url) do update set settings = excluded.settings, interval_min = excluded.interval_min`,
          [s.url, JSON.stringify(s.settings && typeof s.settings === "object" ? s.settings : {}), interval],
        );
      }
      const exclude = Array.isArray(body.exclude) ? body.exclude.filter((r): r is string => typeof r === "string" && r.length < 300).slice(0, 200) : [];
      const token = typeof body.gofileToken === "string" && /^[A-Za-z0-9]{10,128}$/.test(body.gofileToken.trim()) ? body.gofileToken.trim() : "";
      for (const [key, value] of [
        ["exclude", exclude],
        ["gofileToken", token],
      ] as const) {
        await client.query("insert into thumbs_patrol_meta (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value", [key, JSON.stringify(value)]);
      }
      await client.query("commit");
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return Response.json({ configured: true, saved: sites.length, intervalMin: interval });
  } catch (err) {
    return Response.json({ configured: true, error: err instanceof Error ? err.message.slice(0, 200) : String(err) }, { status: 500 });
  }
}
