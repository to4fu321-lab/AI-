import "server-only";
import { Pool, type PoolClient } from "pg";
import type { Mailbox, Service, Signal, Status } from "./types";

/**
 * アカウント引っ越しのデータベース（Postgres。Vercel につないだ Neon を想定）。
 * 接続先は環境変数 MIGRATE_DATABASE_URL（なければ DATABASE_URL・POSTGRES_URL）。
 * 表は、初めて使うときに自分で作る（手で SQL を実行しなくてよい）。
 * メールの本文は保存しない。保存するのは、差出人のドメインごとの件数・日付・件名の見本だけ。
 */

/** 画面にそのまま見せてよいエラー（設定もれ・入力まちがいなど） */
export class UserError extends Error {}

let pool: Pool | null | undefined;
let ready: Promise<void> | null = null;

function connectionString(): string | null {
  const v = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL;
  return v && /^postgres(?:ql)?:\/\//.test(v) ? v : null;
}

/** 表を用意した接続を返す（設定がなければ、画面に出せる理由つきで投げる） */
export async function db(): Promise<Pool> {
  if (pool === undefined) {
    const url = connectionString();
    pool = url ? new Pool({ connectionString: url, max: 3, idleTimeoutMillis: 10000, ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: true } }) : null;
  }
  if (!pool) throw new UserError("データベースが設定されていません（DATABASE_URL）");
  ready ??= pool
    .query(
      `
      create table if not exists migrate_mailboxes (
        id uuid primary key default gen_random_uuid(),
        email text not null unique,
        token_enc text not null default '',     -- Gmail を読む合言葉（AES-256-GCM で暗号化）
        scan jsonb not null default '{}',       -- 続きの場所（中身は読み方ごとに違う）
        scanned integer not null default 0,     -- これまでに読んだメールの数
        last_scan timestamptz,
        created_at timestamptz not null default now()
      );
      create table if not exists migrate_services (
        id uuid primary key default gen_random_uuid(),
        mailbox_id uuid not null references migrate_mailboxes(id) on delete cascade,
        domain text not null,                   -- 差出人のドメイン（例：example.co.jp）
        name text not null default '',          -- 差出人の表示名でいちばん多いもの
        names jsonb not null default '{}',      -- 表示名ごとの件数
        count integer not null default 0,
        signals jsonb not null default '{}',    -- 種類ごとの件数（signup / password / security / billing）
        subjects jsonb not null default '[]',   -- 件名の見本（新しいものから数件）
        first_at timestamptz,
        last_at timestamptz,
        status text not null default 'new',     -- new / move / skip / done
        login_url text not null default '',     -- 開くページ（空ならドメインの先頭）
        note text not null default '',
        updated_at timestamptz not null default now(),
        unique (mailbox_id, domain)
      );
      -- 調べを裏で進めるための情報（サーバーが進めるので、画面を閉じても続く）
      alter table migrate_mailboxes add column if not exists source text not null default 'gmail-api';  -- 読み方（sources/ の部品の名前）
      alter table migrate_mailboxes add column if not exists requested boolean not null default false;  -- 調べる途中か
      alter table migrate_mailboxes add column if not exists lock_until timestamptz;                    -- 今どこかが進めている（二重に動かさない）
      alter table migrate_mailboxes add column if not exists remaining integer not null default 0;     -- 今回の残り（分からない読み方では 0）
      alter table migrate_mailboxes add column if not exists error text not null default '';
    `,
    )
    .then(() => undefined)
    .catch((err) => {
      ready = null;
      throw err;
    });
  await ready;
  return pool;
}

export interface MailboxRow {
  id: string;
  email: string;
  token_enc: string;
  source: string;
  /** 続きの場所（中身は読み方ごとに違う） */
  scan: Record<string, unknown>;
  scanned: number;
  last_scan: Date | null;
  requested: boolean;
  lock_until: Date | null;
  remaining: number;
  error: string;
}

export interface ServiceRow {
  id: string;
  mailbox_id: string;
  domain: string;
  name: string;
  names: Record<string, number>;
  count: number;
  signals: Partial<Record<Signal, number>>;
  subjects: { s: string; t: number }[];
  first_at: Date | null;
  last_at: Date | null;
  status: Status;
  login_url: string;
  note: string;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 画面から届いた番号の形を確かめる（形が違うものをデータベースへ渡さない） */
export function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new UserError("番号の形が違います");
  return value;
}

/** ブラウザに返す形（合言葉は入れない） */
export function toMailbox(row: MailboxRow): Mailbox {
  return { id: row.id, email: row.email, scanned: row.scanned, scanning: row.requested, remaining: row.remaining, last_scan: iso(row.last_scan), error: row.error };
}

export function toService(row: ServiceRow): Service {
  return {
    id: row.id,
    mailbox_id: row.mailbox_id,
    domain: row.domain,
    name: row.name,
    count: row.count,
    signals: row.signals ?? {},
    subjects: (row.subjects ?? []).map((x) => x.s),
    first_at: iso(row.first_at),
    last_at: iso(row.last_at),
    status: row.status,
    login_url: row.login_url,
    note: row.note,
  };
}

export async function getMailbox(id: string): Promise<MailboxRow> {
  const r = await (await db()).query<MailboxRow>("select * from migrate_mailboxes where id = $1", [uuid(id)]);
  if (!r.rows[0]) throw new UserError("メールボックスが見つかりません");
  return r.rows[0];
}

/** いくつかの書き込みを「全部できたか、全部なかったか」にまとめる（数えた結果と続きの場所がずれないように） */
export async function transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await (await db()).connect();
  try {
    await client.query("begin");
    const result = await run(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
