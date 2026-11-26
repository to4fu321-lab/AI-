import "server-only";
import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { classify, LOGIN_KINDS, RULES_VERSION, type Kind } from "./classify";
import { db, getMailbox, transaction, UserError, type MailboxRow } from "./db";
import { clean, isPersonalDomain, maskSecrets, parseFrom, serviceDomain } from "./parse";
import { gmailApi } from "./sources/gmailApi";
import { imap } from "./sources/imap";
import { RetryLater, type Header, type MailSession, type MailSource } from "./sources/types";

/**
 * メールの調べの進行役。
 *
 * - メールを読むのは sources/ の部品（メール会社ごとに差し替える）。ここは、記録する・集計する・時間で区切る・二重に動かさない、を受け持つ
 * - 読んだメールは 1 通ずつ記録する（ヘッダから取った材料だけ。本文は受け取らない）。同じメールは二度記録しない
 * - サービスごとの集計は、いつも記録から作り直す。だから、読み直しや重なりがあっても数はずれない
 * - 進めるのはサーバー。画面を閉じても続く。時間で区切れたら次の回へ引き継ぎ、止まっても定期実行（/api/cron/migrate-scan）が続きから進める
 */

/** 読み方の部品。メールボックスの source 欄の名前で選ぶ */
const SOURCES: Record<string, MailSource> = { "gmail-api": gmailApi, imap };

/** 「今どこかが進めている」印の長さ。関数の時間の上限（5 分）より長くして、二重に動かさない */
const LOCK = "6 minutes";
/** 定期実行の 1 回で、同時に進めるメールボックスの数 */
const PARALLEL = 4;
/** 件名の見本として残す数 */
const SUBJECT_KEEP = 5;
/** 1 つのメールボックスで記録する通数の上限（1 人が、際限なく記録を増やせないように） */
export const MAX_MESSAGES = 50_000;
/**
 * ログイン・本人確認にかかわるメールは、件名そのものを保存しない（認証コードや、ログインに使えるリンクが入ることがあるため）。
 * 代わりに、種類を表す決まった言葉を保存する
 */
const LOGIN_SUBJECT: Partial<Record<Kind, string>> = { auth: "（認証コードのメール）", security: "（ログイン・セキュリティの通知）", password: "（パスワード再設定のメール）" };

interface MessageRow {
  id: string;
  at: string;
  domain: string;
  from_address: string;
  from_name: string;
  to_address: string;
  subject: string;
  labels: string[];
  has_unsubscribe: boolean;
  precedence: string;
  kind: string;
}

/** 読んだヘッダを、記録する形にする（自分自身からのメールと、個人どうしのやり取りは記録しない） */
export function toRows(headers: Header[], ownEmail: string): MessageRow[] {
  const out: MessageRow[] = [];
  for (const h of headers) {
    const from = parseFrom(h.from);
    // 届いた日が分からないメールは記録しない（判定の材料は「いつ届いたか」なので、1970 年として扱うと誤る）
    if (!h.id || !h.at || !from || from.address === ownEmail || isPersonalDomain(from.address)) continue;
    const domain = serviceDomain(from.address);
    if (!domain) continue;
    // 分類は、伏せる前の件名で決める
    const kind = classify({ subject: h.subject, labels: h.labels, listUnsubscribe: h.listUnsubscribe, precedence: h.precedence });
    out.push({
      id: clean(h.id, 200),
      at: new Date(h.at).toISOString(),
      domain,
      from_address: clean(from.address, 200),
      // 名乗りの中にアドレスらしいものが書かれていたら、名乗りごと捨てる（本物の差出人に見せかける手口）
      from_name: from.name.includes("@") ? "" : from.name,
      to_address: clean(parseFrom(h.to ?? "")?.address ?? "", 200),
      kind,
      subject: (LOGIN_KINDS.includes(kind) ? LOGIN_SUBJECT[kind] : undefined) ?? clean(maskSecrets(h.subject), 120),
      labels: (h.labels ?? []).filter((l) => /^CATEGORY_[A-Z]+$/.test(l)).slice(0, 8),
      has_unsubscribe: !!h.listUnsubscribe,
      precedence: clean(h.precedence ?? "", 20),
    });
  }
  return out;
}

/**
 * メールを記録して、かかわるサービスの集計を作り直す。メールを取りこむ道は、ここ 1 つだけ。
 * 同じメール（同じメールボックスの、同じ番号）は二度記録しない
 */
