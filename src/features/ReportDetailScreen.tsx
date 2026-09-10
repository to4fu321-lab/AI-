"use client";

import Link from "next/link";
import { Avatar, StatusBadge, TypeChip, UrgencyBadge, authorName } from "@/components/Badges";
import { BeforeAfterSlider } from "@/components/BeforeAfterSlider";
import { EmptyState, LoadingBlock } from "@/components/EmptyState";
import { ReportImage } from "@/components/ReportImage";
import { Timeline } from "@/components/Timeline";
import { timeAgo } from "@/lib/format";
import { reportPoints } from "@/lib/points";
import { toggleReaction, useDemoState } from "@/lib/store";
import { useNow } from "@/lib/useNow";
import type { ReactionKind } from "@/lib/types";

export function ReportDetailScreen({ id }: { id: string }) {
  const demo = useDemoState();
  const now = useNow();

  if (!demo) return <LoadingBlock />;

  const report = demo.reports.find((item) => item.id === id);
  if (!report) {
    return (
      <div className="space-y-4">
        <EmptyState emoji="🔍" title="報告が見つかりませんでした" />
        <Link href="/" className="block text-center text-sm font-bold text-brand">
          フィードにもどる
        </Link>
      </div>
    );
  }

  const author = demo.users.find((user) => user.id === report.authorId) ?? null;
  const isMine = report.authorId === demo.staffUserId;

  const reactionButton = (kind: ReactionKind, emoji: string, label: string) => {
    const list = report.reactions[kind];
    const active = list.includes(demo.staffUserId);
    return (
      <button
        type="button"
        onClick={() => toggleReaction(report.id, kind)}
        aria-pressed={active}
        className={`flex min-h-12 flex-1 items-center justify-center gap-1.5 rounded-xl border text-sm font-bold transition active:scale-95 ${
          active
            ? "border-brand bg-brand-soft text-brand-dark"
            : "border-line bg-surface text-ink-muted"
        }`}
      >
        <span aria-hidden>{emoji}</span>
        {label}
        <span className="tabular-nums">{list.length}</span>
      </button>
    );
  };

  return (
    <div className="space-y-4">
      <Link href="/" className="inline-flex min-h-11 items-center text-sm font-bold text-ink-muted">
        ← フィード
      </Link>

      {report.afterImage ? (
        <BeforeAfterSlider before={report.beforeImage} after={report.afterImage} />
      ) : report.beforeImage ? (
        <ReportImage
          src={report.beforeImage}
          alt="報告された現場の写真"
          className="w-full rounded-2xl border border-line"
        />
      ) : null}

      <section className="card p-4">
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <StatusBadge status={report.status} />
          <UrgencyBadge urgency={report.urgency} />
          <TypeChip type={report.type} />
        </div>

        <h1 className="text-lg font-bold leading-snug text-ink">{report.title}</h1>

        {report.body ? (
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink-muted">
            {report.body}
          </p>
        ) : null}

        <dl className="mt-3 space-y-1 border-t border-line pt-3 text-xs text-ink-muted">
          <div className="flex gap-2">
            <dt className="shrink-0 font-bold">場所</dt>
            <dd>
              {report.area}
              {report.areaNote ? `（${report.areaNote}）` : ""}
            </dd>
          </div>
        </dl>

        <div className="mt-3 flex items-center gap-2 border-t border-line pt-3">
          <Avatar user={author} anonymous={report.anonymous} size={28} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-bold text-ink">
              {authorName(author, report.anonymous)}
              {isMine ? <span className="ml-1 text-brand">（自分）</span> : null}
            </p>
            <p className="text-[11px] text-ink-faint">{timeAgo(report.createdAt, now)}</p>
          </div>
          {isMine ? (
            <p className="shrink-0 rounded-full bg-brand-soft px-2.5 py-1 text-[11px] font-bold text-brand-dark">
              獲得 {reportPoints(report)}pt
            </p>
          ) : null}
        </div>
      </section>

      <div className="flex gap-2">
        {reactionButton("like", "👍", "いいね")}
        {reactionButton("same", "💡", "自分も思ってた")}
      </div>

      <section className="card p-4">
        <h2 className="mb-3 text-sm font-bold text-ink">この報告のその後</h2>
        <Timeline report={report} users={demo.users} />
      </section>

    </div>
  );
}
