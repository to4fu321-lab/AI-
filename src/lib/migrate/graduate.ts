import type { Kind } from "./classify";
import type { Service } from "./types";

/**
 * 「このアドレスを、やめて大丈夫か」の判定。通信もデータベースも使わない。
 *
 * やめて大丈夫と言えるのは、次の 3 つがそろったとき：
 * 1. 頼っている（かもしれない）サービスを、全部「変更できた」か「不要」に仕分けた
 * 2. 「変更できた」にしたサービスから、そのあと重要なメールが届いていない
 * 3. 重要なメール（ログイン・登録・支払い）が、しばらく（QUIET_DAYS 日）届いていない
 * 3 は、仕分けもれ（一覧に出ていない所で、このアドレスが使われている）を拾うための待ち時間
 */
export const QUIET_DAYS = 90;

/** 届くと「まだこのアドレスが使われている」と言える種類（広告と、ただのお知らせは数えない） */
export const NEEDED_KINDS: Kind[] = ["auth", "security", "password", "signup", "billing"];

export interface Graduation {
  /** 一度は最後まで調べたか（調べる前は、何も言えない） */
  scanned: boolean;
  /** まだ仕分けていない・移している途中の、頼っている（かもしれない）サービスの数 */
  todo: number;
  /** 「変更できた」にしたのに、そのあとも重要なメールが届いているサービスの数 */
  leaking: number;
  /** 重要なメールが最後に届いてからの日数（1 通も無ければ null） */
  quietDays: number | null;
  /** 重要なメールが最後に届いた日 */
  lastNeededAt: string | null;
  /** やめて大丈夫か */
  ready: boolean;
  /** あと何日待てばよいか（1 と 2 が済んでいるときだけ意味がある） */
  waitDays: number;
}

const DAY = 24 * 3600 * 1000;

export function graduation(services: Service[], scanned: boolean, now: number = Date.now()): Graduation {
  const live = services.filter((s) => s.count > 0 || s.status !== "new");
  const todo = live.filter((s) => (s.status === "new" || s.status === "move") && s.judgment.level !== "ads").length;
  const leaking = live.filter((s) => s.status === "done" && s.stillArriving).length;
  // 「不要」にしたサービス（もう使わない・退会する）のメールは、待ち時間に数えない
  let last = 0;
  for (const s of live) {
    if (s.status === "skip") continue;
    for (const k of NEEDED_KINDS) {
      const t = s.signal_last[k] ? Date.parse(s.signal_last[k]!) : 0;
      if (t > last) last = t;
    }
  }
  const quietDays = last ? Math.max(0, Math.floor((now - last) / DAY)) : null;
  const waitDays = quietDays === null ? 0 : Math.max(0, QUIET_DAYS - quietDays);
  return { scanned, todo, leaking, quietDays, lastNeededAt: last ? new Date(last).toISOString() : null, ready: scanned && todo === 0 && leaking === 0 && waitDays === 0, waitDays };
}
