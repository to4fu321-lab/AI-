import "server-only";
import { ImapFlow } from "imapflow";
import { UserError } from "../db";
import { accessToken } from "../gmail";
import { GMAIL_QUERY_ACCOUNT, readRawHeaders } from "../parse";
import type { Batch, Cursor, Header, MailSource } from "./types";

/**
 * IMAP で読む部品。相手側で検索して、当てはまったメールのヘッダだけを、まとめて受け取る。
 *
 * いまは Gmail には使っていない：Gmail を IMAP で読むには「メールの全操作」の権限（https://mail.google.com/）が要り、
 * 読むだけのこのアプリには広すぎるため。Gmail 以外のメール（Outlook など）をつなぐときのための部品。
 * そのときは、つなぐ先・認証・検索の言葉（下の gmraw は Gmail 専用）を、メール会社ごとに足す。
 * - メールボックスは読むだけの開き方（EXAMINE）で開く。既読にもならない
 */

/** 1 回にヘッダを受け取る数 */
const BATCH = 500;
/** つなぐ先。MIGRATE_IMAP_HOST は、手元で偽の IMAP サーバーを使って確かめるときに使う */
const IMAP = process.env.MIGRATE_IMAP_HOST && process.env.NODE_ENV !== "production"
  ? { host: process.env.MIGRATE_IMAP_HOST, port: Number(process.env.MIGRATE_IMAP_PORT || 143), secure: false }
  : { host: "imap.gmail.com", port: 993, secure: true };

/** 続きの場所 */
interface ImapCursor {
  /** メールボックスの番号の世代（変わったら最初から） */
  uidValidity?: string;
  /** この番号まで調べ終えた */
  doneUid?: number;
}

export const imap: MailSource = {
  async open(box, cursor, _ctx) {
    void _ctx;
    const client = new ImapFlow({ ...IMAP, auth: { user: box.email, accessToken: await accessToken(box) }, logger: false });
    await client.connect();
    const all = (await client.list()).find((m) => m.specialUse === "\\All");
    if (!all) {
      await client.logout().catch(() => {});
      throw new UserError("「すべてのメール」が見つかりませんでした");
    }
    const lock = await client.getMailboxLock(all.path, { readOnly: true });
    const mailbox = client.mailbox;
    if (!mailbox) throw new UserError("「すべてのメール」を開けませんでした");
    // 開いた時点の「次の番号」。これより後に届いたメールは、次回の調べで読む
    const uidNext = Number(mailbox.uidNext);
    const uidValidity = String(mailbox.uidValidity);
    const before = cursor as ImapCursor;
    const reset = before.uidValidity !== uidValidity;
    let done = reset ? 0 : Number(before.doneUid ?? 0);
    let uids: number[] | null = null;
    let at = 0;
    let first = true;
    return {
      async next(): Promise<Batch> {
        if (!uids) {
          const found = await client.search({ gmraw: GMAIL_QUERY_ACCOUNT, uid: `${done + 1}:*` }, { uid: true });
          uids = (found || []).filter((u) => u > done && u < uidNext).sort((a, b) => a - b);
        }
        const batch = uids.slice(at, at + BATCH);
        const headers: Header[] = [];
        if (batch.length) {
          for await (const msg of client.fetch(batch.join(","), { uid: true, internalDate: true, headers: ["from", "subject", "delivered-to", "list-unsubscribe", "precedence"] }, { uid: true })) {
            if (!msg.headers) continue;
            headers.push({ id: `${uidValidity}:${msg.uid}`, ...readRawHeaders(msg.headers.toString("utf8")), at: msg.internalDate ? new Date(msg.internalDate).getTime() : 0 });
          }
          done = batch[batch.length - 1];
        }
        at += batch.length;
        const finished = at >= uids.length;
        // 読み終えたら、開いた時点までは全部見たことにする
        if (finished) done = Math.max(done, uidNext - 1);
        const out: Batch = { headers, read: batch.length, cursor: { uidValidity, doneUid: done } as Cursor, remaining: uids.length - at, done: finished, reset: first && reset };
        first = false;
        return out;
      },
      async close() {
        lock.release();
        await client.logout().catch(() => {});
      },
    };
  },
};
