import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { db, getMailbox, transaction, UserError, type MailboxRow } from "./db";
import { RetryLater } from "./sources/types";

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
// 鍵は、専用の環境変数 MIGRATE_TOKEN_KEY から作る（32 文字以上）。Google のクライアントシークレットとは分ける
// （シークレットを作り直しても、保存済みの合言葉が読めなくならないように）。
// 合言葉は「どの利用者の・どのアドレスのものか」と結び付けて暗号化する（AAD）。
// データベースを書き換えて、他人の行の合言葉を自分の行へ写しても、復号できない。
// 鍵を取り替えるとき：新しい鍵を MIGRATE_TOKEN_KEY に、これまでの鍵を MIGRATE_TOKEN_KEY_OLD に入れる。
// 古い鍵で読めた合言葉は、その場で新しい鍵に包み直す。全部が包み直されたら、MIGRATE_TOKEN_KEY_OLD を消す。
//
// 専用の鍵ができる前の形（v1：クライアントシークレットから作った鍵・結び付けなし）は、もう受け付けない。
// v1 のままの合言葉は「つなぎ直してください」になる。

const MIN_KEY_LENGTH = 32;
const tokenKey = () => process.env.MIGRATE_TOKEN_KEY?.trim() || "";
const oldTokenKey = () => process.env.MIGRATE_TOKEN_KEY_OLD?.trim() || "";
/** 専用の鍵が設定されているか（されていなければ、メールボックスをつなげない） */
export function tokenKeyConfigured(): boolean {
  return tokenKey().length >= MIN_KEY_LENGTH;
}
const derive = (secret: string) => createHash("sha256").update(`migrate-token:v2:${secret}`).digest();
/** 鍵の見分け（どの鍵で包んだかを、暗号文に書いておく。鍵そのものは分からない） */
const keyId = (secret: string) => createHash("sha256").update(`migrate-token:id:${secret}`).digest("base64url").slice(0, 8);
const aadOf = (owner: { user_id: string | null; email: string }) => Buffer.from(`${owner.user_id ?? ""}|${owner.email}`, "utf8");

function seal(owner: { user_id: string | null; email: string }, text: string): string {
  if (!tokenKeyConfigured()) throw new UserError("合言葉を守る鍵（MIGRATE_TOKEN_KEY）が設定されていません", "no-token-key");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", derive(tokenKey()), iv);
  c.setAAD(aadOf(owner));
  const body = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return ["v2", keyId(tokenKey()), ...[iv, c.getAuthTag(), body].map((b) => b.toString("base64url"))].join(".");
}

/** 復号する。stale は、古い鍵で包まれていた（新しい鍵で包み直すべき）という印 */
function open(owner: { user_id: string | null; email: string }, sealed: string): { text: string; stale: boolean } | null {
  const [version, id, iv, tag, body] = sealed.split(".");
  if (version !== "v2" || !body) return null;
  for (const [secret, stale] of [[tokenKey(), false], [oldTokenKey(), true]] as const) {
    if (secret.length < MIN_KEY_LENGTH || keyId(secret) !== id) continue;
    try {
      const d = createDecipheriv("aes-256-gcm", derive(secret), Buffer.from(iv, "base64url"));
      d.setAAD(aadOf(owner));
      d.setAuthTag(Buffer.from(tag, "base64url"));
      return { text: Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8"), stale };
    } catch {
      return null;
    }
  }
  return null;
}

/** 1 人がつなげるメールボックスの数の上限（調べる時間と通信を、1 人が使いすぎないように） */
export const MAX_MAILBOXES = 5;

export const RECONNECT = "Gmail とのつながりが切れました。もう一度つないでください";

export async function accessToken(box: MailboxRow): Promise<string> {
  const opened = open(box, box.token_enc);
  if (!opened) throw new UserError(RECONNECT, "reconnect");
  const refresh = opened.text;
  // 古い鍵で包まれていた合言葉は、新しい鍵で包み直す
  if (opened.stale) {
    await (await db()).query("update migrate_mailboxes set token_enc = $2 where id = $1 and token_enc = $3", [box.id, seal(box, refresh), box.token_enc]).catch(() => {});
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), refresh_token: refresh, grant_type: "refresh_token" }),
    signal: AbortSignal.timeout(15000),
  }).catch(() => null);
  // Google の側の一時的な失敗・通信の失敗は、しばらく置いてやり直す（つながりが切れたことにはしない）
  if (!res || res.status >= 500 || res.status === 429) throw new RetryLater("Google の認証が混み合っています");
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!res.ok || !json.access_token) {
    if (json.error === "invalid_grant") throw new UserError(RECONNECT, "reconnect");
    console.error("[migrate] token refresh failed", res.status, String(json.error ?? "").slice(0, 40));
    throw new UserError("Google の認証に失敗しました。もう一度つなぎ直してください", "reconnect");
  }
  return json.access_token;
}

