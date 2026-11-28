import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db, transaction, UserError, uuid } from "./db";
import { fetchPublicJson, isFetchableUrl } from "./netguard";

/**
 * AI 秘書が「ログインして許可する」方式（OAuth 2.1）でつなぐための、許可を出す側のサーバー。
 * MCP の決まり（2025-11-25 版）に合わせる。
 *
 * 流れ：
 *  1. AI 秘書が MCP の入口を呼ぶ → 401 と「許可はここで取れる」という案内（mcp の入口と .well-known）
 *  2. AI 秘書が自分を名乗る（文書の URL を名乗る＝CIMD／その場で登録する＝DCR）
 *  3. 利用者のブラウザが申し込みの入口（authorize）に来る → 中身を確かめて、許可の画面（/migrate/authorize）へ
 *  4. 利用者がログインして、見せるアドレスを選んで許可 → 1 回かぎりの引換券（code）を AI 秘書の戻り先へ
 *  5. AI 秘書が引換券を合言葉（access・refresh）に換える（token）。以後は合言葉で MCP を呼ぶ
 *
 * 守り：
 *  - 合言葉を預かる相手はすべて「秘密を持てない相手」として扱う（クライアントの秘密は発行しない）。
 *    そのかわり PKCE（S256）を必須にする。引換券を途中で盗まれても、合言葉には換えられない
 *  - 引換券・合言葉・申し込みの番号は、どれもハッシュだけを置く（データベースを見られても、なりすませない）
 *  - 戻り先は、登録と 1 文字も違わないものだけ（自分の PC の中に戻るものだけ、ポート番号の違いを許す）
 *  - 引換券は 1 回かぎり。2 回使われたら、1 回目で出した合言葉も取り消す
 *  - refresh は使うたびに取り替える。取り替え済みのものがもう一度使われたら、盗まれた印として、つながりごと取り消す
 *    （取り替えの直後の数秒だけは、同じ相手が同時に 2 回送っただけとみなして、断るだけにする）
 *  - 合言葉には宛先（この MCP サーバーの URL）を結び付け、宛先の違う合言葉は受け付けない
 */

export const SCOPE = "mail.read";
/** MCP の入口のパス */
export const MCP_PATH = "/api/mcp/migrate";
const OAUTH_PATH = `${MCP_PATH}/oauth`;

const ACCESS_SECONDS = 3600;
const REFRESH_DAYS = 60;
const CODE_SECONDS = 120;
const REQUEST_SECONDS = 600;
/** 1 人が OAuth でつなげる AI 秘書の数。超えたら、いちばん長く使っていないものから自動で取り消す（つなぎ直すたびに 1 本増えるため） */
export const MAX_OAUTH_GRANTS = 20;
/** 取り替えた直後、同じ refresh がもう一度届いても「同時に 2 回送っただけ」とみなす秒数 */
const REUSE_GRACE_SECONDS = 10;
/** 取り替え済みの refresh を、使い回しの見張りのために残しておく日数 */
const USED_REFRESH_DAYS = 7;
/** CIMD の文書の控えを使い回す時間 */
const CIMD_CACHE_SECONDS = 3600;

const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const random = (prefix: string) => prefix + randomBytes(32).toString("base64url");

/** OAuth の決まりどおりの形で返すエラー */
export class OAuthError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
  }
}

// ---------- 案内（メタデータ）

export const resourceUrl = (origin: string) => `${origin}${MCP_PATH}`;
export const resourceMetadataUrl = (origin: string) => `${origin}/.well-known/oauth-protected-resource${MCP_PATH}`;

/** 守られている側（MCP サーバー）の案内（RFC 9728） */
export function protectedResourceMetadata(origin: string) {
  return {
    resource: resourceUrl(origin),
    authorization_servers: [origin],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "アカウント引っ越し（複数メールの台帳）",
  };
}

/** 許可を出す側の案内（RFC 8414） */
export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}${OAUTH_PATH}/authorize`,
    token_endpoint: `${origin}${OAUTH_PATH}/token`,
    registration_endpoint: `${origin}${OAUTH_PATH}/register`,
    revocation_endpoint: `${origin}${OAUTH_PATH}/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SCOPE],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

