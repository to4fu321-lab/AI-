import "server-only";
import { del, get, put } from "@vercel/blob";
import { db } from "./db";
import { deleteFromDrive, driveConfigured, driveTarget, readFromDrive, uploadToDrive } from "./drive";
import { CookieJar, safeFetch, thumbsLog } from "./safeFetch";
import { isReviveKey, nameKey, urlKey } from "./reviveKey";
import { mediaMime } from "./sniff";
import type { MediaItem } from "./types";

/**
 * 「復活したら保存」。
 *
 * リンク切れになった動画のうち、画面で 🔔 を付けたものの「指紋」（ファイル全体の大きさ＋先頭の要約。MediaItem.fp）を覚えておく。
 * 巡回・取得で同じ指紋の動画が見つかったら（別の URL・別の Gofile のフォルダに上げ直されていても同じファイルならわかる）、
 * サーバーがその動画を Vercel Blob（非公開の保管場所）に保存する。
 * 保存した動画は、このアプリのパスワードで守られた窓口（/api/thumbs/revive/file）からだけ見られる。
 *
 * 状態：watch（見張り中）→ found（見つけた・保存待ち）→ saving（保存中）→ saved（保存済み）／ failed（失敗・次の巡回でまた探す）
 */

/** 1 本あたりの大きさの上限（これより大きい動画は保存しない） */
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** 保存中のまま止まった（時間切れで落ちた）ものを、保存待ちに戻すまでの時間 */
const STUCK_MS = 15 * 60 * 1000;

export function reviveConfigured(): boolean {
  return blobConfigured() || driveConfigured();
}

/** Vercel Blob（保存先その 1）が使えるか */
function blobConfigured(): boolean {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

export interface ReviveRow {
  fp: string;
  status: "watch" | "found" | "saving" | "saved" | "failed";
  title: string | null;
  thumb: string | null;
  size: number | null;
  note: string | null;
  savedAt: number | null;
  foundAt: number | null;
  /** Google ドライブに保存したときの、ドライブのファイルの番号 */
  driveId: string | null;
}

/** 見張りの鍵として正しい形か（指紋 "大きさ:要約"・URL の鍵 "u:…"・名前の鍵 "n:…"） */
export const isPrint = isReviveKey;

/** 保管場所での名前（指紋の「:」などは使えないので置き換える） */
const pathOf = (fp: string, ext: string) => `revive/${fp.replace(/[^a-z0-9]/gi, "_")}.${ext}`;

const EXT_BY_TYPE: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
  "video/mp2t": "ts",
  "video/x-flv": "flv",
  "video/x-msvideo": "avi",
  "video/3gpp": "3gp",
  "video/mpeg": "mpg",
  "video/ogg": "ogv",
};

export async function listRevive(): Promise<ReviveRow[]> {
  const pool = await db();
  if (!pool) return [];
  const r = await pool.query<{
    fp: string;
    status: ReviveRow["status"];
    title: string | null;
    thumb: string | null;
    size: string | null;
    note: string | null;
    saved_at: string | null;
    found_at: string | null;
    blob_path: string | null;
  }>(
    `select fp, status, title, thumb, size, note, blob_path,
            extract(epoch from saved_at) * 1000 as saved_at, extract(epoch from found_at) * 1000 as found_at
     from thumbs_revive order by updated_at desc limit 5000`,
  );
  return r.rows.map((x) => ({
    fp: x.fp,
    status: x.status,
    title: x.title,
    thumb: x.thumb,
    size: x.size === null ? null : Number(x.size),
    note: x.note,
    savedAt: x.saved_at === null ? null : Math.round(Number(x.saved_at)),
    foundAt: x.found_at === null ? null : Math.round(Number(x.found_at)),
    driveId: x.blob_path?.startsWith("drive:") ? x.blob_path.slice(6) : null,
  }));
}

