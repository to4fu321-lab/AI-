import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { db, transaction, UserError, type MailboxRow } from "./db";
import { oauthClient, redirectUri, revoke } from "./gmail";

/**
 * 利用者のログイン（Google でログイン）と、ログインの印（セッション）。
 *
 * - ログインで Google から受け取るのは「誰か」だけ（openid・email・profile）。メールを読む許可とは別で、
 *   メールボックスをつなぐ手続き（gmail.ts）は、ログインのあとに利用者が自分で行う
 * - ログインの印は、乱数を Cookie に入れ、データベースにはそのハッシュだけを置く（データベースを見られても、なりすませない）
 * - 利用者を見分ける鍵は、メールアドレスではなく Google の sub（変わらない番号）。アドレスは変わることがあるため
 */

export const SESSION_COOKIE = "mg_session";
const SESSION_DAYS = 30;

export interface User {
  id: string;
  email: string;
  name: string;
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Google のログイン画面の URL。nonce は、返ってきた身分証が今回の手続きのものか確かめるための合言葉 */
export function loginUrl(origin: string, state: string, nonce: string): string {
  const p = new URLSearchParams({
    client_id: oauthClient().id,
    redirect_uri: redirectUri(origin),
    response_type: "code",
    scope: "openid email profile",
    prompt: "select_account",
    state,
    nonce,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

interface IdToken {
  iss?: string;
  aud?: string;
  sub?: string;
  exp?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

/**
 * Google から戻ってきた code を身分証（ID トークン）に換えて、利用者を確かめる。
 * 身分証は Google のサーバーから直接（TLS で）受け取るので、署名の検証は省ける（Google の案内どおり）。
 * そのかわり、宛先（aud）・発行元（iss）・期限（exp）・合言葉（nonce）は必ず確かめる
 */
export async function finishLogin(code: string, origin: string, nonce: string): Promise<User> {
  const client = oauthClient();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: client.id, client_secret: client.secret, redirect_uri: redirectUri(origin), grant_type: "authorization_code" }),
    signal: AbortSignal.timeout(15000),
  });
  const json = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string; error_description?: string };
  if (!res.ok || !json.id_token) throw new UserError(`Google でログインできませんでした（${json.error_description ?? json.error ?? res.status}）`);
  let claims: IdToken;
  try {
    claims = JSON.parse(Buffer.from(json.id_token.split(".")[1] ?? "", "base64url").toString("utf8")) as IdToken;
  } catch {
    throw new UserError("Google から届いた身分証を読めませんでした");
  }
  const okIssuer = claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
  if (!okIssuer || claims.aud !== client.id || !claims.sub || !claims.exp || claims.exp * 1000 < Date.now() || claims.nonce !== nonce) {
    throw new UserError("Google から届いた身分証を確かめられませんでした。もう一度ログインしてください");
  }
  if (!claims.email || claims.email_verified !== true) throw new UserError("メールアドレスの確認が済んでいない Google アカウントでは、ログインできません");

  return transaction(async (c) => {
    const r = await c.query<User>(
      `insert into migrate_users (google_sub, email, name, last_login) values ($1, $2, $3, now())
       on conflict (google_sub) do update set email = excluded.email, name = excluded.name, last_login = now()
       returning id, email, name`,
      [claims.sub, claims.email!.toLowerCase(), (claims.name ?? "").slice(0, 100)],
    );
    const user = r.rows[0];
    // 利用者の分離を入れる前（1 人専用だったとき）のデータは、持ち主がない。最初の利用者が引き継ぐ。
    // 利用者が 2 人以上いるときは何もしない（新しく作る行には必ず持ち主が付くので、持ち主なしの行は増えない）
    const count = await c.query<{ n: string }>("select count(*) as n from migrate_users");
    if (Number(count.rows[0].n) === 1) {
      await c.query("update migrate_mailboxes set user_id = $1 where user_id is null", [user.id]);
      await c.query("update migrate_services set user_id = $1 where user_id is null", [user.id]);
    }
    return user;
  });
}

/** ログインの印を作る。返すのは Cookie に入れる値（データベースにはハッシュだけ置く） */
export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const pool = await db();
  await pool.query(`insert into migrate_sessions (token_hash, user_id, expires_at) values ($1, $2, now() + interval '${SESSION_DAYS} days')`, [hash(token), userId]);
  // 期限の切れた印を片づける（たまるだけなので、ついでに）
  await pool.query("delete from migrate_sessions where expires_at < now()").catch(() => {});
  return token;
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${token ? SESSION_DAYS * 86400 : 0}; HttpOnly; Secure; SameSite=Lax`;
}

function tokenOf(request: Request): string {
  return new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(request.headers.get("cookie") ?? "")?.[1] ?? "";
}

/** いまログインしている利用者（していなければ null） */
export async function currentUser(request: Request): Promise<User | null> {
  const token = tokenOf(request);
  if (!token) return null;
  const r = await (await db()).query<User>(
    "select u.id, u.email, u.name from migrate_sessions s join migrate_users u on u.id = s.user_id where s.token_hash = $1 and s.expires_at > now()",
    [hash(token)],
  );
  return r.rows[0] ?? null;
}

/** ログアウト（この端末の印だけ消す） */
export async function destroySession(request: Request): Promise<void> {
  const token = tokenOf(request);
  if (token) await (await db()).query("delete from migrate_sessions where token_hash = $1", [hash(token)]);
}

/**
 * アカウントの削除。つないだメールの許可を Google 側でも取り消し、この利用者のデータをすべて消す
 * （メールボックス・サービスの一覧・ログインの印は、利用者の行に連なって消える）
 */
export async function deleteAccount(userId: string): Promise<void> {
  const pool = await db();
  const boxes = await pool.query<Pick<MailboxRow, "token_enc">>("select token_enc from migrate_mailboxes where user_id = $1", [userId]);
  await Promise.all(boxes.rows.map((b) => revoke(b)));
  await pool.query("delete from migrate_users where id = $1", [userId]);
}