// ---------- 回数の上限（ログインなしで呼べる入口用）

/** 呼び出し元の住所（Vercel が付けるヘッダ。利用者は書き換えられない）。記録にはハッシュだけ使う */
export function callerKey(request: Request): string {
  const ip = request.headers.get("x-real-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  return sha(`ip|${ip}`).slice(0, 24);
}

/** 決めた時間の中で、決めた回数を超えていたら false */
export async function throttle(bucket: string, max: number, seconds: number): Promise<boolean> {
  const pool = await db();
  const r = await pool.query<{ n: number }>("select count(*)::int as n from migrate_rate where bucket = $1 and at > now() - make_interval(secs => $2)", [bucket, seconds]);
  if ((r.rows[0]?.n ?? 0) >= max) return false;
  await pool.query("insert into migrate_rate (bucket) values ($1)", [bucket]);
  if (Math.random() < 0.05) await sweep().catch(() => {});
  return true;
}

/** 期限の切れたものを片づける */
export async function sweep(): Promise<void> {
  const pool = await db();
  await pool.query("delete from migrate_rate where at < now() - interval '1 day'");
  await pool.query("delete from migrate_oauth_requests where expires_at < now()");
  await pool.query("delete from migrate_oauth_codes where expires_at < now() - interval '1 day'");
  await pool.query("delete from migrate_oauth_tokens where expires_at < now() - interval '1 day'");
  // 生きている refresh が 1 つもない OAuth のつながりは、もう使えない。一覧から外す
  await pool.query(
    `update migrate_grants g set revoked_at = now() where g.kind = 'oauth' and g.revoked_at is null
       and not exists (select 1 from migrate_oauth_tokens t where t.grant_id = g.id and t.kind = 'refresh' and t.used_at is null and t.expires_at > now())`,
  );
  // 登録だけして（文書を読んだだけで）許可まで進まなかった相手と、長く使われていない相手を消す（生きているつながりがあるものは残す）
  await pool.query(
    `delete from migrate_oauth_clients c
     where ((c.last_used_at is null and c.created_at < now() - interval '1 day') or coalesce(c.last_used_at, c.created_at) < now() - interval '90 days')
       and not exists (select 1 from migrate_grants g where g.client_id = c.client_id and g.revoked_at is null)`,
  );
}

// ---------- 戻り先

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** 登録してよい戻り先か：https、または自分の PC の中（http://localhost など）。かけら（#）やユーザー名は不可 */
export function validRedirect(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 500 || /[\s<>"\\^`{|}]/.test(value)) return false;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.hash || value.includes("#") || u.username || u.password) return false;
  if (u.protocol === "https:") return u.hostname.includes(".") || LOOPBACK.has(u.hostname);
  return u.protocol === "http:" && LOOPBACK.has(u.hostname);
}

/** 申し込みの戻り先が、登録のどれかと同じか。自分の PC の中に戻るものだけ、ポート番号の違いを許す（RFC 8252） */
export function redirectMatches(registered: string[], requested: string): boolean {
  if (!validRedirect(requested)) return false;
  if (registered.includes(requested)) return true;
  const want = new URL(requested);
  if (want.protocol !== "http:" || !LOOPBACK.has(want.hostname)) return false;
  return registered.some((r) => {
    try {
      const have = new URL(r);
      return have.protocol === "http:" && have.hostname === want.hostname && have.pathname === want.pathname && have.search === want.search;
    } catch {
      return false;
    }
  });
}

// ---------- つなぎに来る相手（クライアント）

export interface OAuthClient {
  client_id: string;
  kind: "dcr" | "cimd";
  name: string;
  redirect_uris: string[];
}

const cleanName = (v: unknown, fallback: string) =>
  (typeof v === "string" ? v : "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\u2066-\u2069\ufeff]/g, "")
    .trim()
    .slice(0, 60) || fallback;

/** その場での登録（RFC 7591）。秘密は発行しない */
export async function registerClient(input: unknown): Promise<Record<string, unknown>> {
  const body = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > 10 || !uris.every(validRedirect) || new Set(uris).size !== uris.length) {
    throw new OAuthError("invalid_redirect_uri", "redirect_uris must be 1-10 unique https URLs or http loopback URLs without fragments");
  }
  const grants = body.grant_types;
  if (grants !== undefined && (!Array.isArray(grants) || !grants.includes("authorization_code"))) throw new OAuthError("invalid_client_metadata", "grant_types must include authorization_code");
  const responses = body.response_types;
  if (responses !== undefined && (!Array.isArray(responses) || !responses.includes("code"))) throw new OAuthError("invalid_client_metadata", "response_types must include code");
  const name = cleanName(body.client_name, "名前のない AI 秘書");
  const clientId = random("mgc_");
  const r = await (await db()).query<{ created_at: Date }>("insert into migrate_oauth_clients (client_id, kind, name, redirect_uris) values ($1, 'dcr', $2, $3) returning created_at", [clientId, name, uris]);
  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(r.rows[0].created_at.getTime() / 1000),
    client_name: name,
    redirect_uris: uris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: SCOPE,
  };
}

/** 相手が公開している文書（CIMD）を読んで確かめる。使えなければ null */
async function fetchCimd(clientId: string): Promise<OAuthClient | null> {
  const doc = (await fetchPublicJson(clientId)) as Record<string, unknown> | null;
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  // 文書の中の client_id は、読みに行った URL と 1 文字も違ってはいけない（他人の文書を自分のものと名乗らせない）
  if (doc.client_id !== clientId) return null;
  const uris = doc.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > 20 || !uris.every(validRedirect)) return null;
  // 秘密を使う相手は扱わない（こちらは秘密を預からない）
  const method = doc.token_endpoint_auth_method;
  if ((method !== undefined && method !== "none") || "client_secret" in doc) return null;
  return { client_id: clientId, kind: "cimd", name: cleanName(doc.client_name, new URL(clientId).hostname), redirect_uris: uris as string[] };
}

