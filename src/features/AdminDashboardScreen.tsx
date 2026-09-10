"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Avatar, StatusBadge, TypeChip, UrgencyBadge, authorName } from "@/components/Badges";
import { DemoNote } from "@/components/DemoNote";
import { EmptyState, LoadingBlock } from "@/components/EmptyState";
import { ReportImage } from "@/components/ReportImage";
import { timeAgo } from "@/lib/format";
import { STATUSES, reportTypeOf } from "@/lib/labels";
import { dashboardStats } from "@/lib/stats";
import { useDemoState } from "@/lib/store";
import { useNow } from "@/lib/useNow";
import type { ReportStatus } from "@/lib/types";

const URGENCY_WEIGHT = { danger: 0, soon: 1, normal: 2 } as const;

export function AdminDashboardScreen() {
  const demo = useDemoState();
  const now = useNow();
  const [filter, setFilter] = useState<ReportStatus | "all">("all");

  const stats = useMemo(
    () => (demo ? dashboardStats(demo.reports, now) : null),
    [demo, now],
  );

  const rows = useMemo(() => {
    if (!demo) return [];
    return demo.reports
      .filter((report) => filter === "all" || report.status === filter)
      .sort(
        (a, b) =>
          URGENCY_WEIGHT[a.urgency] - URGENCY_WEIGHT[b.urgency] ||
          b.createdAt - a.createdAt,
      );
  }, [demo, filter]);

  if (!demo || !stats) return <LoadingBlock />;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-bold text-ink">現場改善ダッシュボード</h1>
        <p className="text-xs text-ink-muted">
          現場から届いた声に、必ず反応するための管理画面です
        </p>
      </header>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label="今月の報告" value={`${stats.monthlyCount}`} unit="件" />
        <KpiCard
          label="未対応"
          value={`${stats.pending}`}
          unit="件"
          tone={stats.pending > 0 ? "alert" : "good"}
          note={stats.dangerCount > 0 ? `うち危険 ${stats.dangerCount}件` : "すべて返信済み"}
        />
        <KpiCard
          label="採用率"
          value={`${Math.round(stats.adoptionRate * 100)}`}
          unit="%"
          note={`対応済み ${stats.respondedCount}件のうち`}
        />
        <KpiCard
          label="平均初回返答"
          value={
            stats.averageFirstReplyHours === null
              ? "—"
              : `${Math.round(stats.averageFirstReplyHours)}`
          }
          unit="時間"
          note="早い返答が投稿を増やします"
        />
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
            すべて（{demo.reports.length}）
          </FilterChip>
          {STATUSES.map((status) => {
            const count = demo.reports.filter((r) => r.status === status.value).length;
            return (
              <FilterChip
                key={status.value}
                active={filter === status.value}
                onClick={() => setFilter(status.value)}
              >
                {status.label}（{count}）
              </FilterChip>
            );
          })}
        </div>

        {rows.length === 0 ? (
          <EmptyState emoji="✅" title="この条件の報告はありません" />
        ) : (
          <ul className="space-y-2">
            {rows.map((report) => {
              const author = demo.users.find((user) => user.id === report.authorId) ?? null;
              return (
                <li key={report.id}>
                  <Link
                    href={`/admin/${report.id}`}
                    className="card flex items-center gap-3 p-3 transition hover:border-brand-line"
                  >
                    <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-canvas">
                      <ReportImage
                        src={report.beforeImage}
                        alt=""
                        fallbackEmoji={reportTypeOf(report.type).emoji}
                        className="h-full w-full object-cover"
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex flex-wrap items-center gap-1.5">
                        <StatusBadge status={report.status} />
                        <UrgencyBadge urgency={report.urgency} />
                        <TypeChip type={report.type} />
                      </div>
                      <p className="truncate text-sm font-bold text-ink">{report.title}</p>
                      <p className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-ink-muted">
                        <Avatar user={author} anonymous={report.anonymous} size={16} />
                        {authorName(author, report.anonymous)}・{report.area}・
                        {timeAgo(report.createdAt, now)}
                      </p>
                    </div>
                    <span
                      aria-hidden
                      className="shrink-0 text-sm font-bold text-ink-faint"
                    >
                      ›
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <DemoNote />
    </div>
  );
}

function KpiCard({
  label,
  value,
  unit,
  note,
  tone = "normal",
}: {
  label: string;
  value: string;
  unit: string;
  note?: string;
  tone?: "normal" | "alert" | "good";
}) {
  const toneClass =
    tone === "alert" ? "text-danger" : tone === "good" ? "text-status-adopted" : "text-ink";
  return (
    <div className="card p-3">
      <p className="text-[11px] font-bold text-ink-muted">{label}</p>
      <p className={`mt-1 text-2xl font-black tabular-nums ${toneClass}`}>
        {value}
        <span className="ml-0.5 text-xs font-bold">{unit}</span>
      </p>
      {note ? <p className="mt-0.5 text-[10px] leading-tight text-ink-faint">{note}</p> : null}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`min-h-9 rounded-full border px-3 text-xs font-bold transition ${
        active
          ? "border-brand bg-brand-soft text-brand-dark"
          : "border-line bg-surface text-ink-muted"
      }`}
    >
      {children}
    </button>
  );
}
