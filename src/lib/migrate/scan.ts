import "server-only";
import type { PoolClient } from "pg";
import { db, getMailbox, transaction, UserError, type MailboxRow, type ServiceRow } from "./db";
import { isPersonalDomain, parseFrom, serviceDomain, signalsOf } from "./parse";
import { gmailApi } from "./sources/gmailApi";
import { imap } from "./sources/imap";
import { RetryLater, type Header, type MailSession, type MailSource } from "./sources/types";
import type { Signal } from "./types";

/**
 * メールの調べの進行役。
 *
 * - メールを読むのは sources/ の部品（メール会社ごとに差し替える）。ここは、数える・保存する・時間で区切る・二重に動かさない、を受け持つ
 * - 進めるのはサーバー。画面を閉じても続く。時間で区切れたら次の回へ引き継ぎ、止まっても定期実行（/api/cron/migrate-scan）が続きから進める
 * - 数えた結果と「続きの場所」は、ひとまとめに保存する（片方だけ進んで二重に数えることがない）
 */

/** 読み方の部品。メールボックスの source 欄の名前で選ぶ */
const SOURCES: Record<string, MailSource> = { "gmail-api": gmailApi, imap };

/** 「今どこかが進めている」印の長さ。関数の時間の上限（5 分）より長くして、二重に動かさない */
const LOCK = "6 minutes";

interface Tally {
  count: number;
  names: Record<string, number>;
  signals: Partial<Record<Signal, number>>;
  subjects: { s: string; t: number }[];
  first: number;
  last: number;
}

/** 読んだヘッダを、差出人のドメインごとにまとめる */
export function tally(headers: Header[], ownEmail: string): Map<string, Tally> {
  const out = new Map<string, Tally>();
  for (const h of headers) {
    const from = parseFrom(h.from);
    if (!from || from.address === ownEmail || isPersonalDomain(from.address)) continue;
    const domain = serviceDomain(from.address);
    if (!domain) continue;
    const t = out.get(domain) ?? { count: 0, names: {}, signals: {}, subjects: [], first: h.at, last: h.at };
    t.count++;
    if (from.name) t.names[from.name] = (t.names[from.name] ?? 0) + 1;
    for (const s of signalsOf(h.subject)) t.signals[s] = (t.signals[s] ?? 0) + 1;
    if (h.subject) t.subjects.push({ s: h.subject, t: h.at });
    t.first = Math.min(t.first, h.at);
    t.last = Math.max(t.last, h.at);
    out.set(domain, t);
  }
  return out;
}

const SUBJECT_KEEP = 5;
const NAME_KEEP = 8;

/** まとめた分を、データベースの今の数に足しこむ（仕分けの状態やメモは変えない） */
async function merge(pool: PoolClient, mailboxId: string, found: Map<string, Tally>): Promise<void> {
  if (!found.size) return;
  const existing = (await pool.query<ServiceRow>("select * from migrate_services where mailbox_id = $1 and domain = any($2)", [mailboxId, [...found.keys()]])).rows;
  const byDomain = new Map(existing.map((r) => [r.domain, r]));
  const rows = [...found].map(([domain, t]) => {
    const old = byDomain.get(domain);
    const names: Record<string, number> = { ...(old?.names ?? {}) };
    for (const [n, k] of Object.entries(t.names)) names[n] = (names[n] ?? 0) + k;
    const top = Object.entries(names).sort((a, b) => b[1] - a[1]).slice(0, NAME_KEEP);
    const signals: Partial<Record<Signal, number>> = { ...(old?.signals ?? {}) };
    for (const [s, k] of Object.entries(t.signals) as [Signal, number][]) signals[s] = (signals[s] ?? 0) + k;
    const seen = new Set<string>();
    const subjects = [...(old?.subjects ?? []), ...t.subjects]
      .sort((a, b) => b.t - a.t)
      .filter((x) => !seen.has(x.s) && seen.add(x.s))
      .slice(0, SUBJECT_KEEP);
    const first = Math.min(t.first, old?.first_at?.getTime() ?? Infinity);
    const last = Math.max(t.last, old?.last_at?.getTime() ?? 0);
    return {
      domain,
      name: top[0]?.[0] ?? "",
      names: Object.fromEntries(top),
      count: (old?.count ?? 0) + t.count,
      signals,
      subjects,
      first_at: first && Number.isFinite(first) ? new Date(first).toISOString() : null,
      last_at: last ? new Date(last).toISOString() : null,
    };
  });
  await pool.query(
    `insert into migrate_services (mailbox_id, domain, name, names, count, signals, subjects, first_at, last_at)
     select $1, x.domain, x.name, x.names, x.count, x.signals, x.subjects, x.first_at, x.last_at
     from jsonb_to_recordset($2::jsonb) as x(domain text, name text, names jsonb, count integer, signals jsonb, subjects jsonb, first_at timestamptz, last_at timestamptz)
     on conflict (mailbox_id, domain) do update set
       name = excluded.name, names = excluded.names, count = excluded.count, signals = excluded.signals,
       subjects = excluded.subjects, first_at = excluded.first_at, last_at = excluded.last_at, updated_at = now()`,
    [mailboxId, JSON.stringify(rows)],
  );
}