/** client_id から相手を確かめる（URL の形なら文書を読む。そうでなければ登録を探す） */
export async function resolveClient(clientId: string): Promise<OAuthClient | null> {
  if (!clientId || clientId.length > 512) return null;
  const pool = await db();
  const cached = (await pool.query<OAuthClient & { fresh: boolean }>(`select client_id, kind, name, redirect_uris, fetched_at > now() - make_interval(secs => $2) as fresh from migrate_oauth_clients where client_id = $1`, [clientId, CIMD_CACHE_SECONDS])).rows[0];
  if (!/^https:\/\//i.test(clientId)) return cached?.kind === "dcr" ? cached : null;
  if (!isFetchableUrl(clientId)) return null;
  if (cached?.kind === "cimd" && cached.fresh) return cached;
  // 初めて見る URL を読みに行く回数には、全体の上限を付ける（でたらめな URL を大量に送られて、読みに行かされ続けないように）
  if (!cached && !(await throttle("cimd-new|all", 600, 3600))) return null;
  const fetched = await fetchCimd(clientId);
  // 読めなかったときは、控えがあればそれを使う（相手のサーバーの一時的な不調で、つなげなくならないように）
  if (!fetched) return cached?.kind === "cimd" ? cached : null;
  await pool.query(
    `insert into migrate_oauth_clients (client_id, kind, name, redirect_uris) values ($1, 'cimd', $2, $3)
     on conflict (client_id) do update set name = excluded.name, redirect_uris = excluded.redirect_uris, fetched_at = now() where migrate_oauth_clients.kind = 'cimd'`,
    [fetched.client_id, fetched.name, fetched.redirect_uris],
  );
  return fetched;
}

// ---------- 申し込み（authorize）

/** 宛先（resource）がこの MCP サーバーか。書き方の小さな揺れ（大文字のホスト・末尾の /）は同じとみなす */
function sameResource(value: string, origin: string): boolean {
  try {
    const u = new URL(value);
    if (u.hash || u.search || u.username || u.password) return false;
    return `${u.origin}${u.pathname.replace(/\/$/, "")}` === resourceUrl(origin);
  } catch {
    return false;
  }
}

export type AuthorizeResult =
  /** 相手か戻り先が確かめられない。戻り先へは飛ばさず、その場で断る */
  | { kind: "reject"; reason: string }
  /** 相手は確かめられた。エラーは戻り先へ伝える */
  | { kind: "error"; location: string }
  /** 申し込みを受け付けた。許可の画面へ */
  | { kind: "ok"; location: string };

/** 戻り先に付ける返事の URL を作る（発行元 iss を必ず付ける。別のサーバーの返事と取り違えさせない） */
function redirectWith(redirectUri: string, origin: string, params: Record<string, string | null>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== "") u.searchParams.set(k, v);
  u.searchParams.set("iss", origin);
  return u.toString();
}

