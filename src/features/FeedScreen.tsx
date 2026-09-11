"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { DemoNote } from "@/components/DemoNote";
import { EmptyState, LoadingBlock } from "@/components/EmptyState";
import { LevelProgress } from "@/components/LevelProgress";
import { ReportCard } from "@/components/ReportCard";
import { userPoints } from "@/lib/points";
import { useDemoState } from "@/lib/store";
import { useNow } from "@/lib/useNow";

type Tab = "latest" | "adopted" | "mine";

const TABS: { value: Tab; label: string }[] = [
  { value: "latest", label: "新着" },
  { value: "adopted", label: "採用ずみ" },
  { value: "mine", label: "自分の報告" },
];

export function FeedScreen() {
  const demo = useDemoState();
  const now = useNow();
  const [tab, setTab] = useState<Tab>("mine");

  const me = demo?.users.find((user) => user.id === demo.staffUserId) ?? null;

  const reports = useMemo(() => {
    if (!demo || !me) return [];
    return demo.reports
      // 自分の拠点の報告と、他拠点から全拠点共有された事例が流れてくる
      .filter((report) => report.site === me.site || report.sharedToSites)
      .filter((report) => {
        if (tab === "adopted") return report.status === "adopted" || report.status === "partial";
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
              className={`min-h-10 flex-1 rounded-full border text-note font-bold transition ${
                active
                  ? "border-brand bg-brand text-white"
                  : "border-line bg-surface text-ink-muted"
              }`}
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

      <Link
        href="/new"
        className="fixed bottom-20 right-[max(1rem,calc(50%-238px))] z-30 flex min-h-14 items-center gap-2 rounded-full bg-brand px-5 text-head text-white transition active:scale-95"
      >
        <span aria-hidden>＋</span>
        報告する
      </Link>
    </div>
  );
}