/** 数えた結果を空にする（仕分けの状態・開くページ・メモは残す） */
async function clearCounts(client: PoolClient, mailboxId: string): Promise<void> {
  await client.query("update migrate_services set count = 0, names = '{}', signals = '{}', subjects = '[]', first_at = null, last_at = null where mailbox_id = $1", [mailboxId]);
  await client.query("update migrate_mailboxes set scan = '{}', scanned = 0, remaining = 0, last_scan = null where id = $1", [mailboxId]);
}

/** 調べ始める（印を付けるだけ。進めるのは runScan） */
export async function requestScan(mailboxId: string): Promise<void> {
  const box = await getMailbox(mailboxId);
  await (await db()).query("update migrate_mailboxes set requested = true, error = '' where id = $1", [box.id]);
}

/** 止める（進めている所は、読んでいるひとかたまりを終えたところで止まる） */
export async function stopScan(mailboxId: string): Promise<void> {
  const box = await getMailbox(mailboxId);
  await (await db()).query("update migrate_mailboxes set requested = false where id = $1", [box.id]);
}

/** 数え直すために空にする */
export async function resetScan(mailboxId: string): Promise<void> {
  const box = await getMailbox(mailboxId);
  if (box.requested || (box.lock_until && box.lock_until > new Date())) throw new UserError("調べている途中は数え直せません。「止める」を押して、少し待ってからにしてください");
  await transaction((client) => clearCounts(client, box.id));
}

/** 止まった理由を、画面に出せる言葉にする */
function reason(err: unknown): string {
  if (err instanceof UserError) return err.message;
  const e = err as { authenticationFailed?: boolean; message?: string; responseText?: string };
  if (e?.authenticationFailed) return "メールに入れませんでした。もう一度つなぎ直してください";
  return `読み取りが途中で止まりました（${(e?.responseText || e?.message || String(err)).slice(0, 120)}）。「調べる」でもう一度続きから進めます`;
}

/**
 * 調べを進める。deadline（ミリ秒の時刻）を過ぎたら、そこでやめる（続きの場所は、ひとかたまりごとに保存してある）。
 * 返す値：done＝終わった／止めた、more＝時間で区切れた（すぐ続きを進めてよい）、later＝相手が混み合っている（しばらく置く）、
 * busy＝ほかで進めている最中か、調べる印がない
 */
export async function runScan(mailboxId: string, deadline: number): Promise<"done" | "more" | "later" | "busy"> {
  const pool = await db();
  const claimed = await pool.query<MailboxRow>(
    `update migrate_mailboxes set lock_until = now() + interval '${LOCK}'
     where id = $1 and requested and (lock_until is null or lock_until < now()) returning *`,
    [mailboxId],
  );
  const box = claimed.rows[0];
  if (!box) return "busy";
  let session: MailSession | null = null;
  try {
    const source = SOURCES[box.source];
    if (!source) throw new UserError(`このメールボックスの読み方（${box.source}）は、まだ用意されていません`);
    session = await source.open(box, box.scan ?? {});
    for (;;) {
      if (Date.now() > deadline) return "more";
      const still = await pool.query<{ requested: boolean }>("select requested from migrate_mailboxes where id = $1", [box.id]);
      if (!still.rows[0]?.requested) return "done";
      const batch = await session.next();
      await transaction(async (client) => {
        if (batch.reset) await clearCounts(client, box.id);
        await merge(client, box.id, tally(batch.headers, box.email));
        await client.query(
          `update migrate_mailboxes set scan = $2::jsonb, scanned = scanned + $3, remaining = $4, error = '',
             requested = requested and not $5, last_scan = case when $5 then now() else last_scan end
           where id = $1`,
          [box.id, JSON.stringify(batch.cursor), batch.read, batch.remaining ?? 0, batch.done],
        );
      });
      if (batch.done) return "done";
    }
  } catch (err) {
    if (err instanceof RetryLater) {
      // 調べる印は残す。定期実行が、しばらくしてから続きを進める
      await pool.query("update migrate_mailboxes set error = $2 where id = $1", [box.id, "Gmail が混み合っているので、少し休んでいます。15 分以内に自動で続きを進めます"]).catch(() => {});
      return "later";
    }
    console.error("[migrate] scan", err);
    await pool.query("update migrate_mailboxes set requested = false, error = $2 where id = $1", [box.id, reason(err)]).catch(() => {});
    return "done";
  } finally {
    await session?.close().catch(() => {});
    await pool.query("update migrate_mailboxes set lock_until = null where id = $1", [box.id]).catch(() => {});
  }
}

/** 定期実行から呼ぶ：途中のままのメールボックスを、時間のかぎり進める。時間で区切れたものがあれば true */
export async function runPending(deadline: number): Promise<{ pending: number; more: boolean }> {
  const pool = await db();
  const rows = (await pool.query<{ id: string }>("select id from migrate_mailboxes where requested and (lock_until is null or lock_until < now()) order by created_at")).rows;
  let more = false;
  for (const r of rows) {
    if (Date.now() > deadline) {
      more = true;
      break;
    }
    if ((await runScan(r.id, deadline)) === "more") more = true;
  }
  return { pending: rows.length, more };
}

/**
 * 続きを進める回を、もう 1 つ起こす（時間で区切れたとき）。
 * 自分の定期実行の入口を呼ぶ。入口はすぐ返事を返して裏で進めるので、ここでは返事を受け取るまで待つ。
 * 届かなくても、15 分ごとの定期実行が拾う
 */
export async function kick(origin: string): Promise<void> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return;
  await fetch(`${origin}/api/cron/migrate-scan`, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(15000) }).catch((err) => console.error("[migrate] kick", err));
}
