import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { db } from "./db";
import { thumbsLog } from "./safeFetch";

/**
 * 「復活したら保存」の保存先としての Google ドライブ。
 *
 * - つなぎ方：画面の「Google ドライブとつなぐ」→ Google の許可画面 → 戻ってきたら、ドライブを使う合言葉（リフレッシュトークン）を
 *   暗号化してデータベースに保存する
 * - 権限は drive.file（このアプリが作ったファイルだけ）。ドライブのほかのファイルは見えない・さわれない
 * - 保存先は、つないだときに作るフォルダ「サムネ収集（復活保存）」
 * 使うには、Vercel の環境変数 GOOGLE_DRIVE_CLIENT_ID・GOOGLE_DRIVE_CLIENT_SECRET（Google Cloud の OAuth クライアント）が要る
 */

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const FOLDER_NAME = "サムネ収集（復活保存）";
/** 一度に送る大きさ（256KB の倍数でないといけない） */
const CHUNK = 8 * 1024 * 1024;

const clientId = () => process.env.GOOGLE_DRIVE_CLIENT_ID?.trim() || "";
const clientSecret = () => process.env.GOOGLE_DRIVE_CLIENT_SECRET?.trim() || "";

/** Google Cloud の OAuth クライアントが設定されているか */
export function driveConfigured(): boolean {
  return !!clientId() && !!clientSecret();
}

/** 戻り先（Google Cloud の「承認済みのリダイレクト URI」に登録するもの） */
export function redirectUri(origin: string): string {
  return `${origin}/api/thumbs/drive/callback`;
}

export function authUrl(origin: string, state: string): string {
  const p = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(origin),
    response_type: "code",
    scope: DRIVE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

// --- 合言葉の暗号化（データベースに平文で置かない。鍵はクライアントシークレットから作る） ---

const key = () => createHash("sha256").update(`thumbs-drive:${clientSecret()}`).digest();

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

interface DriveState {
  refresh: string;
  folderId: string;
  email?: string;
}

async function loadState(): Promise<DriveState | null> {
  if (!driveConfigured()) return null;
  const pool = await db().catch(() => null);
  if (!pool) return null;
  const r = await pool.query<{ value: { sealed?: string; folderId?: string; email?: string } }>("select value from thumbs_patrol_meta where key = 'drive'");
  const v = r.rows[0]?.value;
  const refresh = v?.sealed ? open(v.sealed) : null;
  return refresh && v?.folderId ? { refresh, folderId: v.folderId, email: v.email } : null;
}

/** つながっているか（つながっていれば、保存先のフォルダとアカウント） */
export async function driveStatus(): Promise<{ configured: boolean; connected: boolean; email?: string; folderId?: string }> {
  const s = await loadState().catch(() => null);
  return { configured: driveConfigured(), connected: !!s, email: s?.email, folderId: s?.folderId };
}

let cachedToken: { token: string; until: number; refresh: string } | null = null;

async function accessToken(refresh: string): Promise<string> {
  if (cachedToken && cachedToken.refresh === refresh && cachedToken.until > Date.now() + 60000) return cachedToken.token;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), refresh_token: refresh, grant_type: "refresh_token" }),
    signal: AbortSignal.timeout(15000),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(json.error === "invalid_grant" ? "Google ドライブとのつながりが切れました。もう一度つないでください" : `Google の認証に失敗しました（${json.error ?? res.status}）`);
  }
  cachedToken = { token: json.access_token, until: Date.now() + (json.expires_in ?? 3600) * 1000, refresh };
  return json.access_token;
}

/** Google から戻ってきた code を合言葉に換え、保存先のフォルダを作って、データベースに保存する */
export async function finishConnect(code: string, origin: string): Promise<{ email?: string }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId(), client_secret: clientSecret(), redirect_uri: redirectUri(origin), grant_type: "authorization_code" }),
    signal: AbortSignal.timeout(15000),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) throw new Error(`Google の許可を受け取れませんでした（${json.error_description ?? json.error ?? res.status}）`);
  if (!json.refresh_token) throw new Error("Google から長く使える合言葉が届きませんでした。もう一度つないでください");
  const auth = { authorization: `Bearer ${json.access_token}` };
  // つないだアカウント（表示用）
  const about = (await fetch("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)", { headers: auth }).then((r) => r.json()).catch(() => ({}))) as {
    user?: { emailAddress?: string };
  };
  // 保存先のフォルダ（drive.file では、このアプリが作ったものしか見えないので、毎回作ってよい）
  const folderRes = await fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST",
    headers: { ...auth, "content-type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }),
  });
  const folder = (await folderRes.json().catch(() => ({}))) as { id?: string };
  if (!folder.id) throw new Error(`Google ドライブにフォルダを作れませんでした（HTTP ${folderRes.status}）`);
  const pool = await db();
  if (!pool) throw new Error("データベースが設定されていません");
  await pool.query(
    "insert into thumbs_patrol_meta (key, value) values ('drive', $1) on conflict (key) do update set value = excluded.value",
    [JSON.stringify({ sealed: seal(json.refresh_token), folderId: folder.id, email: about.user?.emailAddress })],
  );
  cachedToken = null;
  return { email: about.user?.emailAddress };
}

