import type { MailboxRow } from "../db";

/**
 * メールの読み方の部品（メール会社ごとに差し替える）。
 * どの部品も「続きの場所から、ひとかたまり読んで返す」だけを受け持つ。
 * 数える・保存する・時間で区切る・二重に動かさない、は scan.ts がまとめて受け持つ。
 */

/** メール 1 通ぶんの材料（ヘッダだけ。本文は受け取らない） */
export interface Header {
  /** メール会社がそのメールに付けた番号（同じメールを二重に記録しないため） */
  id: string;
  from: string;
  /** 宛先（Delivered-To、なければ To）。転送されてきた古いアドレスを見分ける材料 */
  to?: string;
  subject: string;
  /** 届いた時刻（ミリ秒） */
  at: number;
  /** メール会社が付けた分類（Gmail の CATEGORY_PROMOTIONS など）。なければ空 */
  labels?: string[];
  /** List-Unsubscribe ヘッダがある（一斉配信の印） */
  listUnsubscribe?: boolean;
  /** Precedence ヘッダの値（bulk・list なら一斉配信） */
  precedence?: string;
}

/** 続きの場所。中身は部品ごとに違う（データベースにそのまま保存する） */
export type Cursor = Record<string, unknown>;

export interface Batch {
  headers: Header[];
  /** このかたまりで読んだ通数 */
  read: number;
  /** ここまで読んだあとの、続きの場所 */
  cursor: Cursor;
  /** 残りの通数（分からなければ null） */
  remaining: number | null;
  /** 全部読み終えたか */
  done: boolean;
  /** 相手側で番号が振り直されたなどで、最初から数え直すとき true */
  reset?: boolean;
}

export interface MailSession {
  next(): Promise<Batch>;
  close(): Promise<void>;
}

export interface MailSource {
  open(box: MailboxRow, cursor: Cursor): Promise<MailSession>;
}

/** 相手が混み合っている・上限に当たった。しばらくしてから続きをやり直せばよい */
export class RetryLater extends Error {}
