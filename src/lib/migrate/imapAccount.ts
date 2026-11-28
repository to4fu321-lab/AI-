import "server-only";
import { transaction, UserError } from "./db";
import { MAX_MAILBOXES, seal, tokenKeyConfigured } from "./gmail";
import { isPublicHostname } from "./netguard";
import { throttle } from "./oauth";
import { providerFor } from "./providers";
import { connectImap } from "./sources/imap";
import { RetryLater } from "./sources/types";

/**
 * Gmail 以外のメール（Yahoo!メール・OCN など）を、アドレスとパスワードでつなぐ。
 *
 * - つなぐ前に、実際にログインできるかを 1 回だけ確かめる（読むだけ。何も書き換えない）
 * - パスワードは、Gmail の合言葉と同じ方式で暗号化して置く（持ち主とアドレスに結び付ける。ほかの行へ写しても開けない）。
 *   画面にも、記録にも、AI 秘書にも出さない
 * - ログインの試しは回数を絞る（まちがったパスワードを何度も送ると、メール会社の側でアカウントが止められることがある。
 *   このサイトを、パスワードの総当たりの踏み台にもさせない）
 */

const EMAIL = /^[a-z0-9._%+-]{1,64}@([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,})$/;
/** 1 人が 1 時間に試せるログインの回数 */
const TRIES_PER_HOUR = 8;

export async function connectImapAccount(userId: string, input: { email?: unknown; password?: unknown; host?: unknown; login?: unknown }): Promise<{ email: string }> {
  if (!tokenKeyConfigured()) throw new UserError("合言葉を守る鍵（MIGRATE_TOKEN_KEY）が設定されていません", "no-token-key");
  const email = (typeof input.email === "string" ? input.email : "").trim().toLowerCase();
  const password = typeof input.password === "string" ? input.password : "";
  const domain = EMAIL.exec(email)?.[1];
  if (!domain || email.length > 200) throw new UserError("メールアドレスの形を確かめてください");
  // パスワードは、打ちまちがいの空白を勝手に削らない（空白を含むパスワードもある）。長さだけ確かめる
  if (!password || password.length > 256 || /[\r\n\0]/.test(password)) throw new UserError("パスワードを入れてください");

  if (/^(?:gmail|googlemail)\.com$/.test(domain)) throw new UserError("Gmail は、「＋ Gmail をつなぐ」からつないでください（パスワードを預からずに済みます）");
  const provider = providerFor(email);
  if (provider?.blocked) throw new UserError(provider.blocked);
  const customHost = (typeof input.host === "string" ? input.host : "").trim().toLowerCase();
  const host = provider?.host ?? customHost;
  if (!host) throw new UserError("このアドレスのメールサーバーが分かりません。メール会社の案内にある「IMAP サーバー（受信メールサーバー）」の名前を入れてください", "imap-host");
  if (!isPublicHostname(host)) throw new UserError("メールサーバーの名前の形を確かめてください（例：imap.example.jp）", "imap-host");
  // ログインに使う名前。アドレスとは別の ID を使う会社（ドコモメールなど）だけ、利用者に入れてもらう
  const login = (typeof input.login === "string" ? input.login : "").trim();
  if (provider?.user === "ask" && (!login || login.length > 200 || /[\s\0-\x1f\x7f]/.test(login))) throw new UserError(`${provider.userLabel ?? "ログインに使う ID"}を入れてください`);
  const user = provider?.user === "ask" ? login : provider?.user === "local" ? email.split("@")[0] : email;

  if (!(await throttle(`imap-try|${userId}`, TRIES_PER_HOUR, 3600))) throw new UserError("ログインの試しが続いたので、1 時間ほど置いてからにしてください（まちがいが続くと、メール会社の側でアカウントが止められることがあります）");

  // 実際にログインできるかを確かめる（つながったら、すぐ切る）
  let client;
  try {
    client = await connectImap({ host, user, password });
  } catch (err) {
    if (err instanceof RetryLater) throw new UserError("メールサーバーにつながりませんでした。サーバー名を確かめるか、しばらくしてから試してください", "imap-host");
    throw err;
  }
  await client.logout().catch(() => client.close());

  const sealed = seal({ user_id: userId, email }, password);
  const saved = await transaction(async (c) => {
    // 同じ利用者の「数えてから足す」が同時に走らないよう、その利用者の分だけ順番に通す（Gmail をつなぐときと同じ鍵）
    await c.query("select pg_advisory_xact_lock(742002, hashtext($1))", [userId]);
    const mine = await c.query<{ email: string; source: string }>("select email, source from migrate_mailboxes where user_id = $1", [userId]);
    const same = mine.rows.find((r) => r.email === email);
    // 同じアドレスを Gmail としてつないでいるときは、読み方を黙って替えない
    if (same && same.source !== "imap") throw new UserError("このアドレスは、もうつないであります");
    if (!same && mine.rows.length >= MAX_MAILBOXES) return false;
    // つなぎ直したときは、前の止まった理由を消す（記録と続きの場所は残す）
    await c.query(
      `insert into migrate_mailboxes (user_id, email, token_enc, source, imap_host, imap_user, provider) values ($1, $2, $3, 'imap', $4, $5, $6)
       on conflict (user_id, email) do update set token_enc = excluded.token_enc, imap_host = excluded.imap_host, imap_user = excluded.imap_user, provider = excluded.provider, error = ''`,
      [userId, email, sealed, host, user, provider?.id ?? "other"],
    );
    return true;
  });
  if (!saved) throw new UserError(`つなげるメールボックスは ${MAX_MAILBOXES} 件までです`, "too-many");
  return { email };
}