/** 見張りを始める（保存済みのものは、そのまま） */
export async function watchPrints(list: { fp: string; title?: string; thumb?: string; pageUrl?: string; duration?: number }[]): Promise<number> {
  const pool = await db();
  if (!pool) return 0;
  let n = 0;
  for (const w of list.slice(0, 500)) {
    if (!isPrint(w.fp)) continue;
    const duration = typeof w.duration === "number" && Number.isFinite(w.duration) && w.duration > 0 ? w.duration : null;
    await pool.query(
      `insert into thumbs_revive (fp, title, thumb, page_url, name_key, duration) values ($1, $2, $3, $4, $5, $6)
       on conflict (fp) do update set
         status = case when thumbs_revive.status in ('saved', 'found', 'saving') then thumbs_revive.status else 'watch' end,
         title = coalesce(thumbs_revive.title, excluded.title),
         thumb = coalesce(thumbs_revive.thumb, excluded.thumb),
         page_url = coalesce(thumbs_revive.page_url, excluded.page_url),
         name_key = coalesce(thumbs_revive.name_key, excluded.name_key),
         duration = coalesce(thumbs_revive.duration, excluded.duration),
         updated_at = now()`,
      [w.fp, w.title?.slice(0, 300) ?? null, w.thumb?.slice(0, 2000) ?? null, w.pageUrl?.slice(0, 2000) ?? null, nameKey(w.title), duration],
    );
    n++;
  }
  return n;
}

/** 見張りをやめる。保存済みの動画も消すときは withFile */
export async function unwatchPrints(fps: string[], withFile: boolean): Promise<number> {
  const pool = await db();
  if (!pool) return 0;
  const ok = fps.filter(isPrint).slice(0, 500);
  if (!ok.length) return 0;
  if (withFile) {
    const rows = await pool.query<{ blob_path: string | null }>("select blob_path from thumbs_revive where fp = any($1) and blob_path is not null", [ok]);
    const paths = rows.rows.map((r) => r.blob_path!).filter(Boolean);
    const blobs = paths.filter((p) => !p.startsWith("drive:"));
    if (blobs.length && blobConfigured()) await del(blobs).catch(() => {});
    for (const p of paths.filter((x) => x.startsWith("drive:"))) await deleteFromDrive(p.slice(6)).catch(() => {});
    const r = await pool.query("delete from thumbs_revive where fp = any($1)", [ok]);
    return r.rowCount ?? 0;
  }
  // 保存済み・保存中のものは残す（動画を消すときは withFile で）
  const r = await pool.query("delete from thumbs_revive where fp = any($1) and status not in ('saved', 'saving')", [ok]);
  return r.rowCount ?? 0;
}

/** 見張っている指紋（見張り中・失敗したもの）。巡回・取得の最初に読む */
/** 見張っているものの一覧（鍵 → 見張りの行）。指紋・URL の鍵のほか、名前の鍵でも引ける */
export type Watched = Map<string, { fp: string; duration: number | null; byName: boolean }>;

export async function watchedPrints(): Promise<Watched> {
  const out: Watched = new Map();
  if (!reviveConfigured()) return out;
  const pool = await db().catch(() => null);
  if (!pool) return out;
  const r = await pool.query<{ fp: string; name_key: string | null; duration: number | null }>(
    "select fp, name_key, duration from thumbs_revive where status in ('watch', 'failed') limit 20000",
  );
  for (const x of r.rows) {
    out.set(x.fp, { fp: x.fp, duration: x.duration, byName: false });
    if (x.name_key && !out.has(x.name_key)) out.set(x.name_key, { fp: x.fp, duration: x.duration, byName: true });
  }
  return out;
}

/**
 * 巡回・取得で見つけた動画のうち、見張っている指紋と同じものを「見つけた」にする（保存は saveFound で）。
 * 見つけた数を返す
 */
