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
export class UserError extends Error {
  /** 理由の記号（文を読まずに、種類を見分けたいとき用） */
  constructor(message: string, readonly code: string = "") {
    super(message);
  }
}

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
  // 3：卒業までの道すじ（やめたいアドレスの印、仕分けを変えた時刻）
  `
      alter table migrate_mailboxes add column if not exists retiring boolean not null default false;  -- このアドレスをやめたい（毎日、自動で見張る）
      alter table migrate_services add column if not exists status_at timestamptz;                     -- 仕分けを変えた時刻（「変更できた」のあとに届いたメールを見分ける）
  `,
  // 4：ふるいの最後の層（LLM）。だれが分類を決めたかの印と、LLM の答えを覚えておく表
  `
      alter table migrate_messages add column if not exists kind_source text not null default 'rule';  -- rule＝決まりで決めた／llm＝LLM が決めた
      create index if not exists migrate_messages_box_kind on migrate_messages (mailbox_id, kind, kind_source);
      create table if not exists migrate_llm_cache (
        key text primary key,                   -- ドメインと件名の形から作ったハッシュ（件名そのものは入れない）
        kind text not null,
        model text not null,
        created_at timestamptz not null default now()
      );
  `,
  // 5：AI 秘書（MCP）とつなぐための鍵。利用者ごとに何本でも作れ、鍵ごとに見せるメールボックスを絞れる
  `
      create table if not exists migrate_grants (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null references migrate_users(id) on delete cascade,
        name text not null,                     -- 利用者が付けた名前（「Claude Desktop」など）
        token_hash text not null unique,        -- 鍵のハッシュ。鍵そのものは保存しない（作ったときに 1 回だけ見せる）
        token_hint text not null,               -- 見分け用に、鍵の先頭の数文字
        mailbox_ids uuid[],                     -- 見せるメールボックス（null ならすべて）
        created_at timestamptz not null default now(),
        last_used_at timestamptz,
        revoked_at timestamptz
      );
      create index if not exists migrate_grants_user on migrate_grants (user_id);
      -- 鍵ごとの呼び出しの記録（回数の上限と、どの AI がいつ何を見たかの記録）
      create table if not exists migrate_grant_calls (
        id bigint generated always as identity primary key,
        grant_id uuid not null references migrate_grants(id) on delete cascade,
        tool text not null,
        at timestamptz not null default now()
      );
      create index if not exists migrate_grant_calls_grant_at on migrate_grant_calls (grant_id, at desc);
  `,
  // 6：OAuth（AI 秘書の側で「ログインして許可する」つなぎ方）。つながり 1 本が migrate_grants の 1 行になる
  `
      alter table migrate_grants alter column token_hash drop not null;                        -- OAuth のつながりには、固定の鍵がない
      alter table migrate_grants add column if not exists kind text not null default 'key';    -- key＝画面で作った鍵／oauth＝OAuth でつないだ
      alter table migrate_grants add column if not exists client_id text;                      -- つないだ AI 秘書（OAuth のクライアント）
      alter table migrate_grants add column if not exists resource text;                       -- 合言葉の宛先（この MCP サーバーの URL）
      -- つなぎに来る AI 秘書の登録（dcr＝相手が自分で登録した／cimd＝相手の公開している文書を読んだ控え）
      create table if not exists migrate_oauth_clients (
        client_id text primary key,
        kind text not null,
        name text not null default '',
        redirect_uris text[] not null,
        created_at timestamptz not null default now(),
        fetched_at timestamptz not null default now(),
        last_used_at timestamptz
      );
      -- 許可の画面を出すまでの間だけ覚えておく、つなぎたいという申し込み（番号はハッシュで置く）
      create table if not exists migrate_oauth_requests (
        id_hash text primary key,
        client_id text not null,
        redirect_uri text not null,
        state text,
        code_challenge text not null,
        resource text not null,
        expires_at timestamptz not null
      );
      -- 許可のあと、合言葉と引き換える 1 回かぎりの引換券（ハッシュで置く）
      create table if not exists migrate_oauth_codes (
        code_hash text primary key,
        user_id uuid not null references migrate_users(id) on delete cascade,
        client_id text not null,
        client_name text not null default '',
        redirect_uri text not null,
        code_challenge text not null,
        resource text not null,
        mailbox_ids uuid[],
        expires_at timestamptz not null,
        used_at timestamptz,
        grant_id uuid references migrate_grants(id) on delete set null
      );
      -- 合言葉（access＝呼び出しに使う・短い期限／refresh＝新しい合言葉をもらうためのもの・使うたびに取り替える）。ハッシュだけ置く
      create table if not exists migrate_oauth_tokens (
        token_hash text primary key,
        grant_id uuid not null references migrate_grants(id) on delete cascade,
        kind text not null,
        expires_at timestamptz not null,
        used_at timestamptz,                    -- refresh を取り替えた時刻（取り替えたあとにもう一度使われたら、盗まれた印）
        created_at timestamptz not null default now()
      );
      create index if not exists migrate_oauth_tokens_grant on migrate_oauth_tokens (grant_id);
      -- ログインなしで呼べる入口の、回数の記録（登録や申し込みを大量に送られないように）
      create table if not exists migrate_rate (
        id bigint generated always as identity primary key,
        bucket text not null,
        at timestamptz not null default now()
      );
      create index if not exists migrate_rate_bucket_at on migrate_rate (bucket, at desc);
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
  retiring: boolean;
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
  status_at: Date | null;
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
  return { id: row.id, email: row.email, scanned: row.scanned, scanning: row.requested, remaining: row.remaining, last_scan: iso(row.last_scan), error: row.error, kinds, retiring: row.retiring, graduation: null };
}

export function toService(row: ServiceRow, stillArriving: Service["stillArriving"] = null): Service {
  return {
    status_at: iso(row.status_at),
    stillArriving,
    id: row.id,
    mailbox_id: row.mailbox_id,
    domain: row.domain,
    name: row.name,
    count: row.count,
    signals: row.signals ?? {},
    signal_last: row.signal_last ?? {},
    subjects: (row.subjects ?? []).map((x) => (typeof x === "string" ? x : x.s)),
    judgment: judge({ signals: row.signals ?? {}, signalLast: row.signal_last ?? {}, count: row.count, firstAt: iso(row.first_at), lastAt: iso(row.last_at) }),
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
