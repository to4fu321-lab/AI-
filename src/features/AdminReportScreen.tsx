"use client";

import Link from "next/link";
import { useState } from "react";
import { Avatar, StatusBadge, TypeChip, UrgencyBadge, authorName } from "@/components/Badges";
import { BeforeAfterSlider } from "@/components/BeforeAfterSlider";
import { EmptyState, LoadingBlock } from "@/components/EmptyState";
import { ReportImage } from "@/components/ReportImage";
import { Timeline } from "@/components/Timeline";
import { formatDateTime } from "@/lib/format";
import { ACTIONS, ACTION_TAGS, actionOf } from "@/lib/labels";
import { addAdminAction, useDemoState } from "@/lib/store";
import type { ActionType } from "@/lib/types";

export function AdminReportScreen({ id }: { id: string }) {
  const demo = useDemoState();
  const [selected, setSelected] = useState<ActionType | null>(null);
  const [comment, setComment] = useState("");
  const [plannedDate, setPlannedDate] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [done, setDone] = useState(false);

  if (!demo) return <LoadingBlock />;

  const report = demo.reports.find((item) => item.id === id);
  if (!report) {
    return (
      <div className="space-y-4">
        <EmptyState emoji="🔍" title="報告が見つかりませんでした" />
        <Link href="/admin" className="block text-center text-sm font-bold text-brand">
          ダッシュボードにもどる
        </Link>
      </div>
    );
  }

  const author = demo.users.find((user) => user.id === report.authorId) ?? null;
  const meta = selected ? actionOf(selected) : null;
  const needsComment = meta?.requiresComment ?? false;
  const canSubmit = selected !== null && (!needsComment || comment.trim().length > 0);

  const submit = () => {
    if (!selected || !canSubmit) return;
    addAdminAction(report.id, selected, comment, {
      plannedDate: selected === "adopted" || selected === "partial" ? plannedDate : undefined,
      tags,
    });
    setSelected(null);
    setComment("");
    setPlannedDate("");
    setTags([]);
    setDone(true);
    window.setTimeout(() => setDone(false), 2600);
  };

  return (
    <div className="space-y-4">
      <Link
        href="/admin"
        className="inline-flex min-h-11 items-center text-sm font-bold text-ink-muted"
      >
        ← ダッシュボード
      </Link>

      <div className="grid gap-4 md:grid-cols-[1.1fr_1fr] md:items-start">
        <div className="space-y-4">
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
            <dl className="mt-3 grid gap-1 border-t border-line pt-3 text-xs text-ink-muted">
              <div className="flex gap-2">
                <dt className="w-16 shrink-0 font-bold">場所</dt>
                <dd>
                  {report.area}
                  {report.areaNote ? `（${report.areaNote}）` : ""}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-16 shrink-0 font-bold">投稿日時</dt>
                <dd>{formatDateTime(report.createdAt)}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-16 shrink-0 font-bold">共感</dt>
                <dd>
                  👍 {report.reactions.like.length}・💡 {report.reactions.same.length}
                </dd>
              </div>
            </dl>
            <div className="mt-3 flex items-center gap-2 border-t border-line pt-3">
              <Avatar user={author} anonymous={report.anonymous} size={28} />
              <p className="text-xs font-bold text-ink">
                {authorName(author, report.anonymous)}
                {author && !report.anonymous ? (
                  <span className="ml-1 font-normal text-ink-muted">{author.team}</span>
                ) : null}
              </p>
            </div>
          </section>

          <section className="card p-4">
            <h2 className="mb-3 text-sm font-bold text-ink">対応の記録</h2>
            <Timeline report={report} users={demo.users} />
          </section>
        </div>

        <section className="card space-y-3 p-4 md:sticky md:top-20">
          <div>
            <h2 className="text-sm font-bold text-ink">この報告にアクションする</h2>
            <p className="text-[11px] text-ink-muted">
              どれを選んでも投稿者に通知されます。返事が早いほど、次の報告が増えます。
            </p>
          </div>

          {done ? (
            <p className="animate-pop rounded-xl bg-emerald-50 px-3 py-2 text-xs font-bold text-status-adopted">
              ✅ 投稿者に通知しました
            </p>
          ) : null}

          <div className="grid gap-2">
            {ACTIONS.map((action) => {
              const active = selected === action.value;
              return (
                <button
                  key={action.value}
                  type="button"
                  onClick={() => setSelected(active ? null : action.value)}
                  aria-pressed={active}
                  className={`flex items-start gap-3 rounded-xl border p-3 text-left transition ${
                    active ? "border-brand bg-brand-soft" : "border-line bg-surface"
                  }`}
                >
                  <span aria-hidden className="text-lg">
                    {action.emoji}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-bold text-ink">{action.label}</span>
                    <span className="block text-[11px] text-ink-muted">
                      {action.description}
                    </span>
                  </span>
                  {action.points > 0 ? (
                    <span className="shrink-0 text-xs font-bold text-brand">
                      +{action.points}pt
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>

          {selected ? (
            <div className="space-y-3 border-t border-line pt-3">
              <label className="block">
                <span className="mb-1 block text-xs font-bold text-ink">
                  投稿者へのコメント
                  {needsComment ? <span className="ml-1 text-brand">必須</span> : null}
                </span>
                <textarea
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  rows={4}
                  placeholder={
                    selected === "declined"
                      ? "見送る理由を、次につながる言葉で伝えてください"
                      : "ありがとうございます。〇〇の形で実施します。"
                  }
                  className="w-full rounded-xl border border-line bg-canvas p-3 text-sm leading-relaxed text-ink outline-none focus:border-brand"
                />
              </label>

              {selected === "adopted" || selected === "partial" ? (
                <label className="block">
                  <span className="mb-1 block text-xs font-bold text-ink">実施予定</span>
                  <input
                    value={plannedDate}
                    onChange={(event) => setPlannedDate(event.target.value)}
                    placeholder="例）今月末までに全通路"
                    className="min-h-11 w-full rounded-xl border border-line bg-canvas px-3 text-sm text-ink outline-none focus:border-brand"
                  />
                </label>
              ) : null}

              <div>
                <p className="mb-1.5 text-xs font-bold text-ink">タグ</p>
                <div className="flex flex-wrap gap-2">
                  {ACTION_TAGS.map((tag) => {
                    const active = tags.includes(tag);
                    return (
                      <button
                        key={tag}
                        type="button"
                        aria-pressed={active}
                        onClick={() =>
                          setTags((list) =>
                            active ? list.filter((item) => item !== tag) : [...list, tag],
                          )
                        }
                        className={`min-h-9 rounded-full border px-3 text-[11px] font-bold transition ${
                          active
                            ? "border-brand bg-brand-soft text-brand-dark"
                            : "border-line bg-surface text-ink-muted"
                        }`}
                      >
                        #{tag}
                      </button>
                    );
                  })}
                </div>
              </div>

              <button
                type="button"
                onClick={submit}
                disabled={!canSubmit}
                className="min-h-14 w-full rounded-2xl bg-brand text-base font-bold text-white transition active:scale-[0.99] disabled:bg-line disabled:text-ink-faint"
              >
                {meta?.label}（投稿者に通知）
              </button>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
