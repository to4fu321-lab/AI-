/** アカウント引っ越し：画面とサーバーの両方で使う型 */

export type Status = "new" | "move" | "skip" | "done";
export type Signal = "signup" | "password" | "security" | "billing";

export const STATUS_LABEL: Record<Status, string> = { new: "未仕分け", move: "移行する", skip: "不要", done: "完了" };
export const SIGNAL_LABEL: Record<Signal, string> = { signup: "登録・確認", password: "パスワード", security: "ログイン通知", billing: "支払い・注文" };

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
}

export interface Service {
  id: string;
  mailbox_id: string;
  domain: string;
  name: string;
  count: number;
  signals: Partial<Record<Signal, number>>;
  subjects: string[];
  first_at: string | null;
  last_at: string | null;
  status: Status;
  login_url: string;
  note: string;
}

export interface AppState {
  setup: { db: boolean; google: boolean };
  mailboxes: Mailbox[];
  services: Service[];
}
