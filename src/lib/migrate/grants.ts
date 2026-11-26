import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { db, UserError, uuid } from "./db";

/**
 * AI 秘書（MCP）とつなぐための鍵。
 *
 * - 鍵は利用者が画面で作る。作ったときに 1 回だけ見せ、データベースにはハッシュだけを置く（見られても、なりすませない）
 * - 鍵ごとに「見せるメールボックス」を絞れる（null ならすべて。あとからつないだものも含む）
 * - 鍵ごとに呼び出しを記録する（回数の上限と、どの AI がいつ何を見たかの記録のため）
 * - 鍵はいつでも取り消せる。取り消した鍵は、すぐに使えなくなる
 */

/** 1 人が作れる鍵の数 */
export const MAX_GRANTS = 10;
/** 1 本の鍵で、1 分に呼べる回数と、1 日に呼べる回数 */
const PER_MINUTE = 60;
const PER_DAY = 3000;
/** 呼び出しの記録を残す日数 */
const KEEP_DAYS = 30;

const PREFIX = "mgk_";
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/** MCP の呼び出しが「誰の・どの鍵で・どのメールボックスまで」見てよいか */
export interface Principal {
  userId: string;
  grantId: string;
  /** 見てよいメールボックス（null ならすべて） */
  mailboxIds: string[] | null;
}

export interface Grant {
  id: string;
  name: string;
  /** 見分け用の先頭の数文字（鍵そのものではない） */
  hint: string;
  /** 見せるメールボックスのアドレス（null ならすべて） */
  mailboxes: string[] | null;
  created_at: string;
  last_used_at: string | null;
  /** 直近 24 時間の呼び出し回数 */
  calls24h: number;
}

/** 鍵を作る。返す token は、このときしか見られない */
export async function createGrant(userId: string, nameInput: unknown, mailboxInput: unknown): Promise<{ token: string; grant: Grant }> {
  const name = (typeof nameInput === "string" ? nameInput : "").trim().slice(0, 40) || "AI 秘書";
  let mailboxIds: string[] | null = null;
  if (Array.isArray(mailboxInput)) {
    const ids = [...new Set(mailboxInput.map((x) => uuid(x)))];
    if (!ids.length) throw new UserError("見せるメールボックスを、1 つ以上選んでください");
    // 自分のメールボックスだけを受け付ける
    const mine = await (await db()).query<{ id: string }>("select id from migrate_mailboxes where user_id = $1 and id = any($2)", [userId, ids]);
    if (mine.rows.length !== ids.length) throw new UserError("メールボックスが見つかりません");
    mailboxIds = ids;
  }
  const pool = await db();
  const count = await pool.query<{ n: number }>("select count(*)::int as n from migrate_grants where user_id = $1 and revoked_at is null", [userId]);
  if ((count.rows[0]?.n ?? 0) >= MAX_GRANTS) throw new UserError(`作れる鍵は ${MAX_GRANTS} 本までです。使っていない鍵を取り消してください`);
  const token = PREFIX + randomBytes(32).toString("base64url");
  const hint = token.slice(0, PREFIX.length + 6);
  const r = await pool.query<{ id: string; created_at: Date }>(
    "insert into migrate_grants (user_id, name, token_hash, token_hint, mailbox_ids) values ($1, $2, $3, $4, $5) returning id, created_at",
    [userId, name, hash(token), hint, mailboxIds],
  );
  const emails = mailboxIds ? (await pool.query<{ email: string }>("select email from migrate_mailboxes where id = any($1) order by email", [mailboxIds])).rows.map((x) => x.email) : null;
  return { token, grant: { id: r.rows[0].id, name, hint, mailboxes: emails, created_at: r.rows[0].created_at.toISOString(), last_used_at: null, calls24h: 0 } };
}

/** その人の、使える鍵の一覧（鍵そのものは返さない） */
export async function listGrants(userId: string): Promise<Grant[]> {
  const r = await (await db()).query<{ id: string; name: string; token_hint: string; created_at: Date; last_used_at: Date | null; emails: string[] | null; calls: number; scoped: boolean }>(
    `select g.id, g.name, g.token_hint, g.created_at, g.last_used_at, g.mailbox_ids is not null as scoped,
            (select array_agg(m.email order by m.email) from migrate_mailboxes m where m.id = any(g.mailbox_ids) and m.user_id = g.user_id) as emails,
            (select count(*)::int from migrate_grant_calls c where c.grant_id = g.id and c.at > now() - interval '24 hours') as calls
     from migrate_grants g where g.user_id = $1 and g.revoked_at is null order by g.created_at`,
    [userId],
  );
  return r.rows.map((g) => ({
    id: g.id,
    name: g.name,
    hint: g.token_hint,
    mailboxes: g.scoped ? (g.emails ?? []) : null,
    created_at: g.created_at.toISOString(),
    last_used_at: g.last_used_at?.toISOString() ?? null,
    calls24h: g.calls,
  }));
}

/** 鍵を取り消す（すぐに使えなくなる） */
export async function revokeGrant(userId: string, grantId: unknown): Promise<void> {
  const r = await (await db()).query("update migrate_grants set revoked_at = now() where id = $1 and user_id = $2 and revoked_at is null", [uuid(grantId), userId]);
  if (!r.rowCount) throw new UserError("鍵が見つかりません");
}

/** 「Authorization: Bearer ...」の鍵から、誰の呼び出しかを確かめる（使えない鍵なら null） */
export async function authenticate(request: Request): Promise<Principal | null> {
  const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  const token = m?.[1] ?? "";
  if (!token.startsWith(PREFIX) || token.length > 100) return null;
  const r = await (await db()).query<{ id: string; user_id: string; mailbox_ids: string[] | null }>(
    "select id, user_id, mailbox_ids from migrate_grants where token_hash = $1 and revoked_at is null",
    [hash(token)],
  );
  const g = r.rows[0];
  return g ? { userId: g.user_id, grantId: g.id, mailboxIds: g.mailbox_ids } : null;
}

/** 道具の呼び出しを 1 回記録する。回数の上限を超えていたら、理由つきで断る */
export async function recordCall(principal: Principal, tool: string): Promise<void> {
  const pool = await db();
  const r = await pool.query<{ minute: number; day: number }>(
    `select count(*) filter (where at > now() - interval '1 minute')::int as minute, count(*)::int as day
     from migrate_grant_calls where grant_id = $1 and at > now() - interval '1 day'`,
    [principal.grantId],
  );
  const { minute = 0, day = 0 } = r.rows[0] ?? {};
  if (minute >= PER_MINUTE) throw new UserError(`呼び出しが多すぎます（1 分に ${PER_MINUTE} 回まで）。少し待ってから呼んでください`);
  if (day >= PER_DAY) throw new UserError(`今日の呼び出しの上限（${PER_DAY} 回）に達しました`);
  await pool.query("insert into migrate_grant_calls (grant_id, tool) values ($1, $2)", [principal.grantId, tool.slice(0, 60)]);
  await pool.query("update migrate_grants set last_used_at = now() where id = $1", [principal.grantId]);
  // 古い記録を、ときどき片づける
  if (Math.random() < 0.02) await pool.query(`delete from migrate_grant_calls where at < now() - interval '${KEEP_DAYS} days'`).catch(() => {});
}
