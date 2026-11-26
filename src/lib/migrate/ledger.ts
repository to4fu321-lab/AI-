import "server-only";
import type { Kind } from "./classify";
import { db, toMailbox, toService, UserError, uuid, type MailboxRow, type ServiceRow } from "./db";
import type { Mailbox, Service, Status } from "./types";

/**
 * 台帳（メールボックスと、登録サービスの一覧）の読み書き。
 * どの関数も、最初に「誰の操作か」（userId）を受け取り、その人のデータだけを扱う。
 * 画面の API からも、あとで作る MCP の入口からも、ここを通す（持ち主で絞る場所を 1 か所にするため）
 */

const STATUSES: Status[] = ["new", "move", "skip", "done"];

/** その人のメールボックスと、サービスの一覧 */
export async function loadLedger(userId: string): Promise<{ mailboxes: Mailbox[]; services: Service[] }> {
  const pool = await db();
  const [boxes, services, kinds] = await Promise.all([
    pool.query<MailboxRow>("select * from migrate_mailboxes where user_id = $1 order by created_at", [userId]),
    pool.query<ServiceRow>("select * from migrate_services where user_id = $1 order by count desc, id", [userId]),
    pool.query<{ mailbox_id: string; kind: Kind; n: number }>("select mailbox_id, kind, count(*)::int as n from migrate_messages where user_id = $1 group by mailbox_id, kind", [userId]),
  ]);
  const byBox = new Map<string, Partial<Record<Kind, number>>>();
  for (const k of kinds.rows) byBox.set(k.mailbox_id, { ...(byBox.get(k.mailbox_id) ?? {}), [k.kind]: k.n });
  return { mailboxes: boxes.rows.map((b) => toMailbox(b, byBox.get(b.id))), services: services.rows.map(toService) };
}

/** サービスの仕分け・開くページ・メモを変える */
export async function updateService(userId: string, serviceId: unknown, patch: { status?: unknown; login_url?: unknown; note?: unknown }): Promise<void> {
  const id = uuid(serviceId);
  const sets: string[] = [];
  const values: unknown[] = [id, userId];
  const set = (column: "status" | "login_url" | "note", value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  if (typeof patch.status === "string") {
    if (!STATUSES.includes(patch.status as Status)) throw new UserError("仕分けの種類が違います");
    set("status", patch.status);
  }
  if (typeof patch.login_url === "string") {
    const url = patch.login_url.slice(0, 500).trim();
    if (url && !isSafeUrl(url)) throw new UserError("開くページは https:// から始まる URL を入れてください");
    set("login_url", url);
  }
  if (typeof patch.note === "string") set("note", patch.note.slice(0, 2000));
  if (!sets.length) return;
  const r = await (await db()).query(`update migrate_services set ${sets.join(", ")}, updated_at = now() where id = $1 and user_id = $2`, values);
  if (!r.rowCount) throw new UserError("サービスが見つかりません");
}

/** https の、ふつうの URL だけを通す（ユーザー名つき・空白や制御文字入りは通さない） */
function isSafeUrl(value: string): boolean {
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password && u.hostname.includes(".");
  } catch {
    return false;
  }
}
