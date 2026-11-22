import { APPS, type AppEntry } from "@/data/apps";

/**
 * パスワードの「鍵」の仕組み。
 *
 * 鍵（lock）は 3 種類：
 *   "ezoshirube"   … エゾシルベ用アプリ全部をまとめて開ける
 *   "private"      … 自分専用。これを持っていればすべての鍵が開く（管理者用の合鍵）
 *   "app:<slug>"   … 販売用アプリ 1 個だけを開ける
 *
 * パスワードは Vercel の環境変数に置き、コードには書かない。
 * 正しいパスワードを入れると、署名付きの Cookie（通行証）を渡す。
 * 署名の鍵にはそのパスワード自体を使うので、パスワードを変えると古い通行証はすべて無効になる。
 */

export type LockKey = "ezoshirube" | "private" | `app:${string}`;

export const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 日

export function lockOfApp(app: AppEntry): LockKey | null {
  if (app.access === "public") return null;
  if (app.access === "sale") return `app:${app.slug}`;
  return app.access;
}

export function isLockKey(value: string): value is LockKey {
  if (value === "ezoshirube" || value === "private") return true;
  const m = /^app:([a-z0-9-]+)$/.exec(value);
  return !!m && APPS.some((a) => a.slug === m[1] && a.access === "sale");
}

/** その URL を守っている鍵（守られていなければ null） */
export function lockForPath(pathname: string): { key: LockKey; app: AppEntry } | null {
  for (const app of APPS) {
    const key = lockOfApp(app);
    if (!key) continue;
    for (const p of app.paths ?? []) {
      if (pathname === p || pathname.startsWith(`${p}/`)) return { key, app };
    }
  }
  return null;
}

export function lockLabel(key: LockKey): string {
  if (key === "ezoshirube") return "エゾシルベ メンバー専用";
  if (key === "private") return "管理者（自分専用）";
  const app = APPS.find((a) => `app:${a.slug}` === key);
  return app ? `「${app.name}」購入者専用` : "購入者専用";
}

export function passwordEnvName(key: LockKey): string {
  if (key === "ezoshirube") return "PASSWORD_EZOSHIRUBE";
  if (key === "private") return "PASSWORD_PRIVATE";
  return `PASSWORD_APP_${key.slice(4).toUpperCase().replace(/-/g, "_")}`;
}

export function passwordFor(key: LockKey): string | null {
  const v = process.env[passwordEnvName(key)];
  return v && v.length > 0 ? v : null;
}

export function cookieName(key: LockKey): string {
  return `lk_${key.replace(":", "_")}`;
}

// --- 署名（HMAC-SHA256）。Web Crypto を使うので proxy でもサーバーでも動く ---

const enc = new TextEncoder();

function toBase64Url(bytes: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toBase64Url(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

/** 長さに関係なく一定時間で比べる（文字列比較の速さからパスワードを推測されないように） */
export function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function issueToken(key: LockKey): Promise<string | null> {
  const password = passwordFor(key);
  if (!password) return null;
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS;
  return `${exp}.${await hmac(password, `${key}|${exp}`)}`;
}

async function verifyToken(key: LockKey, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const password = passwordFor(key);
  if (!password) return false;
  const [expText, sig] = token.split(".");
  const exp = Number(expText);
  if (!sig || !Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  return safeEqual(sig, await hmac(password, `${key}|${exp}`));
}

type CookieReader = { get(name: string): { value: string } | undefined };

/** この鍵が開いているか（自分専用の合鍵を持っていれば何でも開く） */
export async function hasAccess(cookies: CookieReader, key: LockKey): Promise<boolean> {
  if (await verifyToken(key, cookies.get(cookieName(key))?.value)) return true;
  if (key !== "private") return verifyToken("private", cookies.get(cookieName("private"))?.value);
  return false;
}

/** 戻り先 URL の検査（外部サイトへ飛ばされないように、このサイト内のパスだけ許す） */
export function safeNext(value: unknown, fallback = "/apps"): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  return value;
}

/**
 * API の中で使う二重チェック。門番（proxy）の設定ミスがあっても、ここで止める。
 * 通れないときは 401 の Response を返す（通れるときは null）。
 */
export async function guardApi(request: Request, pathname: string): Promise<Response | null> {
  const lock = lockForPath(pathname);
  if (!lock) return null;
  const header = request.headers.get("cookie") ?? "";
  const jar = new Map(
    header.split(/;\s*/).filter(Boolean).map((c) => {
      const i = c.indexOf("=");
      return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))] as const;
    }),
  );
  const reader = { get: (name: string) => (jar.has(name) ? { value: jar.get(name)! } : undefined) };
  if (await hasAccess(reader, lock.key)) return null;
  return Response.json({ error: "パスワードが必要です" }, { status: 401 });
}
