import "server-only";
import { getSupabaseAdminClient } from "@/lib/supabaseAdmin";
import { decryptJson } from "./crypto";
import { defaultRules, type Member, type Post, type Site, type SiteKind, type SiteRules, type Video } from "./types";

/** 動画の置き場（Supabase Storage の非公開バケット） */
export const BUCKET = "autopost";

export const VIDEO_COLUMNS = "id,name,memo,path,thumb,duration,width,height,size,created_at";
export const MEMBER_COLUMNS = "id,login_id,name,active,created_at";

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
    if (result.error.code === "42P01" || /autopost_\w+.*(does not exist|schema cache)/.test(result.error.message)) {
      throw new UserError("データベースの表がまだありません。supabase/autopost.sql を Supabase で実行してください");
    }
    throw new Error(result.error.message);
  }
  return result.data as T;
}

export interface SiteRow {
  id: string;
  kind: SiteKind;
  name: string;
  enabled: boolean;
  auto: boolean;
  rules: Partial<SiteRules>;
  cred_enc: string;
}

export type Creds = Record<string, string>;

export function credsOf(row: Pick<SiteRow, "cred_enc">): Creds {
  return decryptJson<Creds>(row.cred_enc) ?? {};
}

/** ブラウザに返す形（ログイン情報の中身は入れない。どの項目が保存済みかだけ） */
export function toSite(row: SiteRow): Site {
  let credFields: string[] = [];
  try {
    credFields = Object.entries(credsOf(row)).filter(([, v]) => v).map(([k]) => k);
  } catch {
    // 復号できないときは「未保存」として見せる（入れ直せば直る）
  }
  return { id: row.id, kind: row.kind, name: row.name, enabled: row.enabled, auto: row.auto, rules: { ...defaultRules(row.kind), ...row.rules }, credFields };
}

export async function getSiteRow(id: string): Promise<SiteRow> {
  const row = must(await db().from("autopost_sites").select("*").eq("id", id).maybeSingle()) as SiteRow | null;
  if (!row) throw new UserError("投稿先が見つかりません");
  return row;
}

export async function getVideo(id: string): Promise<Video> {
  const row = must(await db().from("autopost_videos").select(VIDEO_COLUMNS).eq("id", id).maybeSingle()) as Video | null;
  if (!row) throw new UserError("動画が見つかりません");
  return row;
}

/** 動画を読むための期限つき URL */
export async function signedUrl(path: string, seconds = 3600): Promise<string> {
  if (!path) throw new UserError("この動画はまだアップロードが終わっていません");
  const { data, error } = await db().storage.from(BUCKET).createSignedUrl(path, seconds);
  if (error || !data) throw new Error(`動画の URL を作れませんでした：${error?.message ?? ""}`);
  return data.signedUrl;
}

export type { Member, Post, Video };
