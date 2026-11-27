import "server-only";
import { createHash } from "node:crypto";
import { ImapFlow } from "imapflow";
import { UserError, type MailboxRow } from "../db";
import { open as openSecret } from "../gmail";
import { resolvePublic } from "../netguard";
import { readRawHeaders } from "../parse";
import { RetryLater, type Batch, type Cursor, type Header, type MailSource } from "./types";

/**
 * Gmail 以外のメール（Yahoo!メール・OCN など）を、IMAP で読む部品。
 *
 * - 受け取るのはヘッダだけ（差出人・件名・日付など）。本文は受け取らない
 * - メールボックスは読むだけの開き方（EXAMINE）で開く。既読にもならず、何も書き換えない
 * - 送信済み・下書き・ごみ箱・迷惑メールのフォルダは読まない（Gmail の読み方と同じ範囲にそろえる）
 * - 新しいメールから順に読む（記録できる通数の上限に当たっても、最近のメールが残るように）
 * - つなぐのは、暗号化された通信（ポート 993）だけ。名前を引いた結果が内側の住所なら、つながない
 *
 * Gmail にはこの部品を使わない：Gmail を IMAP で読むには「メールの全操作」の権限が要り、読むだけのこのアプリには広すぎるため
 */

/** 1 回にヘッダを受け取る数 */
const BATCH = 500;
/** 読むフォルダの数の上限 */
const MAX_FOLDERS = 40;
const TIMEOUT_MS = 20_000;

export const IMAP_RECONNECT = "メールサーバーにログインできませんでした。パスワードが変わったか、メールソフトからの利用（IMAP）が止められています。つなぎ直してください";

/** 手元で偽の IMAP サーバーを使って確かめるときだけ使う、つなぐ先の差し替え（本番では効かない） */
const devOverride = () =>
  process.env.MIGRATE_IMAP_HOST && process.env.NODE_ENV !== "production" ? { host: process.env.MIGRATE_IMAP_HOST, port: Number(process.env.MIGRATE_IMAP_PORT || 143), secure: false } : null;

export interface ImapLogin {
  host: string;
  user: string;
  password: string;
}

/** ログインして、つながった接続を返す。失敗の理由は、利用者に見せてよい形に直す */
export async function connectImap(login: ImapLogin): Promise<ImapFlow> {
  const dev = devOverride();
  let target: { host: string; port: number; secure: boolean; tls?: { servername: string } };
  if (dev) target = dev;
  else {
    // 名前を引いて確かめた住所に、そのままつなぐ（証明書は、もとの名前で確かめる）
    const address = await resolvePublic(login.host);
    if (!address) throw new UserError("メールサーバーの名前を確かめられませんでした。サーバー名を見直してください", "imap-host");
    target = { host: address, port: 993, secure: true, tls: { servername: login.host } };
  }
  const client = new ImapFlow({
    ...target,
    auth: { user: login.user, pass: login.password },
    logger: false,
    // 相手に名乗る名前（メール会社の側の記録で、何からのアクセスかが分かるように）
    clientInfo: { name: "account-migrate" },
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: 120_000,
  });
  // 通信が途中で切れたときに、処理全体を落とさない（次の命令が失敗として返る）
  client.on("error", () => {});
  try {
    await client.connect();
  } catch (err) {
    client.close();
    const e = err as { authenticationFailed?: boolean; code?: string; responseText?: string };
    if (e.authenticationFailed) throw new UserError(IMAP_RECONNECT, "imap-auth");
    if (e.code === "DEPTH_ZERO_SELF_SIGNED_CERT" || e.code === "CERT_HAS_EXPIRED" || e.code === "ERR_TLS_CERT_ALTNAME_INVALID" || e.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || e.code === "SELF_SIGNED_CERT_IN_CHAIN") {
      throw new UserError("メールサーバーの証明書を確かめられませんでした（安全のため、つなぎません）", "imap-cert");
    }
    // つながらない・時間切れは、相手の一時的な不調かもしれない。しばらく置いてやり直せる
    throw new RetryLater("メールサーバーにつながりませんでした");
  }
  return client;
}

/** 保存してあるパスワードを開いて、ログインの材料にする */
export function loginOf(box: Pick<MailboxRow, "token_enc" | "user_id" | "email" | "imap_host" | "imap_user">): ImapLogin {
  const opened = openSecret(box, box.token_enc);
  if (!opened || !box.imap_host || !box.imap_user) throw new UserError(IMAP_RECONNECT, "imap-auth");
  return { host: box.imap_host, user: box.imap_user, password: opened.text };
}

// 読まないフォルダ（送信済み・下書き・ごみ箱・迷惑メール）。印（SPECIAL-USE）が付いていないサーバーでは、名前で見分ける
const SKIP_USE = new Set(["\\Sent", "\\Drafts", "\\Trash", "\\Junk"]);
const SKIP_NAME =
  /^(?:sent|sent items|sent messages|sent mail|drafts?|trash|deleted|deleted items|deleted messages|junk|junk e-?mail|spam|bulk mail|bulk|outbox|templates?|notes|送信済み(?:メール|アイテム|トレイ)?|送信箱|送信(?:ボックス|メール)|下書き|草稿|ごみ箱|ゴミ箱|削除済み(?:アイテム)?|迷惑メール|迷惑メールフォルダ|スパム|テンプレート|メモ)$/i;

interface Folder {
  path: string;
  /** 記録の番号に使う、フォルダの見分け（名前そのものは保存しない） */
  key: string;
}

