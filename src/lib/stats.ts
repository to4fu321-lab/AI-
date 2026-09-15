import { isSameMonth } from "./format";
import { ACCEPTED_STATUSES, FINISHED_STATUSES, reportTypeOf } from "./labels";
import type { Report } from "./types";

export interface DashboardStats {
  monthlyCount: number;
  pending: number;
  adoptionRate: number;
  respondedCount: number;
  averageFirstReplyHours: number | null;
  dangerCount: number;
  /** 実際に改善が完了した件数（「現場が変わった数」） */
  improvedCount: number;
}

/** 管理ダッシュボードのKPI。未対応件数を最重要に置く */
export function dashboardStats(reports: Report[], now: number): DashboardStats {
  const monthly = reports.filter((report) => isSameMonth(report.createdAt, now));
  const responded = reports.filter((report) => report.actions.length > 0);
  const adopted = reports.filter((report) => ACCEPTED_STATUSES.includes(report.status));

  const replyHours = responded.map(
    (report) => (report.actions[0].createdAt - report.createdAt) / 3_600_000,
  );

  return {
    monthlyCount: monthly.length,
    pending: reports.filter((report) => report.status === "new").length,
    adoptionRate: responded.length === 0 ? 0 : adopted.length / responded.length,
    respondedCount: responded.length,
    averageFirstReplyHours:
      replyHours.length === 0
        ? null
        : replyHours.reduce((sum, value) => sum + value, 0) / replyHours.length,
    dangerCount: reports.filter(
      (report) => report.urgency === "danger" && report.status === "new",
    ).length,
    improvedCount: reports.filter((report) => FINISHED_STATUSES.includes(report.status)).length,
  };
}

/**
 * 今月のお知らせに載せる集計値。
 *
 * 数字はすべてここで確定させ、AIには文章化だけを任せる。
 * AIに数えさせると、現場に配る連絡に誤った数字が載りかねないため
 */
export interface MonthlySummary {
  month: number;
  reportCount: number;
  reporterCount: number;
  adoptedCount: number;
  doneCount: number;
  dangerCount: number;
  sharedCount: number;
  topCategory: string;
  topCategoryCount: number;
  /** 今月完了した改善の、変わったことのコメント（AIの材料にする） */
  doneHighlights: string[];
}

export function monthlySummary(reports: Report[], now: number): MonthlySummary {
  const monthlyReports = reports.filter((report) => isSameMonth(report.createdAt, now));

  const monthlyActions = reports.flatMap((report) =>
    report.actions
      .filter((action) => isSameMonth(action.createdAt, now))
      .map((action) => ({ action, report })),
  );
  const countActions = (types: string[]) =>
    monthlyActions.filter((item) => types.includes(item.action.type)).length;

  const byCategory = new Map<string, number>();
  for (const report of monthlyReports) {
    const label = reportTypeOf(report.type).label;
    byCategory.set(label, (byCategory.get(label) ?? 0) + 1);
  }
  const [topCategory = "—", topCategoryCount = 0] =
    [...byCategory.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];

  return {
    month: new Date(now).getMonth() + 1,
    reportCount: monthlyReports.length,
    reporterCount: new Set(monthlyReports.map((report) => report.authorId)).size,
    adoptedCount: countActions(["adopted", "partial"]),
    doneCount: countActions(["done"]),
    dangerCount: monthlyReports.filter((report) => report.urgency === "danger").length,
    sharedCount: countActions(["share_sites"]),
    topCategory,
    topCategoryCount,
    doneHighlights: monthlyActions
      .filter((item) => item.action.type === "done")
      .map((item) => `${item.report.title}：${item.action.comment}`)
      .slice(0, 3),
  };
}
