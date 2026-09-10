"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { StatusDot, UrgencyBar, authorName } from "@/components/Badges";
import { DemoNote } from "@/components/DemoNote";
import { EmptyState, LoadingBlock } from "@/components/EmptyState";
import { timeAgo } from "@/lib/format";
import { ADMIN_FILTERS, urgencyOf } from "@/lib/labels";
import { dashboardStats } from "@/lib/stats";
import { useDemoState } from "@/lib/store";
import { useNow } from "@/lib/useNow";
import type { Report, User } from "@/lib/types";

type Filter = (typeof ADMIN_FILTERS)[number]["value"];

export function AdminDashboardScreen() {
  const demo = useDemoState();
  const now = useNow();
  // 開いた瞬間に「今すぐ手を打つべきもの」から始まるよう、初期値は未対応
  const [filter, setFilter] = useState<Filter>("new");

  const stats = useMemo(() => (demo ? dashboardStats(demo.reports, now) : null), [demo, now]);

  /** 危険かつ未対応。フィルタに関係なく最上部で警告する */
  const urgent = useMemo(
    () =>
      (demo?.reports ?? [])
        .filter((report) => report.urgency === "danger" && report.status === "new")
        .sort((a, b) => a.createdAt - b.createdAt),
    [demo],
  );

  const rows = useMemo(() => {
    if (!demo) return [];
    const statuses = ADMIN_FILTERS.find((item) => item.value === filter)!.statuses;
    const urgentIds = new Set(urgent.map((report) => report.id));
    return demo.reports
      .filter((report) => statuses.includes(report.status))
      .filter((report) => !(filter === "new" && urgentIds.has(report.id)))
      .sort((a, b) =>
        filter === "done"
          ? b.createdAt - a.createdAt
          : // 危険 → 早めに → 通常、同じ緊急度なら「お待たせしている順」
            urgencyOf(a.urgency).weight - urgencyOf(b.urgency).weight ||
            a.createdAt - b.createdAt,
      );
  }, [demo, filter, urgent]);

  if (!demo || !stats) return <LoadingBlock />;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-title text-ink">現場改善ダッシュボード</h1>
        <p className="text-note text-ink-muted">
          全3拠点から届いた声に、必ず反応するための管理画面です
        </p>
      </header>

      <section className="card flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <p className="text-note text-ink-muted">未対応</p>
          <p className={`text-num ${stats.pending > 0 ? "text-danger" : "text-ink"}`}>
            {stats.pending}
            <span className="ml-0.5 text-note font-bold">件</span>
          </p>
        </div>
        <p className="text-note text-ink-muted">
          今月 {stats.monthlyCount}件・採用率 {Math.round(stats.adoptionRate * 100)}%・平均返答{" "}
          {stats.averageFirstReplyHours === null
            ? "—"
            : `${Math.round(stats.averageFirstReplyHours)}時間`}
        </p>
      </section>

      {urgent.length > 0 ? (
        <section className="rounded-[14px] border border-red-200 bg-red-50 p-3">
          <h2 className="mb-2 text-note font-bold text-danger">
            ⚠️ 今すぐ確認：危険の報告が {urgent.length}件
          </h2>
          <ul className="space-y-2">
            {urgent.map((report) => (
              <ReportRow
                key={report.id}
                report={report}
                users={demo.users}
                now={now}
                tone="alert"
              />
            ))}
          </ul>
        </section>
      ) : null}

      <section className="space-y-3">
        <div className="flex gap-2">
          {ADMIN_FILTERS.map((item) => {
            const count = demo.reports.filter((r) => item.statuses.includes(r.status)).length;
            const active = filter === item.value;
            return (
              <button
                key={item.value}
                type="button"
                onClick={() => setFilter(item.value)}
                aria-pressed={active}
                className={`min-h-10 flex-1 rounded-full border text-note font-bold transition ${
                  active
                    ? "border-brand bg-brand text-white"
                    : "border-line bg-surface text-ink-muted"
                }`}
              >
                {item.label}（{count}）
              </button>
            );
          })}
        </div>

        <p className="text-note text-ink-faint">
          {filter === "done"
            ? "新しい順に表示しています"
            : "危険 → 早めに → お待たせしている順に並んでいます"}
        </p>

        {rows.length === 0 ? (
          <EmptyState emoji="✅" title="この条件の報告はありません" />
        ) : (
          <ul className="space-y-2">
            {rows.map((report) => (
              <ReportRow key={report.id} report={report} users={demo.users} now={now} />
            ))}
          </ul>
        )}
      </section>

      <DemoNote />
    </div>
  );
}

function ReportRow({
  report,
  users,
  now,
  tone = "normal",
}: {
  report: Report;
  users: User[];
  now: number;
  tone?: "normal" | "alert";
}) {
  const author = users.find((user) => user.id === report.authorId) ?? null;
  const meta = [
    report.site,
    authorName(author, report.anonymous),
    report.area,
    timeAgo(report.createdAt, now),
  ];

  return (
    <li>
      <Link
        href={`/admin/${report.id}`}
        className={`relative flex items-center gap-3 overflow-hidden rounded-[14px] border p-3 transition hover:border-ink-faint ${
          tone === "alert" ? "border-red-200 bg-surface" : "card"
        }`}
      >
        <UrgencyBar urgency={report.urgency} />
        <div className="min-w-0 flex-1 pl-1">
          <p className="truncate text-head text-ink">{report.title}</p>
          <p className="mt-0.5 truncate text-note text-ink-muted">{meta.join("・")}</p>
        </div>
        {report.sharedToSites ? <span title="全拠点へ共有ずみ">🏢</span> : null}
        {report.sharedToHq ? <span title="本社へ報告ずみ">🏛</span> : null}
        <StatusDot status={report.status} />
      </Link>
    </li>
  );
}
