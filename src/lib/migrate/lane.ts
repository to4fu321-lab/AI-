import type { Kind } from "./classify";
import type { Judgment } from "./judge";

/**
 * サービスごとの「おすすめの扱い」。利用者が 1 件ずつ考えなくて済むように、先に 4 つに仕分けておく。
 * 材料は、頼り具合の判定（judge.ts）と、種類ごとの通数だけ。通信もデータベースも使わない。
 *
 * - move  … 移す（今も使っていて、このアドレスに頼っている）
 * - stop  … 配信を止める（広告だけが届いている）
 * - quit  … 使っていない（登録した跡はあるが、最近は使った様子がない）
 * - leave … そのままでよい（登録の跡がない・届いた数が少なくて判断できない）
 */
export type Lane = "move" | "stop" | "quit" | "leave";

export const LANES: Lane[] = ["move", "stop", "quit", "leave"];
export const LANE_LABEL: Record<Lane, string> = { move: "新しいアドレスに移す", stop: "配信を止める", quit: "使っていない", leave: "そのままでよい" };

/** 登録していることを示す種類（これが 1 通でもあれば、アカウントがあると見る） */
const ACCOUNT_KINDS: Kind[] = ["auth", "security", "password", "signup", "billing"];

export function laneOf(judgment: Judgment, signals: Partial<Record<Kind, number>>): Lane {
  if (judgment.level === "depends") return "move";
  if (judgment.level === "ads") return "stop";
  // 届いた数が少ない差出人は、なりすましかもしれない。「移す」「やめる」を勧めない
  if (judgment.unproven) return "leave";
  return ACCOUNT_KINDS.some((k) => (signals[k] ?? 0) > 0) ? "quit" : "leave";
}
