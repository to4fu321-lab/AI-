import "server-only";
import { Pool, type PoolClient } from "pg";
import type { Kind } from "./classify";
import { judge } from "./judge";
import type { Mailbox, Service, Status } from "./types";

/**
 * アカウント引っ越しのデータベース（Postgres。Vercel につないだ Neon を想定）。
 * 接続先は環境変数 MIGRATE_DATABASE_URL（なければ DATABASE_URL・POSTGRES_URL）。
 * 表は、初めて使うときに自分で作る（手で SQL を実行しなくてよい）。
 * メールの本文は保存しない。保存するのは、ヘッダから取った材料（差出人・件名・日付・分類）と、その集計だけ。
 */

/** 画面にそのまま見せてよいエラー（設定もれ・入力まちがいなど） */
export class UserError extends Error {}

let pool: Pool | null | undefined;
let ready: Promise<void> | null = null;

function connectionString(): string | null {
  const v = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL;
  return v && /^postgres(?:ql)?:\/\//.test(v) ? v : null;
}

/**
 * 表の作り方・変え方を、番号つきの手順として並べる。
 * - 一度動かした手順は書き換えない。変えたいときは、次の番号の手順を足す
 * - まだ動かしていない手順だけを、順番に 1 回ずつ動かす（どこまで動かしたかは migrate_schema に記録する）
 * - 手順は 1 つのトランザクションの中で、ロックを取ってから動かす（同時に起動しても、二重には動かない）
 */
