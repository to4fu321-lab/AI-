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
}

export interface JudgeInput {
  signals: Partial<Record<Kind, number>>;
  /** 種類ごとの、最後に届いた日（ISO 形式） */
  signalLast: Partial<Record<Kind, string>>;
}

const MONTH = 30 * 24 * 3600 * 1000;
/** ログイン・本人確認のメールが、この期間内に届いていれば「頼っている」 */
const LOGIN_RECENT_MONTHS = 24;
/** 支払い・注文のメールが、この期間内に届いていれば「頼っている」 */
const BILLING_RECENT_MONTHS = 13;

const KIND_PHRASE: Record<Kind, string> = {
  auth: "認証コード",
  security: "ログイン通知",
  password: "パスワード再設定",
  signup: "登録・確認",
  billing: "支払い・注文",
  notice: "お知らせ",
  promo: "広告",
};

const ym = (iso: string) => `${iso.slice(0, 4)}/${iso.slice(5, 7)}`;

export function judge(input: JudgeInput, now: number = Date.now()): Judgment {
  const { signals, signalLast } = input;
  const has = (k: Kind) => (signals[k] ?? 0) > 0;
  const last = (k: Kind) => (signalLast[k] ? Date.parse(signalLast[k]!) : NaN);
  const within = (k: Kind, months: number) => now - last(k) <= months * MONTH;

  const loginDates = LOGIN_KINDS.map((k) => signalLast[k]).filter((d): d is string => !!d).sort();
  const lastLoginAt = loginDates.length ? loginDates[loginDates.length - 1] : null;

  const reasons: string[] = [];
  for (const k of LOGIN_KINDS) if (has(k) && within(k, LOGIN_RECENT_MONTHS)) reasons.push(`${ym(signalLast[k]!)} に${KIND_PHRASE[k]}のメールが届いています`);
  if (has("billing") && within("billing", BILLING_RECENT_MONTHS)) reasons.push(`${ym(signalLast.billing!)} に${KIND_PHRASE.billing}のメールが届いています`);
  if (reasons.length) return { level: "depends", reasons, lastLoginAt };

  const traces = ([...LOGIN_KINDS, "billing", "signup"] as Kind[]).filter(has);
  if (traces.length) {
    const dated = traces.filter((k) => signalLast[k]).sort((a, b) => last(b) - last(a));
    return {
      level: "maybe",
      reasons: dated.length
        ? [`${KIND_PHRASE[dated[0]]}のメールが最後に届いたのは ${ym(signalLast[dated[0]]!)} です`]
        : [`${traces.map((k) => KIND_PHRASE[k]).join("・")}のメールが届いたことがあります`],
      lastLoginAt,
    };
  }
  if (has("notice")) return { level: "maybe", reasons: ["この人あてのお知らせが届いています（登録にかかわるメールは見つかっていません）"], lastLoginAt };
  return { level: "ads", reasons: ["広告・一斉配信のメールだけが届いています"], lastLoginAt };
}
