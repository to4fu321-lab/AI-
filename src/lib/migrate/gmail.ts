import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { db, getMailbox, UserError, type MailboxRow } from "./db";

/**
 * Gmail とのつながり（許可の受け取り・保存・取り消し）。メールの調べは scan.ts と sources/。
 *
 * - 権限は gmail.readonly（読むだけ）。送信・削除・ラベルの変更はできない。
 *   公開するときの Google の審査は「必要最小限の権限」が条件なので、読むだけで足りるこのアプリは、これより広い権限を求めない
 * - Gmail を読む合言葉（リフレッシュトークン）は暗号化してデータベースに保存する
 * 使うには、Vercel の環境変数 GOOGLE_MIGRATE_CLIENT_ID・GOOGLE_MIGRATE_CLIENT_SECRET（Google Cloud の OAuth クライアント）が要る
 */

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

const clientId = () => process.env.GOOGLE_MIGRATE_CLIENT_ID?.trim() || "";
const clientSecret = () => process.env.GOOGLE_MIGRATE_CLIENT_SECRET?.trim() || "";

export function googleConfigured(): boolean {
  return !!clientId() && !!clientSecret();
}

/** 戻り先（Google Cloud の「承認済みのリダイレクト URI」に登録するもの） */
export function redirectUri(origin: string): string {
  return `${origin}/api/migrate/oauth/callback`;
}

export function authUrl(origin: string, state: string): string {
  const p = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(origin),
    response_type: "code",
    scope: GMAIL_SCOPE,
    access_type: "offline",
    // 毎回アカウントを選ばせる（2 件目以降をつなぐとき、前のアカウントのまま進まないように）
    prompt: "consent select_account",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

// --- 合言葉の暗号化（データベースに平文で置かない。鍵はクライアントシークレットから作る） ---

const key = () => createHash("sha256").update(`migrate-gmail:${clientSecret()}`).digest();

function seal(text: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
}

function open(sealed: string): string | null {
  try {
    const [iv, tag, body] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
    const d = createDecipheriv("aes-256-gcm", key(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export const RECONNECT = "Gmail とのつながりが切れました。もう一度つないでください";

export async function accessToken(box: MailboxRow): Promise<string> {
  const refresh = open(box.token_enc);
  if (!refresh) throw new UserError(RECONNECT);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), refresh_token: refresh, grant_type: "refresh_token" }),
    signal: AbortSignal.timeout(15000),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!res.ok || !json.access_token) {
    throw new UserError(json.error === "invalid_grant" ? RECONNECT : `Google の認証に失敗しました（${json.error ?? res.status}）`);
  }
  return json.access_token;
}

/** Google から戻ってきた code を合言葉に換え、どのアドレスかを確かめて保存する */
export async function finishConnect(code: string, origin: string): Promise<{ email: string }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId(), client_secret: clientSecret(), redirect_uri: redirectUri(origin), grant_type: "authorization_code" }),
    signal: AbortSignal.timeout(15000),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) throw new Error(`Google の許可を受け取れませんでした（${json.error_description ?? json.error ?? res.status}）`);
  if (!json.refresh_token) throw new Error("Google から長く使える合言葉が届きませんでした。もう一度つないでください");
  const profile = (await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { authorization: `Bearer ${json.access_token}` }, signal: AbortSignal.timeout(15000) })
    .then((r) => r.json())
    .catch(() => ({}))) as { emailAddress?: string };
  const email = profile.emailAddress?.toLowerCase();
  if (!email) throw new Error("つないだアドレスを確かめられませんでした");
  // つなぎ直したときは、前の止まった理由を消す（数えた結果と続きの場所は残す）
  await (await db()).query(
    "insert into migrate_mailboxes (email, token_enc) values ($1, $2) on conflict (email) do update set token_enc = excluded.token_enc, error = ''",
    [email, seal(json.refresh_token)],
  );
  return { email };
}

/** つながりを切る（Google 側の許可も取り消し、このメールボックスの調べた結果も消す） */
export async function disconnect(id: string): Promise<void> {
  const box = await getMailbox(id);
  const refresh = open(box.token_enc);
  if (refresh) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refresh)}`, { method: "POST" }).catch(() => {});
  await (await db()).query("delete from migrate_mailboxes where id = $1", [box.id]);
}