async function ingest(client: PoolClient, box: Pick<MailboxRow, "id" | "user_id" | "email">, headers: Header[]): Promise<void> {
  const rows = toRows(headers, box.email);
  if (!rows.length) return;
  await insertRows(client, box, rows);
  await rebuild(client, box, [...new Set(rows.map((r) => r.domain))]);
}

/**
 * 記録を書きこむ。まとめて書けなかったら、1 通ずつ書いて、書けない 1 通だけを飛ばす
 * （外から届いた 1 通のせいで、そのメールボックスの調べが止まり続けないように）
 */
async function insertRows(client: PoolClient, box: Pick<MailboxRow, "id" | "user_id">, rows: MessageRow[]): Promise<void> {
  await client.query("savepoint ingest");
  try {
    await insertBatch(client, box, rows);
    await client.query("release savepoint ingest");
    return;
  } catch (err) {
    await client.query("rollback to savepoint ingest");
    console.error("[migrate] ingest batch failed; retrying row by row", (err as { code?: string })?.code ?? "");
  }
  for (const row of rows) {
    await client.query("savepoint ingest_row");
    try {
      await insertBatch(client, box, [row]);
      await client.query("release savepoint ingest_row");
    } catch (err) {
      await client.query("rollback to savepoint ingest_row");
      // 中身は記録に出さない（件名や差出人が入っているため）。種類だけ残す
      console.error("[migrate] ingest skipped one message", (err as { code?: string })?.code ?? "");
    }
  }
}

async function insertBatch(client: PoolClient, box: Pick<MailboxRow, "id" | "user_id">, rows: MessageRow[]): Promise<void> {
  await client.query(
    `insert into migrate_messages (user_id, mailbox_id, provider_msg_id, at, domain, from_address, from_name, to_address, subject, labels, has_unsubscribe, precedence, kind, rules_version)
     select $1, $2, x.id, x.at, x.domain, x.from_address, x.from_name, x.to_address, x.subject,
            array(select jsonb_array_elements_text(x.labels)), x.has_unsubscribe, x.precedence, x.kind, $4
     from jsonb_to_recordset($3::jsonb) as x(id text, at timestamptz, domain text, from_address text, from_name text, to_address text, subject text, labels jsonb, has_unsubscribe boolean, precedence text, kind text)
     on conflict (mailbox_id, provider_msg_id) do nothing`,
    [box.user_id, box.id, JSON.stringify(rows), RULES_VERSION],
  );
}

/** サービスごとの集計を、記録から作り直す（仕分けの状態・開くページ・メモは変えない） */
async function rebuild(client: PoolClient, box: Pick<MailboxRow, "id" | "user_id">, domains: string[]): Promise<void> {
  if (!domains.length) return;
  await client.query(
    `with m as (
       select domain, kind, at, from_name, subject from migrate_messages where mailbox_id = $1 and domain = any($3)
     ), by_kind as (
       select domain, kind, count(*) as c, max(at) as last from m group by domain, kind
     ), sig as (
       select domain, sum(c)::int as n, jsonb_object_agg(kind, c) as signals,
              jsonb_object_agg(kind, to_char(last at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')) as signal_last
       from by_kind group by domain
     ), span as (
       select domain, min(at) as first_at, max(at) as last_at from m group by domain
     ), names as (
       select distinct on (domain) domain, from_name
       from (select domain, from_name, count(*) as c from m where from_name <> '' group by domain, from_name) x
       order by domain, c desc, from_name
     ), latest as (
       -- 見本は、広告でないものを先に、新しい順で、同じ件名は 1 つにまとめる
       select distinct on (domain, subject) domain, subject, at, (kind = 'promo') as promo
       from m where subject <> '' order by domain, subject, at desc
     ), ranked as (
       select domain, subject, at, promo, row_number() over (partition by domain order by promo, at desc) as r from latest
     ), samples as (
       select domain, jsonb_agg(subject order by promo, at desc) as subjects from ranked where r <= ${SUBJECT_KEEP} group by domain
     )
     insert into migrate_services (mailbox_id, user_id, domain, name, count, signals, signal_last, subjects, first_at, last_at)
     select $1, $2, sig.domain, coalesce(names.from_name, ''), sig.n, sig.signals, sig.signal_last, coalesce(samples.subjects, '[]'::jsonb), span.first_at, span.last_at
     from sig join span using (domain) left join names using (domain) left join samples using (domain)
     on conflict (mailbox_id, domain) do update set
       name = excluded.name, count = excluded.count, signals = excluded.signals, signal_last = excluded.signal_last,
       subjects = excluded.subjects, first_at = excluded.first_at, last_at = excluded.last_at, updated_at = now()`,
    [box.id, box.user_id, domains],
  );
}

