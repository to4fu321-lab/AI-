import "server-only";
import { db, toService, UserError, uuid, type MailboxRow, type ServiceRow } from "./db";
import { accessToken } from "./gmail";
import { isPublicHostname, postPublicForm } from "./netguard";
import { messageHeaders } from "./sources/gmailApi";

/**
 * 広告メールの配信を、まとめて止める。
 *
 * 多くの配信メールには「ワンクリックで配信停止」の仕組み（RFC 8058）が付いている：
 * メールのヘッダに書かれた URL へ、決まった 1 行を送るだけで止まる。ログインも、ページを開くことも要らない。
 * こちらのサーバーが、利用者のかわりにそれを送る。
 *
 * - 止めるのは、「広告だけ」と判定したサービスに限る（必要なメールまで止めないように）
 * - 送り先はメールに書かれていた URL なので、差出人の署名（DKIM）が確かめられたメールのものだけ使い、内側の住所へは送らない
 * - ワンクリックに対応していない差出人は、利用者が自分で開いて止めるためのページ（あれば）を残す
 * - メールの本文は読まない（ヘッダだけ）
 */

/** 1 回の操作で止める数の上限（Gmail を読む量を、1 回で使いすぎないように） */
export const UNSUB_BATCH = 40;
const PARALLEL = 4;

type Outcome = { state: "done" | "manual"; url: string };

/** List-Unsubscribe ヘッダから、https の URL を取り出す（<...> で囲まれて、カンマで並んでいる） */
export function unsubscribeUrls(values: string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    for (const m of v.matchAll(/<\s*([^<>\s]+)\s*>/g)) {
      try {
        const u = new URL(m[1]);
        // 利用者に見せるのも、こちらが送るのも、外の https の、ふつうの URL だけ
        if (u.protocol === "https:" && !u.port && !u.username && !u.password && isPublicHostname(u.hostname) && m[1].length <= 2000) out.push(u.toString());
      } catch {
        // URL でないものは飛ばす
      }
    }
  }
  return out;
}

async function stopOne(token: string, messageIds: string[]): Promise<Outcome> {
  let manual = "";
  for (const id of messageIds) {
    const h = await messageHeaders(token, id, ["List-Unsubscribe", "List-Unsubscribe-Post", "Authentication-Results"]).catch(() => null);
    if (!h) continue;
    const urls = unsubscribeUrls(h["list-unsubscribe"] ?? []);
    if (!urls.length) continue;
    manual ||= urls[0];
    const oneClick = (h["list-unsubscribe-post"] ?? []).some((v) => v.trim().toLowerCase() === "list-unsubscribe=one-click");
    // Gmail が受け取ったときに書いた確かめの結果（いちばん上の 1 行）だけを信じる。差出人が自分で書いた行は見ない
    const verdict = (h["authentication-results"] ?? [])[0] ?? "";
    const signed = /^mx\.google\.com;/i.test(verdict.trim()) && /\bdkim=pass\b/i.test(verdict);
    if (!oneClick || !signed) continue;
    // 送るのは 1 回だけ。断られたら、ほかのメールの URL でやり直さない（同じ相手に、何度も送らない）
    if (await postPublicForm(urls[0], "List-Unsubscribe=One-Click")) return { state: "done", url: "" };
    break;
  }
  return { state: "manual", url: manual };
}

export interface StopResult {
  /** こちらで止めた数 */
  stopped: number;
  /** 自分で止める必要がある数 */
  manual: number;
  /** まだ試していない、止められる候補の数（1 回の上限を超えた分） */
  remaining: number;
}

/** その人の「広告だけ」のサービスの配信を、まとめて止める。except は、止めないもの（利用者が外したもの） */
export async function stopAds(userId: string, exceptInput: unknown): Promise<StopResult> {
  const except = new Set(Array.isArray(exceptInput) ? exceptInput.slice(0, 500).map((x) => uuid(x)) : []);
  const pool = await db();
  const [services, boxes] = await Promise.all([
    pool.query<ServiceRow>("select * from migrate_services where user_id = $1 and unsub_at is null and status = 'new' and count > 0 order by count desc, id", [userId]),
    pool.query<MailboxRow>("select * from migrate_mailboxes where user_id = $1", [userId]),
  ]);
  // 止めてよいのは、いまの判定で「広告だけ」のもの（判定はサーバーでやり直す。画面から届いた分類は信じない）
  const targets = services.rows.filter((s) => toService(s).lane === "stop" && !except.has(s.id));
  if (!targets.length) throw new UserError("止められる配信が、見つかりませんでした");
  const batch = targets.slice(0, UNSUB_BATCH);
  const boxById = new Map(boxes.rows.map((b) => [b.id, b]));
  const tokens = new Map<string, Promise<string | null>>();
  const tokenOf = (box: MailboxRow) => {
    if (!tokens.has(box.id)) tokens.set(box.id, box.source === "gmail-api" ? accessToken(box).catch(() => null) : Promise.resolve(null));
    return tokens.get(box.id)!;
  };

  let stopped = 0;
  let manual = 0;
  let next = 0;
  const worker = async () => {
    for (;;) {
      const s = batch[next++];
      if (!s) return;
      const box = boxById.get(s.mailbox_id);
      const token = box ? await tokenOf(box) : null;
      let outcome: Outcome = { state: "manual", url: "" };
      if (token) {
        // 配信停止の印が付いた、新しいメールから 2 通まで見る
        const ids = await pool.query<{ provider_msg_id: string }>("select provider_msg_id from migrate_messages where mailbox_id = $1 and domain = $2 and has_unsubscribe order by at desc limit 2", [s.mailbox_id, s.domain]);
        outcome = await stopOne(token, ids.rows.map((r) => r.provider_msg_id)).catch(() => outcome);
      }
      await pool.query("update migrate_services set unsub_at = now(), unsub_state = $3, unsub_url = $4, updated_at = now() where id = $1 and user_id = $2", [s.id, userId, outcome.state, outcome.url]);
      if (outcome.state === "done") stopped++;
      else manual++;
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  return { stopped, manual, remaining: targets.length - batch.length };
}

/** 「使っていない」と判定したサービスを、まとめて「移さない」にする。except は、外したもの */
export async function skipUnused(userId: string, exceptInput: unknown): Promise<{ skipped: number }> {
  const except = new Set(Array.isArray(exceptInput) ? exceptInput.slice(0, 500).map((x) => uuid(x)) : []);
  const pool = await db();
  const services = await pool.query<ServiceRow>("select * from migrate_services where user_id = $1 and status = 'new' and count > 0", [userId]);
  const ids = services.rows.filter((s) => toService(s).lane === "quit" && !except.has(s.id)).map((s) => s.id);
  if (!ids.length) return { skipped: 0 };
  const r = await pool.query("update migrate_services set status = 'skip', status_at = now(), updated_at = now() where user_id = $1 and id = any($2) and status = 'new'", [userId, ids]);
  return { skipped: r.rowCount ?? 0 };
}
