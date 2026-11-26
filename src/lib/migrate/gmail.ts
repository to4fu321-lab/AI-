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

/** いま設定されている OAuth クライアント（ログインにも同じものを使う） */
export function oauthClient(): { id: string; secret: string } {
  return { id: clientId(), secret: clientSecret() };
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

// --- 合言葉の暗号化（データベースに平文で置かない） ---
//
// 鍵は、専用の環境変数 MIGRATE_TOKEN_KEY から作る（v2）。Google のクライアントシークレットを作り直しても、
// 保存済みの合言葉が読めなくならないようにするため。
// v2 では、合言葉を「どの利用者の・どのアドレスのものか」と結び付けて暗号化する（AAD）。
// データベースを書き換えて、他人の行の合言葉を自分の行へ写しても、復号できない。
// MIGRATE_TOKEN_KEY がまだ無いあいだは、これまでどおりクライアントシークレットから作った鍵を使う（v1）。
// v1 の合言葉は、鍵が設定されたあと、次に使ったときに v2 へ包み直す。

const MIN_KEY_LENGTH = 32;
const tokenKey = () => process.env.MIGRATE_TOKEN_KEY?.trim() || "";
/** 専用の鍵が設定されているか */
export function tokenKeyConfigured(): boolean {
  return tokenKey().length >= MIN_KEY_LENGTH;
}
const keyV1 = () => createHash("sha256").update(`migrate-gmail:${clientSecret()}`).digest();
const keyV2 = () => createHash("sha256").update(`migrate-token:v2:${tokenKey()}`).digest();
const aadOf = (owner: { user_id: string | null; email: string }) => Buffer.from(`${owner.user_id ?? ""}|${owner.email}`, "utf8");

function seal(owner: { user_id: string | null; email: string }, text: string): string {
  const v2 = tokenKeyConfigured();
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", v2 ? keyV2() : keyV1(), iv);
  if (v2) c.setAAD(aadOf(owner));
  const body = Buffer.concat([c.update(text, "utf8"), c.final()]);
  const parts = [iv, c.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
  return v2 ? `v2.${parts}` : parts;
}

function open(owner: { user_id: string | null; email: string }, sealed: string): string | null {
  try {
    const v2 = sealed.startsWith("v2.");
    if (v2 && !tokenKeyConfigured()) return null;
    const [iv, tag, body] = (v2 ? sealed.slice(3) : sealed).split(".").map((p) => Buffer.from(p, "base64url"));
    const d = createDecipheriv("aes-256-gcm", v2 ? keyV2() : keyV1(), iv);
    if (v2) d.setAAD(aadOf(owner));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** 1 人がつなげるメールボックスの数の上限（調べる時間と通信を、1 人が使いすぎないように） */
export const MAX_MAILBOXES = 5;

export const RECONNECT = "Gmail とのつながりが切れました。もう一度つないでください";

export async function accessToken(box: MailboxRow): Promise<string> {
  const refresh = open(box, box.token_enc);
  if (!refresh) throw new UserError(RECONNECT);
  // 専用の鍵が設定されたあと、古い形で保存された合言葉は、新しい形へ包み直す
  if (tokenKeyConfigured() && !box.token_enc.startsWith("v2.")) {
    await (await db()).query("update migrate_mailboxes set token_enc = $2 where id = $1 and token_enc = $3", [box.id, seal(box, refresh), box.token_enc]).catch(() => {});
  }
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
export async function finishConnect(userId: string, code: string, origin: string): Promise<{ email: string }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId(), client_secret: clientSecret(), redirect_uri: redirectUri(origin), grant_type: "authorization_code" }),
    signal: AbortSignal.timeout(15000),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; scope?: string; error?: string };
  if (!res.ok || !json.access_token) throw new UserError(`Google の許可を受け取れませんでした（${String(json.error ?? res.status).slice(0, 40)}）`);
  if (!json.refresh_token) throw new UserError("Google から長く使える合言葉が届きませんでした。もう一度つないでください");
  // 受け取った許可が「読むだけ」ちょうどであることを確かめる（足りなくても、広すぎても、保存しない）
  const scopes = (json.scope ?? "").split(/\s+/).filter(Boolean);
  if (scopes.length !== 1 || scopes[0] !== GMAIL_SCOPE) {
    await revokeToken(json.refresh_token);
    throw new UserError("メールを読む許可（読み取りのみ）を受け取れませんでした。もう一度つないで、チェックを入れて許可してください");
  }
  const profile = (await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { authorization: `Bearer ${json.access_token}` }, signal: AbortSignal.timeout(15000) })
    .then((r) => r.json())
    .catch(() => ({}))) as { emailAddress?: string };
  const email = profile.emailAddress?.toLowerCase();
  if (!email) throw new UserError("つないだアドレスを確かめられませんでした");
  const pool = await db();
  const mine = await pool.query<{ email: string }>("select email from migrate_mailboxes where user_id = $1", [userId]);
  if (!mine.rows.some((r) => r.email === email) && mine.rows.length >= MAX_MAILBOXES) {
    await revokeToken(json.refresh_token);
    throw new UserError(`つなげるメールボックスは ${MAX_MAILBOXES} 件までです`);
  }
  // つなぎ直したときは、前の止まった理由を消す（数えた結果と続きの場所は残す）
  await pool.query(
    "insert into migrate_mailboxes (user_id, email, token_enc) values ($1, $2, $3) on conflict (user_id, email) do update set token_enc = excluded.token_enc, error = ''",
    [userId, email, seal({ user_id: userId, email }, json.refresh_token)],
  );
  return { email };
}

/** つながりを切る（Google 側の許可も取り消し、このメールボックスの調べた結果も消す） */
export async function disconnect(userId: string, id: string): Promise<void> {
  const box = await getMailbox(userId, id);
  await revoke(box);
  await (await db()).query("delete from migrate_mailboxes where id = $1 and user_id = $2", [box.id, userId]);
}

/** Google 側の許可を取り消す（失敗しても先へ進む。こちらの保存分は呼び出し側で消す） */
export async function revoke(box: Pick<MailboxRow, "token_enc" | "user_id" | "email">): Promise<void> {
  const refresh = open(box, box.token_enc);
  if (refresh) await revokeToken(refresh);
}

/** 合言葉は URL に載せず、本文で送る（URL は途中の記録に残りやすいため） */
async function revokeToken(token: string): Promise<void> {
  await fetch("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => {});
}