/** 記録と集計を空にする（仕分けの状態・開くページ・メモは残す） */
async function clearCounts(client: PoolClient, mailboxId: string): Promise<void> {
  await client.query("delete from migrate_messages where mailbox_id = $1", [mailboxId]);
  await client.query(
    "update migrate_services set count = 0, names = '{}', signals = '{}', signal_last = '{}', subjects = '[]', first_at = null, last_at = null where mailbox_id = $1",
    [mailboxId],
  );
  await client.query("update migrate_mailboxes set scan = '{}', scanned = 0, remaining = 0, last_scan = null where id = $1", [mailboxId]);
}

/** 調べ始める（印を付けるだけ。進めるのは runScan） */
export async function requestScan(userId: string, mailboxId: string): Promise<void> {
  const box = await getMailbox(userId, mailboxId);
  await (await db()).query("update migrate_mailboxes set requested = true, error = '' where id = $1 and user_id = $2", [box.id, userId]);
}

/** 止める（進めている所は、読んでいるひとかたまりを終えたところで止まる） */
export async function stopScan(userId: string, mailboxId: string): Promise<void> {
  const box = await getMailbox(userId, mailboxId);
  await (await db()).query("update migrate_mailboxes set requested = false where id = $1 and user_id = $2", [box.id, userId]);
}

/** 数え直すために空にする */
export async function resetScan(userId: string, mailboxId: string): Promise<void> {
  const box = await getMailbox(userId, mailboxId);
  await transaction(async (client) => {
    // 「調べていない」ことの確かめと、空にするのを、同じトランザクションの中で行う（確かめたあとに調べが始まらないように、行を押さえる）
    const free = await client.query(
      "select 1 from migrate_mailboxes where id = $1 and user_id = $2 and not requested and (lock_until is null or lock_until < now()) for update",
      [box.id, userId],
    );
    if (!free.rowCount) throw new UserError("調べている途中は数え直せません。「止める」を押して、少し待ってからにしてください");
    await clearCounts(client, box.id);
  });
}

/** 止まった理由を、画面に出せる言葉にする（内部のエラーの文は、利用者には見せない。記録にだけ残す） */
function reason(err: unknown): string {
  if (err instanceof UserError) return err.message;
  if ((err as { authenticationFailed?: boolean })?.authenticationFailed) return "メールに入れませんでした。もう一度つなぎ直してください";
  return "読み取りが途中で止まりました。「調べる」でもう一度、続きから進めます";
}

/**
 * 調べを進める（サーバーの中だけから呼ぶ。持ち主の確かめは、調べる印を付ける requestScan で済んでいる）。
 * deadline（ミリ秒の時刻）を過ぎたら、そこでやめる（続きの場所は、ひとかたまりごとに保存してある）。
 * 返す値：done＝終わった／止めた、more＝時間で区切れた（すぐ続きを進めてよい）、later＝相手が混み合っている（しばらく置く）、
 * busy＝ほかで進めている最中か、調べる印がない
 */
