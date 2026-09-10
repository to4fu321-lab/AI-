import type { Report } from "./types";
import { isSameMonth } from "./format";

/**
 * ポイントのルール。
 * 「採用されなくても、出せば必ず入る」ことがこのアプリの肝なので、
 * 投稿そのものへの加点を必ず含める。
 */
export const POINT_RULES = {
  post: 10,
  photo: 5,
  afterPhoto: 10,
  adopted: 50,
  partial: 30,
  thanks: 5,
  weeklyStreak: 20,
} as const;

export interface PointLine {
  label: string;
  points: number;
}

/** 1件の報告そのものから得られるポイントの内訳（管理者アクション分を除く） */
export function postPointLines(report: Pick<Report, "beforeImage" | "afterImage">): PointLine[] {
  const lines: PointLine[] = [{ label: "報告してくれてありがとう", points: POINT_RULES.post }];
  if (report.beforeImage) lines.push({ label: "写真を付けた", points: POINT_RULES.photo });
  if (report.afterImage) lines.push({ label: "After写真も付けた", points: POINT_RULES.afterPhoto });
  return lines;
}

export function postPoints(report: Pick<Report, "beforeImage" | "afterImage">): number {
  return postPointLines(report).reduce((sum, line) => sum + line.points, 0);
}

/** 管理者アクションで加算されたポイント */
export function actionPoints(report: Report): number {
  return report.actions.reduce((sum, action) => sum + action.bonusPoints, 0);
}

/** 1件の報告が投稿者にもたらした合計ポイント */
export function reportPoints(report: Report): number {
  return postPoints(report) + actionPoints(report);
}

/** その週（月曜始まり）のキー */
function weekKey(timestamp: number): string {
  const d = new Date(timestamp);
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** 週3件の連続投稿ボーナス */
export function streakBonus(reports: Report[]): number {
  const weeks = new Map<string, number>();
  for (const report of reports) {
    const key = weekKey(report.createdAt);
    weeks.set(key, (weeks.get(key) ?? 0) + 1);
  }
  let bonus = 0;
  for (const count of weeks.values()) {
    if (count >= 3) bonus += POINT_RULES.weeklyStreak;
  }
  return bonus;
}

export function userReports(userId: string, reports: Report[]): Report[] {
  return reports.filter((report) => report.authorId === userId);
}

export function userPoints(userId: string, reports: Report[]): number {
  const mine = userReports(userId, reports);
  return mine.reduce((sum, report) => sum + reportPoints(report), 0) + streakBonus(mine);
}

export function userMonthlyPoints(userId: string, reports: Report[], now: number): number {
  return userReports(userId, reports)
    .filter((report) => isSameMonth(report.createdAt, now))
    .reduce((sum, report) => sum + reportPoints(report), 0);
}

export const LEVELS = [
  { name: "カイゼン見習い", min: 0 },
  { name: "カイゼンアシスタント", min: 60 },
  { name: "カイゼンリーダー", min: 180 },
  { name: "カイゼンマイスター", min: 400 },
  { name: "レジェンド改善家", min: 800 },
] as const;

export interface LevelInfo {
  index: number;
  name: string;
  current: number;
  min: number;
  next: number | null;
  nextName: string | null;
  progress: number;
}

export function levelOf(points: number): LevelInfo {
  let index = 0;
  for (let i = 0; i < LEVELS.length; i++) {
    if (points >= LEVELS[i].min) index = i;
  }
  const level = LEVELS[index];
  const nextLevel = LEVELS[index + 1] ?? null;
  const span = nextLevel ? nextLevel.min - level.min : 1;
  return {
    index,
    name: level.name,
    current: points,
    min: level.min,
    next: nextLevel ? nextLevel.min : null,
    nextName: nextLevel ? nextLevel.name : null,
    progress: nextLevel ? Math.min(1, (points - level.min) / span) : 1,
  };
}

export interface Badge {
  id: string;
  name: string;
  emoji: string;
  description: string;
  earned: boolean;
}

/** バッジは投稿履歴から毎回導出する（保存しない） */
export function badgesOf(userId: string, reports: Report[]): Badge[] {
  const mine = userReports(userId, reports);
  const adopted = mine.filter((r) => r.status === "adopted" || r.status === "partial");
  const withAfter = mine.filter((r) => r.afterImage);
  const hiyari = mine.filter((r) => r.type === "hiyari");
  const likes = mine.reduce((sum, r) => sum + r.reactions.like.length, 0);

  return [
    {
      id: "first-post",
      name: "はじめの一歩",
      emoji: "🌱",
      description: "はじめて報告した",
      earned: mine.length >= 1,
    },
    {
      id: "five-posts",
      name: "気づきの達人",
      emoji: "🔍",
      description: "5件以上報告した",
      earned: mine.length >= 5,
    },
    {
      id: "first-adopted",
      name: "はじめての採用",
      emoji: "🎉",
      description: "提案が採用された",
      earned: adopted.length >= 1,
    },
    {
      id: "before-after",
      name: "Before/Afterマスター",
      emoji: "🪄",
      description: "After写真付きの報告を2件",
      earned: withAfter.length >= 2,
    },
    {
      id: "safety",
      name: "セーフティキーパー",
      emoji: "🦺",
      description: "ヒヤリハットを報告した",
      earned: hiyari.length >= 1,
    },
    {
      id: "loved",
      name: "みんなの代弁者",
      emoji: "💛",
      description: "共感を10件集めた",
      earned: likes >= 10,
    },
  ];
}

export interface RankingRow {
  userId: string;
  points: number;
  count: number;
  rank: number;
}

/** 今月のポイントランキング（スタッフのみ） */
export function monthlyRanking(
  userIds: string[],
  reports: Report[],
  now: number,
): RankingRow[] {
  return userIds
    .map((userId) => ({
      userId,
      points: userMonthlyPoints(userId, reports, now),
      count: userReports(userId, reports).filter((r) => isSameMonth(r.createdAt, now)).length,
    }))
    .sort((a, b) => b.points - a.points || b.count - a.count)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}