const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const AUTHORIZE_PARAMS = ["response_type", "client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "resource", "scope"];

/** 申し込みの中身を確かめ、許可の画面を出すまで覚えておく */
export async function startAuthorization(params: URLSearchParams, origin: string): Promise<AuthorizeResult> {
  // 同じ項目が 2 回書かれた申し込みは受け付けない（確かめる側と使う側で、別の値を読ませる手口を防ぐ）
  if (AUTHORIZE_PARAMS.some((k) => params.getAll(k).length > 1)) return { kind: "reject", reason: "同じ項目が 2 回書かれています" };
  const clientId = params.get("client_id") ?? "";
  const client = await resolveClient(clientId);
  if (!client) return { kind: "reject", reason: "つなごうとしている AI 秘書を確かめられませんでした" };
  const redirectUri = params.get("redirect_uri") ?? "";
  if (!redirectUri || !redirectMatches(client.redirect_uris, redirectUri)) return { kind: "reject", reason: "戻り先が、AI 秘書の登録と違います" };

  const state = params.get("state");
  // 申し込みの中身のまちがいは、決まりでは戻り先へ伝える。ただし、自分で登録しただけの相手（身元を確かめていない）の戻り先へは、
  // 利用者が何も押していないうちは飛ばさない（このサイトの URL を、よそのサイトへの踏み台に使わせない）
  const fail = (error: string, description: string, withState = true): AuthorizeResult =>
    client.kind === "cimd" ? { kind: "error", location: redirectWith(redirectUri, origin, { error, error_description: description, state: withState ? state : null }) } : { kind: "reject", reason: "AI 秘書からの申し込みの形が、決まりと違います" };
  if (state !== null && state.length > 2048) return fail("invalid_request", "state is too long", false);
  if (params.get("response_type") !== "code") return fail("unsupported_response_type", "only response_type=code is supported");
  const challenge = params.get("code_challenge") ?? "";
  if (!CHALLENGE.test(challenge)) return fail("invalid_request", "code_challenge (PKCE) is required");
  if (params.get("code_challenge_method") !== "S256") return fail("invalid_request", "code_challenge_method must be S256");
  const resource = params.get("resource");
  if (resource !== null && !sameResource(resource, origin)) return fail("invalid_target", "resource must be this MCP server");

  const id = random("");
  const pool = await db();
  await pool.query(
    `insert into migrate_oauth_requests (id_hash, client_id, redirect_uri, state, code_challenge, resource, expires_at) values ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))`,
    [sha(id), client.client_id, redirectUri, state, challenge, resourceUrl(origin), REQUEST_SECONDS],
  );
  return { kind: "ok", location: `${origin}/migrate/authorize?${new URLSearchParams({ req: id })}` };
}

/** 申し込みの番号の形（形が違うものをデータベースへ渡さない） */
export const REQUEST_ID = /^[A-Za-z0-9_-]{43}$/;

function expired(): never {
  throw new UserError("この許可の申し込みは、期限が切れたか、もう使われています。AI 秘書の側で、もう一度つなぎ直してください", "expired");
}

function requestId(value: unknown): string {
  if (typeof value !== "string" || !REQUEST_ID.test(value)) expired();
  return value;
}

/** 許可の画面に出す、申し込みの中身 */
export interface AuthorizationInfo {
  /** 相手が名乗っている名前 */
  name: string;
  /** 相手の身元を確かめられたドメイン（文書を公開している相手だけ。自分で登録しただけの相手は null） */
  verifiedHost: string | null;
  /** 相手が自分の説明を公開している場所（ドメインとパス。共有のサーバーでは、パスまで見ないと持ち主が分からない） */
  publishedAt: string | null;
  /** 許可のあとに戻る先のホスト */
  redirectHost: string;
  /** 戻る先が、利用者の PC の中か */
  loopback: boolean;
}

interface RequestRow {
  client_id: string;
  redirect_uri: string;
  state: string | null;
  code_challenge: string;
  resource: string;
}

export async function authorizationInfo(req: unknown): Promise<AuthorizationInfo> {
  const r = await (await db()).query<RequestRow & { name: string; kind: string }>(
    `select q.client_id, q.redirect_uri, c.name, c.kind from migrate_oauth_requests q join migrate_oauth_clients c on c.client_id = q.client_id where q.id_hash = $1 and q.expires_at > now()`,
    [sha(requestId(req))],
  );
  const row = r.rows[0];
  if (!row) expired();
  const to = new URL(row.redirect_uri);
  const doc = row.kind === "cimd" ? new URL(row.client_id) : null;
  return { name: row.name, verifiedHost: doc?.hostname ?? null, publishedAt: doc ? `${doc.hostname}${doc.pathname}` : null, redirectHost: to.host, loopback: LOOPBACK.has(to.hostname) };
}

/**
 * 利用者の答え（許可する・しない）を受けて、AI 秘書の戻り先の URL を返す。
 * 申し込みは 1 回かぎり（答えた時点で消す）
 */
export async function decideAuthorization(userId: string, req: unknown, approve: unknown, mailboxInput: unknown, origin: string): Promise<string> {
  const idHash = sha(requestId(req));
  return transaction(async (c) => {
    const taken = await c.query<RequestRow & { name: string | null }>(
      `delete from migrate_oauth_requests q where q.id_hash = $1 and q.expires_at > now()
       returning q.client_id, q.redirect_uri, q.state, q.code_challenge, q.resource, (select name from migrate_oauth_clients c where c.client_id = q.client_id) as name`,
      [idHash],
    );
    const row = taken.rows[0];
    if (!row || row.name === null) expired();
    if (approve !== true) return redirectWith(row.redirect_uri, origin, { error: "access_denied", error_description: "the user denied the request", state: row.state });

    let mailboxIds: string[] | null = null;
    if (Array.isArray(mailboxInput)) {
      const ids = [...new Set(mailboxInput.map((x) => uuid(x)))];
      if (!ids.length) throw new UserError("見せるメールボックスを、1 つ以上選んでください");
      // 自分のメールボックスだけを受け付ける
      const mine = await c.query("select id from migrate_mailboxes where user_id = $1 and id = any($2)", [userId, ids]);
      if (mine.rows.length !== ids.length) throw new UserError("メールボックスが見つかりません");
      mailboxIds = ids;
    } else if (mailboxInput !== null && mailboxInput !== undefined) throw new UserError("メールボックスの指定の形が違います");
    const code = random("mgo_");
    await c.query(
      `insert into migrate_oauth_codes (code_hash, user_id, client_id, client_name, redirect_uri, code_challenge, resource, mailbox_ids, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(secs => $9))`,
      [sha(code), userId, row.client_id, row.name, row.redirect_uri, row.code_challenge, row.resource, mailboxIds, CODE_SECONDS],
    );
    return redirectWith(row.redirect_uri, origin, { code, state: row.state });
  });
}

// ---------- 合言葉（token）

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

type Query = { query: (text: string, values?: unknown[]) => Promise<unknown> };

async function issue(c: Query, grantId: string): Promise<TokenResponse> {
  const access = random("mga_");
  const refresh = random("mgr_");
  await c.query(
    `insert into migrate_oauth_tokens (token_hash, grant_id, kind, expires_at) values ($1, $3, 'access', now() + make_interval(secs => $4)), ($2, $3, 'refresh', now() + make_interval(days => $5))`,
    [sha(access), sha(refresh), grantId, ACCESS_SECONDS, REFRESH_DAYS],
  );
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_SECONDS, refresh_token: refresh, scope: SCOPE };
}

