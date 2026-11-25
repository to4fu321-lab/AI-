import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { db, getMailbox, UserError, type MailboxRow, type ScanState, type ServiceRow } from "./db";
import { decodeHeader, GMAIL_QUERY, isPersonalDomain, parseFrom, serviceDomain, signalsOf } from "./parse";
import type { ScanResult, Signal } from "./types";

/**
 * Gmail とのつながりと、メールの調べ。
 *
 * - 権限は gmail.readonly（読むだけ）。送信・削除・ラベルの変更はできない
 * - 読むのはヘッダ（差出人・件名・日付）だけ。本文は取りにいかない
 * - Gmail を読む合言葉（リフレッシュトークン）は暗号化してデータベースに保存する
 * 使うには、Vercel の環境変数 GOOGLE_MIGRATE_CLIENT_ID・GOOGLE_MIGRATE_CLIENT_SECRET（Google Cloud の OAuth クライアント）が要る
 */

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

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

const RECONNECT = "Gmail とのつながりが切れました。もう一度つないでください";

async function accessToken(box: MailboxRow): Promise<string> {
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
  const profile = (await gmail(json.access_token, "/profile")) as { emailAddress?: string };
  const email = profile.emailAddress?.toLowerCase();
  if (!email) throw new Error("つないだアドレスを確かめられませんでした");
  await (await db()).query("insert into migrate_mailboxes (email, token_enc) values ($1, $2) on conflict (email) do update set token_enc = excluded.token_enc", [email, seal(json.refresh_token)]);
  return { email };
}