export async function noticeFound(items: MediaItem[], watched: Watched): Promise<number> {
  if (!watched.size) return 0;
  const hits: { m: MediaItem; fp: string }[] = [];
  for (const m of items) {
    if (m.kind !== "video") continue;
    // 確かな順に：指紋 → ファイルの URL → 名前（名前のときは、長さがわかれば長さも同じものだけ）
    for (const k of [m.fp, urlKey(m), nameKey(m.title)]) {
      const w = k ? watched.get(k) : undefined;
      if (!w) continue;
      if (w.byName && w.duration && m.duration && Math.abs(w.duration - m.duration) > 3) continue;
      if (!hits.some((h) => h.fp === w.fp)) hits.push({ m, fp: w.fp });
      break;
    }
  }
  if (!hits.length) return 0;
  const pool = await db().catch(() => null);
  if (!pool) return 0;
  let n = 0;
  for (const { m, fp } of hits) {
    const r = await pool.query(
      `update thumbs_revive set status = 'found', found_src = $2, found_page = $3, found_referer = $4, found_cookie = $5,
         found_at = now(), note = null, updated_at = now(), thumb = coalesce(thumb, $6), title = coalesce(title, $7)
       where fp = $1 and status in ('watch', 'failed')`,
      [fp, m.src, m.pageUrl, m.referer ?? m.pageUrl, m.cookie ?? null, m.thumb ?? null, m.title ?? null],
    );
    if (r.rowCount) {
      for (const [k, w] of watched) if (w.fp === fp) watched.delete(k);
      n++;
      thumbsLog(`revive found ${fp} ${m.src.slice(0, 100)}`);
    }
  }
  return n;
}

/** 見つけた動画を、時間の許すかぎり Blob に保存する */
export async function saveFound(budgetMs: number): Promise<{ saved: number; failed: number }> {
  if (!reviveConfigured()) return { saved: 0, failed: 0 };
  const pool = await db().catch(() => null);
  if (!pool) return { saved: 0, failed: 0 };
  const started = Date.now();
  // 保存中のまま止まったもの（関数の時間切れなど）は、保存待ちに戻す
  await pool.query(`update thumbs_revive set status = 'found' where status = 'saving' and updated_at < now() - make_interval(secs => $1)`, [STUCK_MS / 1000]);
  let saved = 0;
  let failed = 0;
  /** この回に試したもの（失敗したものは、この回ではもう試さない。次の回でやり直す） */
  const tried: string[] = [];
  for (;;) {
    const left = budgetMs - (Date.now() - started);
    if (left < 20000) break;
    // 1 件ずつ取る（同時に動いている巡回と取り合わないよう、取ったら保存中にする）
    const row = (
      await pool.query<{ fp: string; found_src: string; found_referer: string | null; found_cookie: string | null; title: string | null; tries: number }>(
        `update thumbs_revive set status = 'saving', updated_at = now(), tries = tries + 1
         where fp = (select fp from thumbs_revive where status = 'found' and not (fp = any($1)) order by found_at asc limit 1 for update skip locked)
         returning fp, found_src, found_referer, found_cookie, title, tries`,
        [tried],
      )
    ).rows[0];
    if (!row) break;
    tried.push(row.fp);
    try {
      const result = await saveOne(row.fp, row.found_src, row.found_referer ?? undefined, row.found_cookie ?? undefined, left - 10000, row.title);
      await pool.query(
        `update thumbs_revive set status = 'saved', blob_path = $2, size = $3, content_type = $4, saved_at = now(), note = null, updated_at = now() where fp = $1`,
        [row.fp, result.path, result.size, result.type],
      );
      saved++;
      thumbsLog(`revive saved ${row.fp} ${result.size} bytes ${result.type}`);
    } catch (err) {
      const note = err instanceof Error ? err.message.slice(0, 200) : String(err);
      // 3 回まで試す（それでも駄目なら失敗にして、次に同じ指紋が見つかったときに、また試す）
      await pool.query(`update thumbs_revive set status = $2, note = $3, updated_at = now() where fp = $1`, [row.fp, row.tries >= 3 ? "failed" : "found", note]);
      failed++;
      thumbsLog(`revive failed ${row.fp} ${note}`);
    }
  }
  return { saved, failed };
}

