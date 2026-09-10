import { isSameMonth } from "./format";
import type { Report } from "./types";

export interface DashboardStats {
  monthlyCount: number;
  pending: number;
  adoptionRate: number;
  respondedCount: number;
  averageFirstReplyHours: number | null;
  dangerCount: number;
}

/** 管理ダッシュボードのKPI。未対応件数を最重要に置く */
export function dashboardStats(reports: Report[], now: number): DashboardStats {
  const monthly = reports.filter((report) => isSameMonth(report.createdAt, now));
  const responded = reports.filter((report) => report.actions.length > 0);
  const adopted = reports.filter(
    (report) => report.status === "adopted" || report.status === "partial",
  );

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
  };
}
