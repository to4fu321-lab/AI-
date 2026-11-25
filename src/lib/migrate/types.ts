/** アカウント引っ越し：画面とサーバーの両方で使う型 */

export type Status = "new" | "move" | "skip" | "done";
export type Signal = "signup" | "password" | "security" | "billing";

export const STATUS_LABEL: Record<Status, string> = { new: "未仕分け", move: "移行する", skip: "不要", done: "完了" };
export const SIGNAL_LABEL: Record<Signal, string> = { signup: "登録・確認", password: "パスワード", security: "ログイン通知", billing: "支払い・注文" };

export interface Mailbox {
  id: string;
  email: string;
  scanned: number;
  /** 調べている途中（続きがある） */
  scanning: boolean;
  last_scan: string | null;
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

export interface ScanResult {
  /** この回に読んだメールの数 */
  read: number;
  /** 全部読み終えたか（false なら、もう一度呼ぶと続きから読む） */
  done: boolean;
  scanned: number;
}
