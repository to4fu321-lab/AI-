import "server-only";
import { crawl } from "./crawl";
import { db } from "./db";
import { thumbsLog } from "./safeFetch";
import { noticeFound, saveFound, watchedPrints } from "./revive";
import type { CrawlOptions, MediaItem } from "./types";

/**
 * サーバー側の自動巡回。登録サイトを、決めた間隔で取得し直して、見つけた動画・タイルをデータベースにためる。
 * 画面は、開いたときにたまっていた分を受け取って並べる（ブラウザを閉じていても巡回は進む）。
 */

/** 巡回する 1 サイトの設定（画面の取得の設定と同じもの） */
export interface PatrolSettings {
  depth?: number;
  maxPages?: number;
  maxPagination?: number;
  crossSite?: boolean;
  render?: "auto" | "always" | "off";
  kinds?: "all" | "video" | "image";
  robots?: boolean;
}

const clampInt = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);

function optionsOf(
  s: PatrolSettings,
  extra: { exclude: string[]; gofileToken?: string; knownGofile: string[]; knownPages?: string[]; knownTweets?: string[] },
): CrawlOptions {
  return {
    depth: clampInt(s.depth, 0, 20, 1),
    // 1 回の巡回で読むページ数は控えめにする（時間の上限があるため）
    maxPages: clampInt(s.maxPages, 1, 150, 60),
    maxPagination: clampInt(s.maxPagination, 0, 50, 5),
    crossSite: s.crossSite === true,
    render: s.render === "always" || s.render === "off" ? s.render : "auto",
    kinds: s.kinds === "video" || s.kinds === "image" ? s.kinds : "all",
    exclude: extra.exclude,
    robots: s.robots !== false,
    gofileToken: extra.gofileToken,
    knownGofile: extra.knownGofile,
    knownPages: extra.knownPages,
    knownTweets: extra.knownTweets,
  };
}

