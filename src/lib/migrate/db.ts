import "server-only";
import { getSupabaseAdminClient } from "@/lib/supabaseAdmin";
import type { Mailbox, Service, Signal, Status } from "./types";

/** 画面にそのまま見せてよいエラー（設定もれ・入力まちがいなど） */
export class UserError extends Error {}

export function db() {
  const client = getSupabaseAdminClient();
  if (!client) throw new UserError("Supabase が設定されていません（NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY）");
  return client;
}

/** Supabase の返事から中身を取り出す。失敗していたら投げる */
export function must<T>(result: { data: T | null; error: { message: string; code?: string } | null }): T {
  if (result.error) {
    if (result.error.code === "42P01" || /migrate_\w+.*(does not exist|schema cache)/.test(result.error.message)) {
      throw new UserError("データベースの表がまだありません。supabase/migrate.sql を Supabase で実行してください");
    }
    throw new Error(result.error.message);
  }
  return result.data as T;
}

/** 調べている途中の続き */
export interface ScanState {
  /** 次に読むページ（あれば途中） */
  pageToken?: string;
  /** 今回の調べを始めた時刻（秒） */
  startedAt?: number;
  /** この時刻より後のメールだけ読む（前回読み終えた所。秒） */
  after?: number;
}

export interface MailboxRow {
  id: string;
  email: string;
  token_enc: string;
  scan: ScanState;
  scanned: number;
  last_scan: string | null;
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
  first_at: string | null;
  last_at: string | null;
  status: Status;
  login_url: string;
  note: string;
}

/** ブラウザに返す形（合言葉は入れない） */
export function toMailbox(row: MailboxRow): Mailbox {
  return { id: row.id, email: row.email, scanned: row.scanned, scanning: !!row.scan?.startedAt, last_scan: row.last_scan };
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
    first_at: row.first_at,
    last_at: row.last_at,
    status: row.status,
    login_url: row.login_url,
    note: row.note,
  };
}

export async function getMailbox(id: string): Promise<MailboxRow> {
  const row = must(await db().from("migrate_mailboxes").select("*").eq("id", id).maybeSingle()) as MailboxRow | null;
  if (!row) throw new UserError("メールボックスが見つかりません");
  return row;
}

/** サービスを全部読む（Supabase は 1 回に 1000 件までなので、分けて読む） */
export async function allServices(): Promise<ServiceRow[]> {
  const out: ServiceRow[] = [];
  for (let from = 0; ; from += 1000) {
    const rows = must(await db().from("migrate_services").select("*").order("count", { ascending: false }).order("id").range(from, from + 999)) as ServiceRow[];
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}