/** つながりを切る（Google 側の許可も取り消し、このメールボックスの調べた結果も消す） */
export async function disconnect(id: string): Promise<void> {
  const box = await getMailbox(id);
  const refresh = open(box.token_enc);
  if (refresh) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refresh)}`, { method: "POST" }).catch(() => {});
  await (await db()).query("delete from migrate_mailboxes where id = $1", [box.id]);
}

/** Gmail の API を読む（混み合っているときは少し待ってやり直す） */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function gmail(token: string, path: string): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
    if (res.ok) return res.json();
    const body = await res.text().catch(() => "");
    // 読む速さの上限に当たった（1 人あたり 1 分に使える量を超えた）
    const limited = res.status === 429 || (res.status === 403 && /rateLimit|quota/i.test(body));
    // 待つのは最大 4 + 8 秒（1 回の呼び出しが Vercel の時間の上限を超えないように）
    if ((limited || res.status >= 500) && attempt < 2) {
      await sleep((limited ? 4000 : 800) * 2 ** attempt);
      continue;
    }
    if (limited) throw new UserError("Gmail の読み取りが混み合っています。1 分ほど待ってから「続きを調べる」を押してください（読み終えた所から再開します）");
    if (res.status === 401) throw new UserError(RECONNECT);
    if (res.status === 403) throw new UserError("Gmail を読む許可がありません。Google Cloud で Gmail API を有効にしたか、つなぐときに「メールの閲覧」を許可したか確かめてください");
    throw new Error(`Gmail の読み取りに失敗しました（HTTP ${res.status}）`);
  }
}

interface Header {
  from: string;
  subject: string;
  at: number;
}

async function readHeader(token: string, id: string): Promise<Header | null> {
  const m = (await gmail(token, `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&fields=internalDate,payload/headers`).catch((e) => {
    if (e instanceof UserError) throw e;
    return null; // 1 通だけ読めなくても、全体は止めない
  })) as { internalDate?: string; payload?: { headers?: { name: string; value: string }[] } } | null;
  if (!m) return null;
  const h = (name: string) => m.payload?.headers?.find((x) => x.name.toLowerCase() === name)?.value ?? "";
  return { from: h("from"), subject: decodeHeader(h("subject")).trim().slice(0, 120), at: Number(m.internalDate) || 0 };
}

interface Tally {
  count: number;
  names: Record<string, number>;
  signals: Partial<Record<Signal, number>>;
  subjects: { s: string; t: number }[];
  first: number;
  last: number;
}

/** 読んだヘッダを、差出人のドメインごとにまとめる */
export function tally(headers: Header[], ownEmail: string): Map<string, Tally> {
  const out = new Map<string, Tally>();
  for (const h of headers) {
    const from = parseFrom(h.from);
    if (!from || from.address === ownEmail || isPersonalDomain(from.address)) continue;
    const domain = serviceDomain(from.address);
    if (!domain) continue;
    const t = out.get(domain) ?? { count: 0, names: {}, signals: {}, subjects: [], first: h.at, last: h.at };
    t.count++;
    if (from.name) t.names[from.name] = (t.names[from.name] ?? 0) + 1;
    for (const s of signalsOf(h.subject)) t.signals[s] = (t.signals[s] ?? 0) + 1;
    if (h.subject) t.subjects.push({ s: h.subject, t: h.at });
    t.first = Math.min(t.first, h.at);
    t.last = Math.max(t.last, h.at);
    out.set(domain, t);
  }
  return out;
}

const SUBJECT_KEEP = 5;
const NAME_KEEP = 8;

/** まとめた分を、データベースの今の数に足しこむ（仕分けの状態やメモは変えない） */
async function merge(mailboxId: string, found: Map<string, Tally>): Promise<void> {
  if (!found.size) return;
  const pool = await db();
  const existing = (await pool.query<ServiceRow>("select * from migrate_services where mailbox_id = $1 and domain = any($2)", [mailboxId, [...found.keys()]])).rows;
  const byDomain = new Map(existing.map((r) => [r.domain, r]));
  const rows = [...found].map(([domain, t]) => {
    const old = byDomain.get(domain);
    const names: Record<string, number> = { ...(old?.names ?? {}) };
    for (const [n, k] of Object.entries(t.names)) names[n] = (names[n] ?? 0) + k;
    const top = Object.entries(names).sort((a, b) => b[1] - a[1]).slice(0, NAME_KEEP);
    const signals: Partial<Record<Signal, number>> = { ...(old?.signals ?? {}) };
    for (const [s, k] of Object.entries(t.signals) as [Signal, number][]) signals[s] = (signals[s] ?? 0) + k;
    const seen = new Set<string>();
    const subjects = [...(old?.subjects ?? []), ...t.subjects]
      .sort((a, b) => b.t - a.t)
      .filter((x) => !seen.has(x.s) && seen.add(x.s))
      .slice(0, SUBJECT_KEEP);
    const first = Math.min(t.first, old?.first_at?.getTime() ?? Infinity);
    const last = Math.max(t.last, old?.last_at?.getTime() ?? 0);
    return {
      domain,
      name: top[0]?.[0] ?? "",
      names: Object.fromEntries(top),
      count: (old?.count ?? 0) + t.count,
      signals,
      subjects,
      first_at: first && Number.isFinite(first) ? new Date(first).toISOString() : null,
      last_at: last ? new Date(last).toISOString() : null,
    };
  });
  await pool.query(
    `insert into migrate_services (mailbox_id, domain, name, names, count, signals, subjects, first_at, last_at)
     select $1, x.domain, x.name, x.names, x.count, x.signals, x.subjects, x.first_at, x.last_at
     from jsonb_to_recordset($2::jsonb) as x(domain text, name text, names jsonb, count integer, signals jsonb, subjects jsonb, first_at timestamptz, last_at timestamptz)
     on conflict (mailbox_id, domain) do update set
       name = excluded.name, names = excluded.names, count = excluded.count, signals = excluded.signals,
       subjects = excluded.subjects, first_at = excluded.first_at, last_at = excluded.last_at, updated_at = now()`,
    [mailboxId, JSON.stringify(rows)],
  );
}

/**
 * 読む速さ。Gmail API は 1 人あたり 1 分に 6,000 単位まで使え、1 通のヘッダを読むと 20 単位、一覧を取ると 5 単位を使う。
 * 1 秒に 4 通（1 分に 4,800 単位）にして、上限に余裕を残す
 */
const PER_SECOND = 4;
/** 一覧を 1 回に取る数（読み終えるたびに続きの場所を保存するので、小さいほど止まっても損が少ない） */
const PAGE = 50;

/**
 * メールを調べる。時間のかぎり読み進め、どこまで読んだかを保存して返す。
 * done が false なら、もう一度呼ぶと続きから読む。2 回目以降は、前回より後に届いたメールだけ読む
 */
export async function scan(mailboxId: string, budgetMs: number): Promise<ScanResult> {
  const until = Date.now() + budgetMs;
  const box = await getMailbox(mailboxId);
  const token = await accessToken(box);
  const state: ScanState = { ...box.scan };
  state.startedAt ??= Math.floor(Date.now() / 1000);
  let scanned = box.scanned;
  let read = 0;
  const q = GMAIL_QUERY + (state.after ? ` after:${state.after}` : "");

  for (;;) {
    const list = (await gmail(token, `/messages?${new URLSearchParams({ q, maxResults: String(PAGE), fields: "messages/id,nextPageToken", ...(state.pageToken ? { pageToken: state.pageToken } : {}) })}`)) as {
      messages?: { id: string }[];
      nextPageToken?: string;
    };
    const ids = (list.messages ?? []).map((m) => m.id);
    const headers: Header[] = [];
    for (let i = 0; i < ids.length; i += PER_SECOND) {
      const started = Date.now();
      const got = await Promise.all(ids.slice(i, i + PER_SECOND).map((id) => readHeader(token, id)));
      headers.push(...got.filter((h): h is Header => !!h));
      // 1 秒に PER_SECOND 通を超えないように待つ
      if (i + PER_SECOND < ids.length) await sleep(Math.max(0, 1000 - (Date.now() - started)));
    }
    await merge(box.id, tally(headers, box.email));
    read += ids.length;
    scanned += ids.length;
    const done = !list.nextPageToken;
    // 読み終えたら、次回は今回の開始より後だけ読む（境目の取りこぼしを防ぐため 1 分重ねる）
    const next: ScanState = done ? { after: state.startedAt - 60 } : { ...state, pageToken: list.nextPageToken };
    await (await db()).query("update migrate_mailboxes set scan = $2::jsonb, scanned = $3, last_scan = case when $4 then now() else last_scan end where id = $1", [box.id, JSON.stringify(next), scanned, done]);
    if (done) return { read, done: true, scanned };
    state.pageToken = list.nextPageToken;
    if (Date.now() > until) return { read, done: false, scanned };
  }
}

/** 調べた結果を数え直すために空にする（仕分けの状態・開くページ・メモは残す） */
export async function resetScan(mailboxId: string): Promise<void> {
  const box = await getMailbox(mailboxId);
  const pool = await db();
  await pool.query("update migrate_services set count = 0, names = '{}', signals = '{}', subjects = '[]', first_at = null, last_at = null where mailbox_id = $1", [box.id]);
  await pool.query("update migrate_mailboxes set scan = '{}', scanned = 0, last_scan = null where id = $1", [box.id]);
}
