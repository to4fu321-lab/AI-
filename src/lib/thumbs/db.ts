import "server-only";
import { Pool } from "pg";

/**
 * サムネ収集の「サーバー側の自動巡回」が使うデータベース（Postgres。Neon を想定）。
 * 接続先は環境変数 THUMBS_DATABASE_URL（なければ DATABASE_URL・POSTGRES_URL）。なければ、自動巡回はサーバーでは動かない。
 * 表は、初めて使うときに自分で作る。
 */

let pool: Pool | null | undefined;
let ready: Promise<void> | null = null;

function connectionString(): string | null {
  const v = process.env.THUMBS_DATABASE_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL;
  return v && /^postgres(?:ql)?:\/\//.test(v) ? v : null;
}

/** データベースが設定されているか */
export function dbConfigured(): boolean {
  return !!connectionString();
}

/** 表を用意した接続を返す（設定がなければ null） */
export async function db(): Promise<Pool | null> {
  if (pool === undefined) {
    const url = connectionString();
    pool = url ? new Pool({ connectionString: url, max: 3, idleTimeoutMillis: 10000, ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: true } }) : null;
  }
  if (!pool) return null;
  ready ??= pool
    .query(
      `
      create table if not exists thumbs_patrol_sites (
        url text primary key,
        settings jsonb not null,
        interval_min integer not null default 0,
        last_run timestamptz,
        last_found integer not null default 0,
        last_note text,
        created_at timestamptz not null default now()
      );
      create table if not exists thumbs_patrol_items (
        id text primary key,
        site_url text not null,
        kind text not null,
        data jsonb not null,
        found_at timestamptz not null default now()
      );
      create index if not exists thumbs_patrol_items_found_at on thumbs_patrol_items (found_at);
      create table if not exists thumbs_patrol_gofile (
        code text primary key,
        at timestamptz not null default now()
      );
      create table if not exists thumbs_patrol_meta (
        key text primary key,
        value jsonb not null
      );
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