/** つながりを取り消し、その合言葉をすべて消す */
async function killGrant(c: Query, grantId: string): Promise<void> {
  await c.query("update migrate_grants set revoked_at = coalesce(revoked_at, now()) where id = $1", [grantId]);
  await c.query("delete from migrate_oauth_tokens where grant_id = $1", [grantId]);
}

const invalidGrant = () => new OAuthError("invalid_grant", "the grant is invalid, expired, revoked, or was issued to another client");
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

function equalText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** 入口に届いた項目から 1 つ読む（2 回書かれていたら断る） */
function one(form: URLSearchParams, key: string): string | null {
  const all = form.getAll(key);
  if (all.length > 1) throw new OAuthError("invalid_request", `${key} must not be repeated`);
  return all[0] ?? null;
}

/** 引換券や refresh を、合言葉に換える */
export async function exchangeToken(form: URLSearchParams, origin: string): Promise<TokenResponse> {
  const grantType = one(form, "grant_type");
  const clientId = one(form, "client_id") ?? "";
  const resource = one(form, "resource");
  if (!clientId) throw new OAuthError("invalid_client", "client_id is required");
  if (resource !== null && !sameResource(resource, origin)) throw new OAuthError("invalid_target", "resource must be this MCP server");
  if (grantType === "authorization_code") return exchangeCode(form, clientId);
  if (grantType === "refresh_token") return refresh(form, clientId);
  throw new OAuthError("unsupported_grant_type", "only authorization_code and refresh_token are supported");
}

