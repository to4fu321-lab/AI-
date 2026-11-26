/** アカウント引っ越し：画面とサーバーの両方で使う型 */
import type { Kind } from "./classify";
import type { Judgment } from "./judge";

export type Status = "new" | "move" | "skip" | "done";

export const STATUS_LABEL: Record<Status, string> = { new: "未仕分け", move: "移行する", skip: "不要", done: "完了" };
export const KIND_LABEL: Record<Kind, string> = { auth: "認証コード", security: "ログイン通知", password: "パスワード再設定", signup: "登録・確認", billing: "支払い・注文", notice: "お知らせ", promo: "広告" };

export interface Mailbox {
  id: string;
  email: string;
  scanned: number;
  /** 調べている途中（サーバーが進めている。画面を閉じても続く） */
  scanning: boolean;
  /** 今回の調べで、残りの通数（数え始める前は 0） */
  remaining: number;
  last_scan: string | null;
  /** 前回の調べが止まった理由（なければ空） */
  error: string;
  /** 記録したメールの、種類ごとの通数（必要なメールと広告の内訳） */
  kinds: Partial<Record<Kind, number>>;
}

export interface Service {
  id: string;
  mailbox_id: string;
  domain: string;
  name: string;
  count: number;
  signals: Partial<Record<Kind, number>>;
  /** 種類ごとの、最後に届いた日 */
  signal_last: Partial<Record<Kind, string>>;
  /** このアドレスにどれくらい頼っているかの判定 */
  judgment: Judgment;
  subjects: string[];
  first_at: string | null;
  last_at: string | null;
  status: Status;
  login_url: string;
  note: string;
}

export interface AppState {
  /** 設定の状態。tokenKey は、合言葉の暗号化に専用の鍵（MIGRATE_TOKEN_KEY）を使っているか */
  setup: { db: boolean; google: boolean; tokenKey: boolean };
  /** ログインしている利用者（していなければ null。そのときは一覧も空） */
  user: { email: string; name: string } | null;
  mailboxes: Mailbox[];
  services: Service[];
}