const MIGRATIONS: string[] = [
  // 1：最初の表一式（利用者ごとの分離まで）
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

      -- 利用者ごとの分離。どの表にも持ち主（user_id）を持たせ、読み書きは必ず持ち主で絞る
      create table if not exists migrate_users (
        id uuid primary key default gen_random_uuid(),
        google_sub text not null unique,        -- Google が利用者ごとに決める、変わらない番号
        email text not null,
        name text not null default '',
        created_at timestamptz not null default now(),
        last_login timestamptz
      );
      create table if not exists migrate_sessions (
        token_hash text primary key,            -- ログインの印（Cookie の値）のハッシュ。値そのものは保存しない
        user_id uuid not null references migrate_users(id) on delete cascade,
        expires_at timestamptz not null,
        created_at timestamptz not null default now()
      );
      alter table migrate_mailboxes add column if not exists user_id uuid references migrate_users(id) on delete cascade;
      alter table migrate_services add column if not exists user_id uuid references migrate_users(id) on delete cascade;
      -- 同じアドレスを、別の利用者がそれぞれつなぐことはあり得る。重なりを禁じるのは「同じ利用者の中」だけ
      alter table migrate_mailboxes drop constraint if exists migrate_mailboxes_email_key;
      create unique index if not exists migrate_mailboxes_user_email on migrate_mailboxes (user_id, email);
      create index if not exists migrate_services_user on migrate_services (user_id);
      create index if not exists migrate_sessions_user on migrate_sessions (user_id);
  `,
  // 2：メール 1 通ごとの記録（ヘッダだけ）。サービスごとの集計は、ここから作り直せる
  `
      create table if not exists migrate_messages (
        id bigint generated always as identity primary key,
        user_id uuid not null references migrate_users(id) on delete cascade,
        mailbox_id uuid not null references migrate_mailboxes(id) on delete cascade,
        provider_msg_id text not null,          -- メール会社がそのメールに付けた番号（同じメールを二重に記録しないため）
        at timestamptz not null,                -- 届いた時刻
        domain text not null,                   -- サービスの単位にしているドメイン
        from_address text not null,             -- 差出人のアドレス（サービスの分け方を変えるときの材料）
        from_name text not null default '',
        to_address text not null default '',    -- 宛先（転送されてきた古いアドレスを見分ける材料）
        subject text not null default '',       -- 件名。数字の並びは伏せてから保存する（認証コードや注文番号を残さない）
        labels text[] not null default '{}',
        has_unsubscribe boolean not null default false,
        precedence text not null default '',
        kind text not null,                     -- 分類（classify.ts の Kind）
        rules_version integer not null,         -- どの版の決まりで分類したか
        unique (mailbox_id, provider_msg_id)
      );
      create index if not exists migrate_messages_box_domain on migrate_messages (mailbox_id, domain);
      create index if not exists migrate_messages_user_kind_at on migrate_messages (user_id, kind, at desc);
      alter table migrate_services add column if not exists signal_last jsonb not null default '{}';  -- 種類ごとの、最後に届いた日
      alter table migrate_mailboxes add column if not exists lock_token text;                         -- 進めている回の印（ほかの回のロックを外さない）
      alter table migrate_mailboxes add column if not exists progress_at timestamptz;                 -- 最後に進んだ時刻（待っている順に進めるため）
      -- 集計の作り方が変わるので、これまでの数は空にして、次の調べで作り直す（仕分け・開くページ・メモは残す）
      update migrate_services set count = 0, names = '{}', signals = '{}', subjects = '[]', first_at = null, last_at = null;
      update migrate_mailboxes set scan = '{}', scanned = 0, remaining = 0, last_scan = null, requested = false;
  `,
];

async function migrate(pool: Pool): Promise<void> {
  // ほとんどの起動では、もう全部済んでいる。1 回の問い合わせで確かめて終える
  const current = await pool.query<{ v: number | null }>("select max(version) as v from migrate_schema").then(
    (r) => r.rows[0]?.v ?? 0,
    () => 0, // 記録の表がまだない
  );
  if (current >= MIGRATIONS.length) return;
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(742001)");
    await client.query("create table if not exists migrate_schema (version integer primary key, applied_at timestamptz not null default now())");
    const done = (await client.query<{ v: number | null }>("select max(version) as v from migrate_schema")).rows[0]?.v ?? 0;
    for (let i = done; i < MIGRATIONS.length; i++) {
      await client.query(MIGRATIONS[i]);
      await client.query("insert into migrate_schema (version) values ($1)", [i + 1]);
    }
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** 表を用意した接続を返す（設定がなければ、画面に出せる理由つきで投げる） */
export async function db(): Promise<Pool> {
  if (pool === undefined) {
    const url = connectionString();
    pool = url ? new Pool({ connectionString: url, max: 6, idleTimeoutMillis: 10000, ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: true } }) : null;
  }
  if (!pool) throw new UserError("データベースが設定されていません（DATABASE_URL）");
  ready ??= migrate(pool).catch((err) => {
    ready = null;
    throw err;
  });
  await ready;
  return pool;
}

export interface MailboxRow {
  id: string;
  /** 持ち主。利用者の分離を入れる前に作られた行だけ null（最初の利用者が引き継ぐ） */
  user_id: string | null;
  email: string;
  token_enc: string;
  source: string;
  /** 続きの場所（中身は読み方ごとに違う） */
  scan: Record<string, unknown>;
  scanned: number;
  last_scan: Date | null;
  requested: boolean;
  lock_until: Date | null;
  lock_token: string | null;
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
  signals: Partial<Record<Kind, number>>;
  signal_last: Partial<Record<Kind, string>>;
  /** 件名の見本（昔の行は { s, t } の形で入っている） */
  subjects: (string | { s: string })[];
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
export function toMailbox(row: MailboxRow, kinds: Partial<Record<Kind, number>> = {}): Mailbox {
  return { id: row.id, email: row.email, scanned: row.scanned, scanning: row.requested, remaining: row.remaining, last_scan: iso(row.last_scan), error: row.error, kinds };
}

export function toService(row: ServiceRow): Service {
  return {
    id: row.id,
    mailbox_id: row.mailbox_id,
    domain: row.domain,
    name: row.name,
    count: row.count,
    signals: row.signals ?? {},
    signal_last: row.signal_last ?? {},
    subjects: (row.subjects ?? []).map((x) => (typeof x === "string" ? x : x.s)),
    judgment: judge({ signals: row.signals ?? {}, signalLast: row.signal_last ?? {} }),
    first_at: iso(row.first_at),
    last_at: iso(row.last_at),
    status: row.status,
    login_url: row.login_url,
    note: row.note,
  };
}

/** 持ち主のメールボックスを 1 件読む。他人のものは「見つかりません」になる（あるかどうかも教えない） */
export async function getMailbox(userId: string, id: string): Promise<MailboxRow> {
  const r = await (await db()).query<MailboxRow>("select * from migrate_mailboxes where id = $1 and user_id = $2", [uuid(id), userId]);
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