/** つながりを切る（Google 側の許可も取り消す。保存した動画はドライブに残る） */
export async function disconnect(): Promise<void> {
  const s = await loadState().catch(() => null);
  if (s) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(s.refresh)}`, { method: "POST" }).catch(() => {});
  const pool = await db();
  await pool?.query("delete from thumbs_patrol_meta where key = 'drive'");
  cachedToken = null;
}

/** ドライブがつながっていれば、その情報（保存に使う） */
export async function driveTarget(): Promise<{ refresh: string; folderId: string } | null> {
  return loadState().catch(() => null);
}

/**
 * 流れてくる動画を、ドライブに少しずつ送って保存する（再開できるアップロード）。
 * ファイルの番号を返す
 */
export async function uploadToDrive(
  target: { refresh: string; folderId: string },
  name: string,
  type: string,
  body: ReadableStream<Uint8Array>,
  total: number | undefined,
  signal: AbortSignal,
): Promise<{ id: string; size: number }> {
  const token = await accessToken(target.refresh);
  const start = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,size", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=UTF-8",
      "x-upload-content-type": type,
      ...(total ? { "x-upload-content-length": String(total) } : {}),
    },
    body: JSON.stringify({ name, parents: [target.folderId] }),
    signal,
  });
  const session = start.headers.get("location");
  if (!start.ok || !session) throw new Error(`Google ドライブが保存を受け付けませんでした（HTTP ${start.status}）`);

  const reader = body.getReader();
  let buffered: Uint8Array[] = [];
  let bufferedSize = 0;
  let sent = 0;
  let ended = false;
  for (;;) {
    // CHUNK より多くたまるか、最後まで読むまで集める（ちょうどで止めないので、最後に空の送信が残らない）
    while (!ended && bufferedSize <= CHUNK) {
      const { done, value } = await reader.read();
      if (done) ended = true;
      else {
        buffered.push(value);
        bufferedSize += value.byteLength;
      }
    }
    // 送る分（最後でなければ CHUNK ちょうど。残りは次へ回す）
    const all = new Uint8Array(bufferedSize);
    let at = 0;
    for (const b of buffered) {
      all.set(b, at);
      at += b.byteLength;
    }
    const size = ended ? all.byteLength : CHUNK;
    const piece = all.subarray(0, size);
    const rest = all.subarray(size);
    buffered = rest.byteLength ? [rest] : [];
    bufferedSize = rest.byteLength;
    const last = ended && bufferedSize === 0;
    const range =
      piece.byteLength === 0
        ? `bytes */${sent}`
        : `bytes ${sent}-${sent + piece.byteLength - 1}/${last ? sent + piece.byteLength : "*"}`;
    const res = await fetch(session, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-range": range }, body: piece, signal });
    if (res.status === 308) {
      sent += piece.byteLength;
      if (last) throw new Error("Google ドライブへの保存が終わりませんでした");
      continue;
    }
    if (res.ok) {
      const file = (await res.json().catch(() => ({}))) as { id?: string; size?: string };
      if (!file.id) throw new Error("Google ドライブへの保存の返事が読めませんでした");
      thumbsLog(`drive saved ${file.id} ${file.size ?? sent + piece.byteLength} bytes`);
      return { id: file.id, size: Number(file.size ?? sent + piece.byteLength) };
    }
    await reader.cancel().catch(() => {});
    throw new Error(`Google ドライブへの保存に失敗しました（HTTP ${res.status}）`);
  }
}

/** ドライブに保存した動画を読む（Range 対応） */
export async function readFromDrive(fileId: string, range: string | null): Promise<Response> {
  const s = await loadState();
  if (!s) throw new Error("Google ドライブがつながっていません");
  const token = await accessToken(s.refresh);
  return fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {
    headers: { authorization: `Bearer ${token}`, ...(range ? { range } : {}) },
  });
}

/** ドライブに保存した動画を消す */
export async function deleteFromDrive(fileId: string): Promise<void> {
  const s = await loadState();
  if (!s) return;
  const token = await accessToken(s.refresh);
  await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } }).catch(() => {});
}
