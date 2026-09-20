"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { DemoNote } from "@/components/DemoNote";
import { EmptyState, LoadingBlock } from "@/components/EmptyState";
import { LevelProgress } from "@/components/LevelProgress";
import { ReportCard } from "@/components/ReportCard";
import { ACCEPTED_STATUSES } from "@/lib/labels";
import { userPoints } from "@/lib/points";
import { useDemoState, useUnreadNoticeCount } from "@/lib/store";
import { useNow } from "@/lib/useNow";

type Tab = "latest" | "adopted" | "mine";

const TABS: { value: Tab; label: string }[] = [
  { value: "mine", label: "自分の報告" },
  { value: "latest", label: "新着" },
  { value: "adopted", label: "採用ずみ" },
];

export function FeedScreen() {
  const demo = useDemoState();
  const now = useNow();
  const unreadNotices = useUnreadNoticeCount();
  const [tab, setTab] = useState<Tab>("mine");

  const me = demo?.users.find((user) => user.id === demo.staffUserId) ?? null;

  const reports = useMemo(() => {
    if (!demo || !me) return [];
    return demo.reports
      // 自分の拠点の報告と、他拠点から全拠点共有された事例が流れてくる
      .filter((report) => report.site === me.site || report.sharedToSites)
      .filter((report) => {
        if (tab === "adopted") return ACCEPTED_STATUSES.includes(report.status);
        if (tab === "mine") return report.authorId === me.id;
        return true;
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [demo, me, tab]);

  if (!demo || !me) return <LoadingBlock />;

  return (
    <div className="space-y-5">
      <section className="card p-4">
        <p className="text-note text-ink-muted">{me.site}</p>
        <p className="mb-3 text-head text-ink">{me.name} さん</p>
        <LevelProgress points={userPoints(me.id, demo.reports)} />
      </section>

      {unreadNotices > 0 ? (
        <Link
          href="/notices"
          className="flex min-h-12 items-center gap-2 rounded-[14px] border border-brand bg-brand-soft px-4 text-body font-bold text-brand-dark"
        >
          <span aria-hidden>📣</span>
          管理者から{unreadNotices}件のお知らせ
          <span className="ml-auto" aria-hidden>
            →
          </span>
        </Link>
      ) : null}

      <div role="tablist" aria-label="表示する報告" className="flex gap-1">
        {TABS.map((item) => {
          const active = tab === item.value;
          return (
            <button
              key={item.value}
              role="tab"
              aria-selected={active}
              type="button"
              onClick={() => setTab(item.value)}
              className={`chip flex-1 ${active ? "chip-on" : ""}`}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      <section className="space-y-2.5" aria-live="polite">
        {reports.length === 0 ? (
          <EmptyState
            title="まだ報告がありません"
            description="小さな気づきで大丈夫です。右下のボタンから報告できます。"
          />
        ) : (
          reports.map((report) => (
            <ReportCard
              key={report.id}
              report={report}
              author={demo.users.find((user) => user.id === report.authorId) ?? null}
              href={`/report/${report.id}`}
              now={now}
              fromOtherSite={report.site !== me.site}
            />
          ))
        )}
      </section>

      <DemoNote />

      <div className="pointer-events-none fixed inset-x-0 bottom-20 z-30">
        <div className="mx-auto flex max-w-[520px] justify-end px-4 lg:max-w-[640px]">
          <Link
            href="/new"
            className="btn btn-primary pointer-events-auto min-h-14 px-5 text-head"
          >
            <span aria-hidden>＋</span>
            報告する
          </Link>
        </div>
      </div>
    </div>
  );
}
