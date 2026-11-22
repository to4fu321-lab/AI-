import "server-only";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * 暗号化まわり。鍵のもとは環境変数 AUTOPOST_SECRET（Vercel にだけ置く。データベースには入れない）。
 * - 投稿先のログイン情報：AES-256-GCM で暗号化してから保存する。データベースだけ盗まれても読めない
 * - 会員のパスワード：scrypt でハッシュにする（元には戻せない）
 * - 会員の通行証（Cookie）：HMAC で署名する
 */

export function hasSecret(): boolean {
  return (process.env.AUTOPOST_SECRET ?? "").length >= 16;
}

function masterKey(purpose: string): Buffer {
  const secret = process.env.AUTOPOST_SECRET ?? "";
  if (secret.length < 16) throw new Error("AUTOPOST_SECRET（16 文字以上）が設定されていません");
  return createHash("sha256").update(`${purpose}:${secret}`).digest();
}

export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey("cred"), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

export function decryptJson<T>(text: string): T | null {
  if (!text) return null;
  const [version, iv, tag, data] = text.split(".");
  if (version !== "v1" || !iv || !tag || !data) throw new Error("保存されたログイン情報の形式が違います");
  try {
    const decipher = createDecipheriv("aes-256-gcm", masterKey("cred"), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8")) as T;
  } catch {
    throw new Error("ログイン情報を復号できません（AUTOPOST_SECRET を変えた場合は、投稿先の鍵を入れ直してください）");
  }
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `scrypt.${salt.toString("base64url")}.${scryptSync(password, salt, 32).toString("base64url")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split(".");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = scryptSync(password, Buffer.from(salt, "base64url"), expected.length);
  return timingSafeEqual(expected, actual);
}

/** 署名（会員の通行証・OAuth の state 用） */
export function sign(message: string): string {
  return createHmac("sha256", masterKey("sign")).update(message).digest("base64url");
}

export function verifySigned(message: string, signature: string): boolean {
  const a = Buffer.from(sign(message));
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