/** 巡回の時刻になっているサイトを、時間の許すかぎり順に巡回する。force なら時刻に関係なく全部 */
export async function runPatrol(budgetMs: number, force = false): Promise<{ ran: number; found: number; note?: string }> {
  const pool = await db();
  if (!pool) return { ran: 0, found: 0, note: "データベースが設定されていません" };
  const started = Date.now();
  const due = await pool.query<{ url: string; settings: PatrolSettings }>(
    `select url, settings from thumbs_patrol_sites
     where interval_min > 0 and ($1 or last_run is null or last_run < now() - make_interval(mins => interval_min))
       -- 前回の巡回が「Gofile に止められている・人間かどうかの確認を出された」で終わったサイトは、60 分たつまで巡回しない
       -- （15 分ごとに問い合わせ続けると、Gofile の制限が解けず、手で取得したときも最初から止められるため）
       and ($1 or last_note is null or (last_note not like '%一時的に止めています%' and last_note not like '%人間かどうかの確認%')
            or last_run < now() - interval '60 minutes')
     order by last_run asc nulls first limit 10`,
    [force],
  );
  const meta = await pool.query<{ key: string; value: unknown }>("select key, value from thumbs_patrol_meta where key in ('exclude', 'gofileToken')");
  const exclude = (meta.rows.find((r) => r.key === "exclude")?.value as string[] | undefined) ?? [];
  const gofileToken = (meta.rows.find((r) => r.key === "gofileToken")?.value as string | undefined) || undefined;
  // 読んだ Gofile のフォルダ（3 日以内）は、もう聞かない
  await pool.query("delete from thumbs_patrol_gofile where at < now() - interval '3 days'");
  const known = (await pool.query<{ code: string }>("select code from thumbs_patrol_gofile order by at desc limit 5000")).rows.map((r) => r.code);

  // 「復活したら保存」で見張っている動画の指紋
  const watched = await watchedPrints().catch(() => new Set<string>());
  let revived = 0;
  let ran = 0;
  let total = 0;
  for (const site of due.rows) {
    const left = budgetMs - (Date.now() - started);
    if (left < 30000) break;
    const abort = new AbortController();
    // 1 サイトにつき最長 100 秒。時間切れの手前で区切る（続きは次の巡回で、最初から読み直す）
    const slice = Math.min(left - 15000, 100000);
    const deadline = Date.now() + slice;
    const hard = setTimeout(() => abort.abort(), slice + 12000);
    let found = 0;
    let note: string | null = null;
    try {
      // このサイトの巡回で、前に動画が見つかったページ・X の投稿は読み直さない（新しく増えた分だけを読む）
      const pages = await pool.query<{ page: string | null }>(
        "select data->>'pageUrl' as page from thumbs_patrol_items where site_url = $1 and kind = 'video' order by found_at desc limit 3000",
        [site.url],
      );
      const knownPages: string[] = [];
      const knownTweets: string[] = [];
      for (const r of pages.rows) {
        if (!r.page) continue;
        const tweet = /(?:twitter|x)\.com\/[^/]+\/status\/(\d{8,20})/.exec(r.page)?.[1];
        if (tweet) knownTweets.push(tweet);
        else if (r.page !== site.url) knownPages.push(r.page);
      }
      const options = optionsOf(site.settings ?? {}, { exclude, gofileToken, knownGofile: known, knownPages, knownTweets });
      for await (const e of crawl(site.url, options, abort.signal, deadline)) {
        if (e.type === "media") {
          if (watched.size) revived += await noticeFound(e.items, watched).catch(() => 0);
          for (const m of e.items) found += await saveItem(site.url, m.kind === "image" ? "image" : "video", m.id, m);
        } else if (e.type === "gated") {
          found += await saveItem(site.url, "gated", `gated:${e.url}`, { url: e.url, thumb: e.thumb, title: e.title, duration: e.duration, video: e.video, app: e.app });
        } else if (e.type === "page" && e.gofile) {
          const code = /gofile\.io\/d\/([\w-]{4,40})/.exec(e.url)?.[1];
          if (code) {
            known.push(code);
            await pool.query("insert into thumbs_patrol_gofile (code) values ($1) on conflict (code) do update set at = now()", [code]);
          }
        } else if (e.type === "note") note = e.message;
        else if (e.type === "continue") break;
      }
    } catch (err) {
      note = `巡回に失敗しました（${err instanceof Error ? err.message.slice(0, 100) : String(err)}）`;
    } finally {
      clearTimeout(hard);
      abort.abort();
    }
    await pool.query("update thumbs_patrol_sites set last_run = now(), last_found = $2, last_note = $3 where url = $1", [site.url, found, note]);
    thumbsLog(`patrol ${site.url.slice(0, 80)} 新しく ${found} 件 ${Date.now() - started}ms ${note ? note.slice(0, 80) : ""}`);
    ran++;
    total += found;
  }
  // 見張っていた動画が見つかっていれば、残りの時間で保存する（今回見つけたもの・前に見つけて保存しきれなかったもの）
  const left = budgetMs - (Date.now() - started);
  if (left > 40000) {
    const r = await saveFound(left - 20000).catch(() => ({ saved: 0, failed: 0 }));
    if (r.saved || r.failed || revived) thumbsLog(`revive 見つけた ${revived} 件・保存 ${r.saved} 件・失敗 ${r.failed} 件`);
  }
  // 2 週間たったものは捨てる（画面が受け取り済みのはずなので）
  await pool.query("delete from thumbs_patrol_items where found_at < now() - interval '14 days'");
  return { ran, found: total };

  /** 見つけたものを 1 件ためる（もうあるものは数えない） */
  async function saveItem(siteUrl: string, kind: string, id: string, data: MediaItem | Record<string, unknown>): Promise<number> {
    const r = await pool!.query("insert into thumbs_patrol_items (id, site_url, kind, data) values ($1, $2, $3, $4) on conflict (id) do nothing", [
      id.slice(0, 2000),
      siteUrl,
      kind,
      JSON.stringify(data),
    ]);
    return r.rowCount ?? 0;
  }
}