async function exchangeCode(form: URLSearchParams, clientId: string): Promise<TokenResponse> {
  const code = one(form, "code") ?? "";
  const verifier = one(form, "code_verifier") ?? "";
  // 戻り先は、送られてきたら申し込みと同じかを確かめる（新しい決まりでは省いてよい。途中で盗まれた引換券は PKCE で防ぐ）
  const redirectUri = one(form, "redirect_uri");
  if (!code) throw new OAuthError("invalid_request", "code is required");
  if (!VERIFIER.test(verifier)) throw new OAuthError("invalid_request", "code_verifier (PKCE) is required");
  // 途中で断るときも、取り消しは必ず書き込む（投げずに結果で返す）
  const result = await transaction(async (c): Promise<TokenResponse | null> => {
    const r = await c.query<{ user_id: string; client_id: string; client_name: string; redirect_uri: string; code_challenge: string; resource: string; mailbox_ids: string[] | null; used_at: Date | null; grant_id: string | null; live: boolean }>(
      "select *, expires_at > now() as live from migrate_oauth_codes where code_hash = $1 for update",
      [sha(code)],
    );
    const row = r.rows[0];
    if (!row) return null;
    if (row.used_at) {
      // 引換券が 2 回使われた。途中で盗まれたおそれがあるので、1 回目で出した合言葉も取り消す
      if (row.grant_id) await killGrant(c, row.grant_id);
      return null;
    }
    if (!row.live || row.client_id !== clientId || (redirectUri !== null && row.redirect_uri !== redirectUri)) return null;
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (!equalText(challenge, row.code_challenge)) return null;
    // 許可のあと、引き換えまでの間に消されたメールボックスは、見せる対象から外す
    let mailboxIds = row.mailbox_ids;
    if (mailboxIds) {
      const mine = await c.query<{ id: string }>("select id from migrate_mailboxes where user_id = $1 and id = any($2)", [row.user_id, mailboxIds]);
      mailboxIds = mine.rows.map((m) => m.id);
    }
    const g = await c.query<{ id: string }>(
      `insert into migrate_grants (user_id, name, token_hint, mailbox_ids, kind, client_id, resource) values ($1, $2, '', $3, 'oauth', $4, $5) returning id`,
      [row.user_id, row.client_name || "AI 秘書", mailboxIds, row.client_id, row.resource],
    );
    await c.query("update migrate_oauth_codes set used_at = now(), grant_id = $2 where code_hash = $1", [sha(code), g.rows[0].id]);
    await c.query("update migrate_oauth_clients set last_used_at = now() where client_id = $1", [row.client_id]);
    // つながりが上限を超えたら、いちばん長く使っていないものから取り消す
    const extra = await c.query<{ id: string }>(
      `select id from migrate_grants where user_id = $1 and kind = 'oauth' and revoked_at is null order by coalesce(last_used_at, created_at) desc, id offset $2`,
      [row.user_id, MAX_OAUTH_GRANTS],
    );
    for (const old of extra.rows) if (old.id !== g.rows[0].id) await killGrant(c, old.id);
    return issue(c, g.rows[0].id);
  });
  if (!result) throw invalidGrant();
  return result;
}