/** 読むフォルダを選ぶ（受信トレイを先頭に） */
export function pickFolders(list: { path: string; name?: string; specialUse?: string; flags?: Set<string> }[]): Folder[] {
  const out: Folder[] = [];
  for (const f of list) {
    if (f.flags?.has("\\Noselect") || f.flags?.has("\\NonExistent")) continue;
    if (f.specialUse && SKIP_USE.has(f.specialUse)) continue;
    const last = (f.name ?? f.path).trim();
    if (f.path.toUpperCase() !== "INBOX" && SKIP_NAME.test(last)) continue;
    out.push({ path: f.path, key: createHash("sha256").update(f.path).digest("hex").slice(0, 10) });
  }
  out.sort((a, b) => Number(b.path.toUpperCase() === "INBOX") - Number(a.path.toUpperCase() === "INBOX") || a.path.localeCompare(b.path));
  return out.slice(0, MAX_FOLDERS);
}

/** フォルダごとの続きの場所 */
interface FolderCursor {
  /** フォルダの番号の世代（変わったら最初から） */
  v: string;
  /** この番号までは、読み終えた */
  done: number;
  /** いまの回で読む範囲の上の端（始めた時点の、いちばん新しい番号）。なければ、次の回はここから数え始める */
  top?: number;
  /** いまの回で、次に読む番号（新しい方から下がっていく） */
  at?: number;
}
interface ImapCursor {
  folders?: Record<string, FolderCursor>;
}

export const imap: MailSource = {
  async open(box, cursor) {
    const client = await connectImap(loginOf(box));
    let folders: Folder[];
    try {
      folders = pickFolders(await client.list());
    } catch {
      await client.logout().catch(() => {});
      throw new RetryLater("フォルダの一覧を取れませんでした");
    }
    if (!folders.length) {
      await client.logout().catch(() => {});
      throw new UserError("読めるフォルダが見つかりませんでした");
    }
    const state: Record<string, FolderCursor> = { ...((cursor as ImapCursor).folders ?? {}) };
    let index = 0;
    /** いま開いているフォルダの、今回読む番号（新しい順） */
    let pending: { folder: Folder; uids: number[]; uidValidity: string; release: () => void } | null = null;
    let reset = false;

    /** 次に読むフォルダを開く。読むものがないフォルダは飛ばす。全部終わったら null */
    const advance = async (): Promise<typeof pending> => {
      while (index < folders.length) {
        const folder = folders[index];
        let lock;
        try {
          lock = await client.getMailboxLock(folder.path, { readOnly: true });
        } catch {
          // 開けないフォルダ（消された・権限がない）は、飛ばして先へ進む
          index++;
          continue;
        }
        const mailbox = client.mailbox;
        if (!mailbox) {
          lock.release();
          index++;
          continue;
        }
        const uidValidity = String(mailbox.uidValidity);
        let cur: FolderCursor | undefined = state[folder.key];
        // 相手側で番号が振り直された。どれが同じメールか分からなくなるので、このメールボックスを最初から数え直す
        if (cur && cur.v !== uidValidity) {
          for (const k of Object.keys(state)) delete state[k];
          reset = true;
          cur = undefined;
        }
        const top = cur?.top ?? Number(mailbox.uidNext) - 1;
        const done = cur?.done ?? 0;
        const at = Math.min(cur?.at ?? top, top);
        let uids: number[] = [];
        if (at > done) {
          const found = await client.search({ uid: `${done + 1}:${at}` }, { uid: true });
          uids = (found || []).filter((u) => u > done && u <= at).sort((a, b) => b - a);
        }
        state[folder.key] = { v: uidValidity, done, top, at };
        if (uids.length) return { folder, uids, uidValidity, release: () => lock.release() };
        // このフォルダは読み終えた
        state[folder.key] = { v: uidValidity, done: Math.max(done, top) };
        lock.release();
        index++;
      }
      return null;
    };

    return {
      async next(): Promise<Batch> {
        try {
          pending ??= await advance();
          const wasReset = reset;
          reset = false;
          if (!pending) return { headers: [], read: 0, cursor: { folders: state } as Cursor, remaining: 0, done: true, reset: wasReset };
          const { folder, uidValidity } = pending;
          const batch = pending.uids.splice(0, BATCH);
          const headers: Header[] = [];
          for await (const msg of client.fetch(batch.join(","), { uid: true, internalDate: true, headers: ["from", "subject", "delivered-to", "list-unsubscribe", "precedence"] }, { uid: true })) {
            if (!msg.headers) continue;
            headers.push({ id: `${folder.key}:${uidValidity}:${msg.uid}`, ...readRawHeaders(msg.headers.toString("utf8")), at: msg.internalDate ? new Date(msg.internalDate).getTime() : 0 });
          }
          const cur = state[folder.key];
          const remaining = pending.uids.length;
          if (remaining) state[folder.key] = { ...cur, at: batch[batch.length - 1] - 1 };
          else {
            // このフォルダの今回の範囲を読み終えた。次の回は、これより後に届いた分だけ読む
            state[folder.key] = { v: uidValidity, done: Math.max(cur.done, cur.top ?? cur.done) };
            pending.release();
            pending = null;
            index++;
          }
          const done = !pending && index >= folders.length;
          // 残りは、いま読んでいるフォルダの分だけ分かる（ほかのフォルダは、開くまで分からない）
          return { headers, read: batch.length, cursor: { folders: state } as Cursor, remaining: done ? 0 : remaining || null, done, reset: wasReset };
        } catch (err) {
          if (err instanceof UserError || err instanceof RetryLater) throw err;
          // 途中で通信が切れた・相手が混み合っているときは、しばらく置いて、続きからやり直す
          throw new RetryLater("メールサーバーとの通信が途切れました");
        }
      },
      async close() {
        pending?.release();
        await client.logout().catch(() => client.close());
      },
    };
  },
};
