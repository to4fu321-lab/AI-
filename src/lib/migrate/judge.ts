import { LOGIN_KINDS, type Kind } from "./classify";

/**
 * サービスごとに「このアドレスにどれくらい頼っているか」を判定する。
 * 材料は、種類ごとの通数と、種類ごとの「最後に届いた日」だけ。通信もデータベースも使わない。
 *
 * - depends … 頼っている（最近、認証コード・ログイン通知・パスワード再設定・支払いのメールが届いている）
 * - maybe   … たぶん頼っている（登録した跡はあるが、最近の重要なメールがない）
 * - ads     … 広告だけ（登録にかかわるメールが見つからない）
 */
export type Level = "depends" | "maybe" | "ads";

export const LEVEL_LABEL: Record<Level, string> = { depends: "頼っている", maybe: "たぶん頼っている", ads: "広告だけ" };

export interface Judgment {
  level: Level;
  /** 判定の理由（画面にそのまま出せる短い文） */
  reasons: string[];
  /** ログイン・本人確認にかかわるメールが最後に届いた日（なければ null） */
  lastLoginAt: string | null;
  /**
   * 届いた通数が少なく、なりすましの見分けがつかない。
   * 知らない差出人が「パスワード再設定」などを 1 通送ってきただけで「頼っている」と出して、その差出人のサイトへ案内しないための印
   */
  unproven: boolean;
}

export interface JudgeInput {
  signals: Partial<Record<Kind, number>>;
  /** 種類ごとの、最後に届いた日（ISO 形式） */
  signalLast: Partial<Record<Kind, string>>;
  /** そのサービスから届いた全部の通数と、最初・最後に届いた日 */
  count: number;
  firstAt: string | null;
  lastAt: string | null;
}

/** ログイン・本人確認のメールが、この期間内に届いていれば「頼っている」 */
const LOGIN_RECENT_MONTHS = 24;
/** 支払い・注文のメールが、この期間内に届いていれば「頼っている」 */
const BILLING_RECENT_MONTHS = 13;
/** 付き合いがある、と見なす目安：3 通以上が 2 週間以上にわたって届いている。または、短い間でも 8 通以上届いている */
const PROVEN_COUNT = 3;
const PROVEN_DAYS = 14;
const PROVEN_BURST = 8;
const DAY = 24 * 3600 * 1000;
const JST = 9 * 3600 * 1000;

const KIND_PHRASE: Record<Kind, string> = {
  auth: "認証コード",
  security: "ログイン通知",
  password: "パスワード再設定",
  signup: "登録・確認",
  billing: "支払い・注文",
  notice: "お知らせ",
  promo: "広告",
};

/** 日本の時刻での「年/月」 */
const ym = (iso: string) => {
  const d = new Date(Date.parse(iso) + JST);
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

/** now から、暦の上で months か月さかのぼった時刻 */
function monthsBefore(now: number, months: number): number {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.getTime();
}

export function judge(input: JudgeInput, now: number = Date.now()): Judgment {
  const { signals, signalLast } = input;
  const has = (k: Kind) => (signals[k] ?? 0) > 0;
  const last = (k: Kind) => (signalLast[k] ? Date.parse(signalLast[k]!) : NaN);
  const within = (k: Kind, months: number) => last(k) >= monthsBefore(now, months);

  const loginDates = LOGIN_KINDS.map((k) => signalLast[k]).filter((d): d is string => !!d).sort();
  const lastLoginAt = loginDates.length ? loginDates[loginDates.length - 1] : null;
  const span = input.firstAt && input.lastAt ? Date.parse(input.lastAt) - Date.parse(input.firstAt) : 0;
  const unproven = !((input.count >= PROVEN_COUNT && span >= PROVEN_DAYS * DAY) || input.count >= PROVEN_BURST);

  const reasons: string[] = [];
  for (const k of LOGIN_KINDS) if (has(k) && within(k, LOGIN_RECENT_MONTHS)) reasons.push(`${ym(signalLast[k]!)} に${KIND_PHRASE[k]}のメールが届いています`);
  if (has("billing") && within("billing", BILLING_RECENT_MONTHS)) reasons.push(`${ym(signalLast.billing!)} に${KIND_PHRASE.billing}のメールが届いています`);
  if (reasons.length) {
    // 届いたのが少ない差出人は、「頼っている」とは言い切らない（なりすましメールでも同じ形になるため）
    if (unproven) return { level: "maybe", reasons: [...reasons, "届いた通数が少ないので、なりすましのメールでないか、差出人をよく確かめてください"], lastLoginAt, unproven };
    return { level: "depends", reasons, lastLoginAt, unproven };
  }

  const traces = ([...LOGIN_KINDS, "billing", "signup"] as Kind[]).filter(has);
  if (traces.length) {
    const dated = traces.filter((k) => signalLast[k]).sort((a, b) => last(b) - last(a));
    return {
      level: "maybe",
      reasons: dated.length
        ? [`${KIND_PHRASE[dated[0]]}のメールが最後に届いたのは ${ym(signalLast[dated[0]]!)} です`]
        : [`${traces.map((k) => KIND_PHRASE[k]).join("・")}のメールが届いたことがあります`],
      lastLoginAt,
      unproven,
    };
  }
  if (has("notice")) return { level: "maybe", reasons: ["この人あてのお知らせが届いています（登録にかかわるメールは見つかっていません）"], lastLoginAt, unproven };
  return { level: "ads", reasons: ["広告・一斉配信のメールだけが届いています"], lastLoginAt, unproven };
}
