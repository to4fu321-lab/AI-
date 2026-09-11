"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Avatar, StatusDot, UrgencyText, authorName, typeText } from "@/components/Badges";
import { BeforeAfterSlider } from "@/components/BeforeAfterSlider";
import { EmptyState, LoadingBlock } from "@/components/EmptyState";
import { ReportImage } from "@/components/ReportImage";
import { Timeline } from "@/components/Timeline";
import { timeAgo } from "@/lib/format";
import { deleteReport, toggleReaction, useDemoState } from "@/lib/store";
import { useNow } from "@/lib/useNow";
import type { ReactionKind } from "@/lib/types";

export function ReportDetailScreen({ id }: { id: string }) {
  const demo = useDemoState();
  const now = useNow();
  const router = useRouter();

  if (!demo) return <LoadingBlock />;

  const report = demo.reports.find((item) => item.id === id);
  if (!report) {
    return (
      <div className="space-y-4">
        <EmptyState emoji="🔍" title="報告が見つかりませんでした" />
        <Link href="/" className="block text-center text-body font-bold text-brand">
          フィードにもどる
        </Link>
      </div>
    );
  }

  const author = demo.users.find((user) => user.id === report.authorId) ?? null;
  const isMine = report.authorId === demo.staffUserId;

  const handleDelete = () => {
    if (!window.confirm("この報告を取り消しますか？元に戻せません。")) return;
    deleteReport(report.id);
    router.push("/");
  };

  const reactionButton = (kind: ReactionKind, emoji: string, label: string) => {
    const list = report.reactions[kind];
    const active = list.includes(demo.staffUserId);
    return (
      <button
        type="button"
        onClick={() => toggleReaction(report.id, kind)}
        aria-pressed={active}
        className={`flex min-h-12 flex-1 items-center justify-center gap-1.5 rounded-full border text-body font-bold transition active:scale-95 ${
          active ? "border-brand text-brand" : "border-line bg-surface text-ink-muted"
        }`}
      >
        <span aria-hidden>{emoji}</span>
        {label}
        <span className="tabular-nums">{list.length}</span>
      </button>
    );
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-2">
        <Link href="/" className="inline-flex min-h-11 items-center text-body font-bold text-ink-muted">
          ← フィード
        </Link>
        {isMine ? (
          <div className="flex gap-2">
            <Link
              href={`/edit/${report.id}`}
              className="inline-flex min-h-9 items-center rounded-full border border-line bg-surface px-3 text-note font-bold text-ink-muted"
            >
              修正する
            </Link>
            <button
              type="button"
              onClick={handleDelete}
              className="inline-flex min-h-9 items-center rounded-full border border-line bg-surface px-3 text-note font-bold text-danger"
            >
              取り消す
            </button>
          </div>
        ) : null}
      </div>

      {report.afterImage ? (
        <BeforeAfterSlider before={report.beforeImage} after={report.afterImage} />
      ) : report.beforeImage ? (
        <ReportImage
          src={report.beforeImage}
          alt="報告された現場の写真"
          className="w-full rounded-[14px] border border-line"
        />
      ) : null}

      <section>
        <div className="mb-1.5 flex items-center gap-3">
          <StatusDot status={report.status} size="lg" />
          <UrgencyText urgency={report.urgency} />
        </div>

        <h1 className="text-title text-ink">{report.title}</h1>

        <p className="mt-1.5 text-note text-ink-muted">
          {[typeText(report.type), report.site, report.area, report.areaNote]
            .filter(Boolean)
            .join("・")}
        </p>

        {report.sharedToSites || report.sharedToHq ? (
          <p className="mt-2 text-note font-bold text-ink">
            {report.sharedToSites ? "🏢 全拠点に共有されました" : null}
            {report.sharedToSites && report.sharedToHq ? "　" : null}
            {report.sharedToHq ? "🏛 本社へ報告されました" : null}
          </p>
        ) : null}

        {report.body ? (
          <p className="mt-3 whitespace-pre-wrap text-body text-ink-muted">{report.body}</p>
        ) : null}

        <div className="mt-4 flex items-center gap-2">
          <Avatar user={author} anonymous={report.anonymous} size={28} />
          <p className="text-note text-ink-muted">
            {authorName(author, report.anonymous)}・{timeAgo(report.createdAt, now)}
          </p>
        </div>
      </section>

      <div className="flex gap-2">
        {reactionButton("like", "👍", "いいね")}
        {reactionButton("same", "💡", "自分も思ってた")}
      </div>

      <section className="card p-4">
        <h2 className="mb-3 text-head text-ink">この報告のその後</h2>
        <Timeline report={report} users={demo.users} />
      </section>
    </div>
  );
}