export async function runScan(mailboxId: string, deadline: number): Promise<"done" | "more" | "later" | "busy"> {
  const pool = await db();
  // この回の印。ロックを外すときは、自分の印のものだけ外す（時間切れのあと別の回が取ったロックを、外さない）
  const lockToken = randomBytes(12).toString("base64url");
  const claimed = await pool.query<MailboxRow>(
    `update migrate_mailboxes set lock_until = now() + interval '${LOCK}', lock_token = $2, progress_at = now()
     where id = $1 and requested and user_id is not null and (lock_until is null or lock_until < now()) returning *`,
    [mailboxId, lockToken],
  );
  const box = claimed.rows[0];
  if (!box) return "busy";
  let session: MailSession | null = null;
  try {
    const source = SOURCES[box.source];
    if (!source) throw new UserError("このメールボックスの読み方は、まだ用意されていません");
    session = await source.open(box, box.scan ?? {});
    for (;;) {
      if (Date.now() > deadline) return "more";
      const still = await pool.query<{ requested: boolean }>("select requested from migrate_mailboxes where id = $1 and lock_token = $2", [box.id, lockToken]);
      if (!still.rows[0]?.requested) return "done";
      const batch = await session.next();
      await transaction(async (client) => {
        if (batch.reset) await clearCounts(client, box.id);
        await ingest(client, box, batch.headers);
        await client.query(
          // 「これまで ○ 通」は、実際に記録した通数にする（読んだだけで記録しなかったもの・前に記録済みのものは数えない）
          `update migrate_mailboxes set scan = $2::jsonb, remaining = $3, error = '', progress_at = now(),
             scanned = (select count(*) from migrate_messages where mailbox_id = $1),
             requested = requested and not $4, last_scan = case when $4 then now() else last_scan end
           where id = $1`,
          [box.id, JSON.stringify(batch.cursor), batch.remaining ?? 0, batch.done],
        );
      });
      if (batch.done) return "done";
      const total = await pool.query<{ scanned: number }>("select scanned from migrate_mailboxes where id = $1", [box.id]);
      if ((total.rows[0]?.scanned ?? 0) >= MAX_MESSAGES) throw new UserError(`記録できる通数の上限（${MAX_MESSAGES.toLocaleString()} 通）に達したので、ここで止めました`, "too-many-messages");
    }
  } catch (err) {
    if (err instanceof RetryLater) {
      // 調べる印は残す。定期実行が、しばらくしてから続きを進める
      await pool.query("update migrate_mailboxes set error = $2 where id = $1", [box.id, "メールの読み取りが混み合っているので、少し休んでいます。15 分以内に自動で続きを進めます"]).catch(() => {});
      return "later";
    }
    // 調べている途中で、利用者がつながりを切った（行が消えた）。失敗ではない
    if ((err as { code?: string })?.code === "23503") return "done";
    if (!(err instanceof UserError)) console.error("[migrate] scan", box.id, err);
    await pool.query("update migrate_mailboxes set requested = false, error = $2 where id = $1", [box.id, reason(err)]).catch(() => {});
    return "done";
  } finally {
    await session?.close().catch(() => {});
    await pool.query("update migrate_mailboxes set lock_until = null, lock_token = null where id = $1 and lock_token = $2", [box.id, lockToken]).catch(() => {});
  }
}

/**
 * 定期実行から呼ぶ：途中のままのメールボックスを、時間のかぎり進める。時間で区切れたものがあれば more。
 * 長く待っているもの（最後に進んだのが古いもの）から、いくつかを同時に進める。
 * 1 人の大きなメールボックスが、ほかの人の順番をふさがないようにするため
 */
export async function runPending(deadline: number): Promise<{ pending: number; more: boolean }> {
  const pool = await db();
  const rows = (
    await pool.query<{ id: string }>(
      `select id from migrate_mailboxes where requested and user_id is not null and (lock_until is null or lock_until < now())
       order by progress_at asc nulls first, created_at limit ${PARALLEL * 5}`,
    )
  ).rows;
  let more = rows.length >= PARALLEL * 5;
  const queue = [...rows];
  const worker = async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      if (Date.now() > deadline) {
        more = true;
        return;
      }
      if ((await runScan(r.id, deadline)) === "more") more = true;
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  return { pending: rows.length, more };
}

/**
 * このサーバー自身の、外から見た住所。続きを起こす呼び出し（kick）には合言葉を付けるので、宛先は必ずここで決める。
 * リクエストに書かれた宛先（Host）は使わない（書き換えられた宛先へ、合言葉を送らないため）。
 * 本番では、環境変数 MIGRATE_ORIGIN か、Vercel が入れる本番のドメインを使う。手元で動かすときだけ、リクエストの宛先を使う
 */
export function selfOrigin(request: Request): string | null {
  const fixed = process.env.MIGRATE_ORIGIN?.trim();
  if (fixed && /^https:\/\/[a-z0-9.-]+$/i.test(fixed)) return fixed;
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercel && /^[a-z0-9.-]+$/i.test(vercel)) return `https://${vercel}`;
  if (process.env.NODE_ENV !== "production") return new URL(request.url).origin;
  return null;
}

/**
 * 続きを進める回を、もう 1 つ起こす（時間で区切れたとき）。
 * 自分の定期実行の入口を呼ぶ。入口はすぐ返事を返して裏で進めるので、ここでは返事を受け取るまで待つ。
 * 届かなくても、15 分ごとの定期実行が拾う
 */
export async function kick(origin: string | null): Promise<void> {
  const secret = process.env.CRON_SECRET;
  if (!secret || !origin) return;
  await fetch(`${origin}/api/cron/migrate-scan`, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(15000) }).catch((err) =>
    console.error("[migrate] kick", err instanceof Error ? err.message : err),
  );
}