/** 1 本を元のサイトから読みながら、そのまま Blob に書く（サーバーには貯めない） */
async function saveOne(fp: string, src: string, referer: string | undefined, cookie: string | undefined, budgetMs: number, title?: string | null) {
  const signal = AbortSignal.timeout(Math.max(10000, budgetMs));
  const headers: Record<string, string> = { accept: "video/*,*/*;q=0.5" };
  if (referer) headers.referer = referer;
  const { res } = await safeFetch(src, { headers, signal, timeoutMs: 30000, streamBody: true, jar: CookieJar.withItemCookie(undefined, cookie) });
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`元のサイトがエラーを返しました（HTTP ${res.status}）`);
  }
  const total = Number(res.headers.get("content-length"));
  if (total > MAX_BYTES) {
    await res.body.cancel().catch(() => {});
    throw new Error(`大きすぎるため保存しません（${Math.round(total / 1024 / 1024)}MB）`);
  }
  // 先頭の中身で、本当に動画か・どの形式かを確かめてから書く。
  // （流れを 2 つに分ける tee は、片方だけ読むと進まないことがあるので使わない。先頭は自分で読んで、残りとつなげて流す）
  const reader = res.body.getReader();
  const first: Uint8Array[] = [];
  let got = 0;
  while (got < 512) {
    const { done, value } = await reader.read();
    if (done) break;
    first.push(value);
    got += value.byteLength;
  }
  const head = new Uint8Array(got);
  let at = 0;
  for (const c of first) {
    head.set(c, at);
    at += c.byteLength;
  }
  const type = mediaMime(head.subarray(0, 512));
  if (!type || !type.startsWith("video/")) {
    await reader.cancel().catch(() => {});
    throw new Error("中身が動画ではありませんでした（リンク先が変わった可能性があります）");
  }
  const path = pathOf(fp, EXT_BY_TYPE[type] ?? "mp4");
  // 大きさの上限を超えたら止める（大きさを名乗らないサーバーのため、数えながら流す）
  let size = 0;
  const counted = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of first) {
        size += c.byteLength;
        controller.enqueue(c);
      }
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) return controller.close();
      size += value.byteLength;
      if (size > MAX_BYTES) {
        controller.error(new Error("大きすぎるため保存を止めました"));
        await reader.cancel().catch(() => {});
        return;
      }
      controller.enqueue(value);
    },
    cancel() {
      void reader.cancel().catch(() => {});
    },
  });
  // Google ドライブがつながっていれば、ドライブの「サムネ収集（復活保存）」フォルダへ。なければ Vercel Blob（非公開）へ
  const drive = await driveTarget();
  if (drive) {
    const name = `${(title || fp).replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 100)}.${EXT_BY_TYPE[type] ?? "mp4"}`;
    const file = await uploadToDrive(drive, name, type, counted, Number.isFinite(total) && total > 0 ? total : undefined, signal);
    return { path: `drive:${file.id}`, size: file.size || size, type };
  }
  if (!blobConfigured()) {
    await reader.cancel().catch(() => {});
    throw new Error("保存先がありません（Google ドライブをつなぐか、Vercel Blob を用意してください）");
  }
  await put(path, counted, { access: "private", contentType: type, multipart: true, allowOverwrite: true, addRandomSuffix: false, abortSignal: signal });
  return { path, size, type };
}

/** 保存した動画を読む（Range に対応。見つからなければ null） */
export async function openSaved(
  fp: string,
  range: string | null,
): Promise<{ stream: ReadableStream<Uint8Array>; headers: Headers; title: string | null; contentType: string | null; path: string } | null> {
  if (!isPrint(fp)) return null;
  const pool = await db().catch(() => null);
  if (!pool) return null;
  const row = (await pool.query<{ blob_path: string | null; title: string | null; content_type: string | null }>("select blob_path, title, content_type from thumbs_revive where fp = $1 and status = 'saved'", [fp])).rows[0];
  if (!row?.blob_path) return null;
  if (row.blob_path.startsWith("drive:")) {
    // Google ドライブに保存したもの
    const res = await readFromDrive(row.blob_path.slice(6), range);
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    return { stream: res.body, headers: res.headers, title: row.title, contentType: row.content_type, path: row.blob_path };
  }
  if (!blobConfigured()) return null;
  const blob = await get(row.blob_path, { access: "private", headers: range ? { range } : undefined });
  if (!blob || blob.statusCode !== 200) return null;
  // （Blob の部品が返す Headers は、型の定義だけが標準と少し違う。中身は同じ）
  return { stream: blob.stream as ReadableStream<Uint8Array>, headers: blob.headers as unknown as Headers, title: row.title, contentType: row.content_type ?? blob.blob.contentType, path: row.blob_path };
}
