"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { LoadingBlock, EmptyState } from "@/components/EmptyState";
import { LevelProgress } from "@/components/LevelProgress";
import { ReportCard } from "@/components/ReportCard";
import { REPORT_TYPES } from "@/lib/labels";
import { isSameMonth } from "@/lib/format";
import { userPoints, userReports } from "@/lib/points";
import { useDemoState } from "@/lib/store";
import type { ReportType } from "@/lib/types";
import { useNow } from "@/lib/useNow";
import { DemoNote } from "@/components/DemoNote";

type Tab = "latest" | "adopted" | "mine";

const TABS: { value: Tab; label: string }[] = [
  { value: "latest", label: "新着" },
  { value: "adopted", label: "採用された改善" },
  { value: "mine", label: "自分の投稿" },
];

export function FeedScreen() {
  const demo = useDemoState();
  const now = useNow();
  const [tab, setTab] = useState<Tab>("latest");
  const [type, setType] = useState<ReportType | "all">("all");

  const me = demo?.users.find((user) => user.id === demo.staffUserId) ?? null;

  const reports = useMemo(() => {
    if (!demo) return [];
    return demo.reports
      .filter((report) => {
        if (tab === "adopted") return report.status === "adopted" || report.status === "partial";
        if (tab === "mine") return report.authorId === demo.staffUserId;
        return true;
      })
      .filter((report) => type === "all" || report.type === type)
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [demo, tab, type]);

  if (!demo || !me) return <LoadingBlock />;

  const myReports = userReports(me.id, demo.reports);
  const myMonthly = myReports.filter((report) => isSameMonth(report.createdAt, now)).length;

  return (
    <div className="space-y-4">
      <section className="card p-4">
        <p className="text-xs text-ink-muted">おつかれさまです</p>
        <p className="mb-3 text-lg font-bold text-ink">{me.name} さん</p>
        <LevelProgress points={userPoints(me.id, demo.reports)} />
        <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-line pt-3 text-center">
          <div>
            <dt className="text-[11px] text-ink-muted">今月の報告</dt>
            <dd className="text-base font-bold text-ink">{myMonthly}件</dd>
          </div>
          <div>
            <dt className="text-[11px] text-ink-muted">累計の報告</dt>
            <dd className="text-base font-bold text-ink">{myReports.length}件</dd>
          </div>
          <div>
            <dt className="text-[11px] text-ink-muted">採用された数</dt>
            <dd className="text-base font-bold text-status-adopted">
              {myReports.filter((r) => r.status === "adopted" || r.status === "partial").length}件
            </dd>
          </div>
        </dl>
      </section>

      <div>
        <div
          role="tablist"
          aria-label="表示する報告"
          className="flex rounded-full border border-line bg-surface p-1"
        >
          {TABS.map((item) => {
            const active = tab === item.value;
            return (
              <button
                key={item.value}
                role="tab"
                aria-selected={active}
                type="button"
                onClick={() => setTab(item.value)}
                className={`min-h-9 flex-1 rounded-full px-2 text-xs font-bold transition ${
                  active ? "bg-brand text-white" : "text-ink-muted"
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </div>

        <div className="no-scrollbar -mx-4 mt-3 flex gap-2 overflow-x-auto px-4 pb-1">
          <FilterChip active={type === "all"} onClick={() => setType("all")}>
            すべて
          </FilterChip>
          {REPORT_TYPES.map((item) => (
            <FilterChip
              key={item.value}
              active={type === item.value}
              onClick={() => setType(item.value)}
            >
              {item.emoji} {item.short}
            </FilterChip>
          ))}
        </div>
      </div>

      <section className="space-y-3" aria-live="polite">
        {reports.length === 0 ? (
          <EmptyState
            title="まだ報告がありません"
            description="小さな気づきで大丈夫です。右下のボタンから報告してみましょう。"
          />
        ) : (
          reports.map((report) => (
            <ReportCard
              key={report.id}
              report={report}
              author={demo.users.find((user) => user.id === report.authorId) ?? null}
              href={demo.role === "admin" ? `/admin/${report.id}` : `/report/${report.id}`}
              now={now}
            />
          ))
        )}
      </section>

      <DemoNote />

      <Link
        href="/new"
        className="fixed bottom-20 right-[max(1rem,calc(50%-238px))] z-30 flex min-h-14 items-center gap-2 rounded-full bg-brand px-5 text-sm font-bold text-white shadow-lg shadow-brand/30 transition active:scale-95"
      >
        <span aria-hidden className="text-lg">
          ＋
        </span>
        報告する
      </Link>
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
      className={`min-h-9 shrink-0 whitespace-nowrap rounded-full border px-3 text-xs font-bold transition ${
        active
          ? "border-brand bg-brand-soft text-brand-dark"
          : "border-line bg-surface text-ink-muted"
      }`}
    >
      {children}
    </button>
  );
}