async function refresh(form: URLSearchParams, clientId: string): Promise<TokenResponse> {
  const token = one(form, "refresh_token") ?? "";
  if (!token) throw new OAuthError("invalid_request", "refresh_token is required");
  const result = await transaction(async (c): Promise<TokenResponse | null> => {
    const r = await c.query<{ grant_id: string; used_at: Date | null; just_used: boolean; live: boolean; client_id: string | null; revoked: boolean }>(
      `select t.grant_id, t.used_at, t.used_at > now() - make_interval(secs => ${REUSE_GRACE_SECONDS}) as just_used, t.expires_at > now() as live, g.client_id, g.revoked_at is not null as revoked
       from migrate_oauth_tokens t join migrate_grants g on g.id = t.grant_id where t.token_hash = $1 and t.kind = 'refresh' for update of t`,
      [sha(token)],
    );
    const row = r.rows[0];
    if (!row || row.revoked) return null;
    if (row.used_at) {
      // 取り替え済みの refresh がもう一度使われた。盗まれた印として、つながりごと取り消す。
      // 取り替えの直後だけは、同じ相手が同時に 2 回送っただけとみなして、断るだけにする（つながりは残す）
      if (!row.just_used) await killGrant(c, row.grant_id);
      return null;
    }
    if (!row.live || row.client_id !== clientId) return null;
    // 1 本のつながりで取り替えられる回数に上限を付ける（合言葉の期限は 1 時間なので、ふつうは 1 時間に 1 回）
    if (!(await throttle(`refresh|${row.grant_id}`, 30, 3600))) throw new OAuthError("temporarily_unavailable", "too many refreshes, try again later", 429);
    // 取り替え済みの印を付ける。使い回しの見張りのために、しばらくだけ残す
    await c.query(`update migrate_oauth_tokens set used_at = now(), expires_at = least(expires_at, now() + make_interval(days => ${USED_REFRESH_DAYS})) where token_hash = $1`, [sha(token)]);
    await c.query("update migrate_oauth_clients set last_used_at = now() where client_id = $1", [clientId]);
    return issue(c, row.grant_id);
  });
  if (!result) throw invalidGrant();
  return result;
}

/** 合言葉の取り消し（RFC 7009）。AI 秘書の側で「接続を解除」したときに呼ばれる。つながりごと取り消す */
export async function revokeToken(form: URLSearchParams): Promise<void> {
  const token = one(form, "token") ?? "";
  if (!token || token.length > 200) return;
  await transaction(async (c) => {
    const r = await c.query<{ grant_id: string }>("select grant_id from migrate_oauth_tokens where token_hash = $1", [sha(token)]);
    if (r.rows[0]) await killGrant(c, r.rows[0].grant_id);
  });
}

/** MCP の呼び出しに付いてきた合言葉（access）から、どのつながりかを確かめる */
export async function authenticateAccess(token: string, resource: string): Promise<{ userId: string; grantId: string; mailboxIds: string[] | null } | null> {
  const r = await (await db()).query<{ id: string; user_id: string; mailbox_ids: string[] | null; resource: string | null }>(
    `select g.id, g.user_id, g.mailbox_ids, g.resource from migrate_oauth_tokens t join migrate_grants g on g.id = t.grant_id
     where t.token_hash = $1 and t.kind = 'access' and t.expires_at > now() and g.revoked_at is null and g.kind = 'oauth'`,
    [sha(token)],
  );
  const g = r.rows[0];
  // 宛先の違う合言葉は受け付けない
  if (!g || g.resource !== resource) return null;
  return { userId: g.user_id, grantId: g.id, mailboxIds: g.mailbox_ids };
}