/** Google から戻ってきた code を合言葉に換え、どのアドレスかを確かめて保存する */
export async function finishConnect(userId: string, code: string, origin: string): Promise<{ email: string }> {
  if (!tokenKeyConfigured()) throw new UserError("合言葉を守る鍵（MIGRATE_TOKEN_KEY）が設定されていません", "no-token-key");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId(), client_secret: clientSecret(), redirect_uri: redirectUri(origin), grant_type: "authorization_code" }),
    signal: AbortSignal.timeout(15000),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; scope?: string; error?: string };
  if (!res.ok || !json.access_token) throw new UserError(`Google の許可を受け取れませんでした（${String(json.error ?? res.status).slice(0, 40)}）`);
  if (!json.refresh_token) throw new UserError("Google から長く使える合言葉が届きませんでした。もう一度つないでください");
  // 受け取った許可を確かめる：「読むだけ」が入っていて、それより広いメールの許可が入っていないこと。
  // （ログインで受け取った「誰か」の許可が一緒に返ってくることはある。それは構わない）
  const scopes = (json.scope ?? "").split(/\s+/).filter(Boolean);
  const harmless = (x: string) => x === GMAIL_SCOPE || x === "openid" || x === "email" || x === "profile" || x.startsWith("https://www.googleapis.com/auth/userinfo.");
  if (!scopes.includes(GMAIL_SCOPE) || !scopes.every(harmless)) {
    await revokeToken(json.refresh_token);
    throw new UserError("メールを読む許可（読み取りのみ）を受け取れませんでした。もう一度つないで、チェックを入れて許可してください", "scope");
  }
  const profile = (await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { authorization: `Bearer ${json.access_token}` }, signal: AbortSignal.timeout(15000) })
    .then((r) => r.json())
    .catch(() => ({}))) as { emailAddress?: string };
  const email = profile.emailAddress?.toLowerCase();
  if (!email) throw new UserError("つないだアドレスを確かめられませんでした");
  const sealed = seal({ user_id: userId, email }, json.refresh_token);
  const refreshToken = json.refresh_token;
  const saved = await transaction(async (c) => {
    // 同じ利用者の「数えてから足す」が同時に走らないよう、その利用者の分だけ順番に通す（上限をすり抜けさせない）
    await c.query("select pg_advisory_xact_lock(742002, hashtext($1))", [userId]);
    const mine = await c.query<{ email: string }>("select email from migrate_mailboxes where user_id = $1", [userId]);
    if (!mine.rows.some((r) => r.email === email) && mine.rows.length >= MAX_MAILBOXES) return false;
    // つなぎ直したときは、前の止まった理由を消す（記録と続きの場所は残す）
    await c.query(
      "insert into migrate_mailboxes (user_id, email, token_enc) values ($1, $2, $3) on conflict (user_id, email) do update set token_enc = excluded.token_enc, error = ''",
      [userId, email, sealed],
    );
    return true;
  });
  if (!saved) {
    await revokeToken(refreshToken);
    throw new UserError(`つなげるメールボックスは ${MAX_MAILBOXES} 件までです`, "too-many");
  }
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
  const opened = open(box, box.token_enc);
  if (opened) await revokeToken(opened.text);
  else if (box.token_enc) console.error("[migrate] revoke skipped: token could not be opened (the Google grant may still be active)");
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
