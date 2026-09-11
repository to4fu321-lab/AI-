"use client";

import Link from "next/link";
import { useState } from "react";
import { Avatar, StatusDot, UrgencyText, authorName, typeText } from "@/components/Badges";
import { BeforeAfterSlider } from "@/components/BeforeAfterSlider";
import { EmptyState, LoadingBlock } from "@/components/EmptyState";
import { ImprovementStory } from "@/components/ImprovementStory";
import { ReportImage } from "@/components/ReportImage";
import { Timeline } from "@/components/Timeline";
import { formatDateTime } from "@/lib/format";
import {
  ACTIONS,
  DECLINE_REASONS,
  SHARE_OPTIONS,
  actionOf,
  nextActionsFor,
} from "@/lib/labels";
import { addAdminAction, toggleShare, useDemoState } from "@/lib/store";
import type { DecisionActionType } from "@/lib/types";

export function AdminReportScreen({ id }: { id: string }) {
  const demo = useDemoState();
  const [selected, setSelected] = useState<DecisionActionType | null>(null);
  const [comment, setComment] = useState("");
  const [plannedDate, setPlannedDate] = useState("");
  const [done, setDone] = useState("");

  if (!demo) return <LoadingBlock />;

  const report = demo.reports.find((item) => item.id === id);
  if (!report) {
    return (
      <div className="space-y-4">
        <EmptyState emoji="🔍" title="報告が見つかりませんでした" />
        <Link href="/admin" className="block text-center text-body font-bold text-brand">
          ダッシュボードにもどる
        </Link>
      </div>
    );
  }

  const author = demo.users.find((user) => user.id === report.authorId) ?? null;
  const allowed = nextActionsFor(report.status);
  const availableActions = ACTIONS.filter((action) => allowed.includes(action.value));
  const meta = selected ? actionOf(selected) : null;
  const needsComment = meta?.requiresComment ?? false;
  const canSubmit = selected !== null && (!needsComment || comment.trim().length > 0);

  const notify = (message: string) => {
    setDone(message);
    window.setTimeout(() => setDone(""), 2600);
  };

  const submit = () => {
    if (!selected || !canSubmit) return;
    addAdminAction(report.id, selected, comment, {
      plannedDate: selected === "adopted" || selected === "partial" ? plannedDate : undefined,
    });
    setSelected(null);
    setComment("");
    setPlannedDate("");
    notify("投稿者に通知しました");
  };

  return (
    <div className="space-y-5">
      <Link
        href="/admin"
        className="inline-flex min-h-11 items-center text-body font-bold text-ink-muted"
      >
        ← ダッシュボード
      </Link>

      <div className="grid gap-5 md:grid-cols-[1.1fr_1fr] md:items-start">
        <div className="space-y-5">
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
            {report.body ? (
              <p className="mt-3 whitespace-pre-wrap text-body text-ink-muted">{report.body}</p>
            ) : null}

            {report.rawNote ? (
              <details className="mt-3 rounded-lg border border-line bg-canvas p-3">
                <summary className="cursor-pointer text-note font-bold text-ink-muted">
                  現場が書いた元のメモを見る
                </summary>
                <p className="mt-2 whitespace-pre-wrap text-body text-ink">{report.rawNote}</p>
              </details>
            ) : null}

            <div className="mt-4 flex items-center gap-2">
              <Avatar user={author} anonymous={report.anonymous} size={28} />
              <p className="text-note text-ink-muted">
                {authorName(author, report.anonymous)}
                {author && !report.anonymous ? `（${author.team}）` : ""}・
                {formatDateTime(report.createdAt)}
              </p>
              {report.reactions.like.length + report.reactions.same.length > 0 ? (
                <p className="mt-1 text-note font-bold text-ink">
                  👥 {report.reactions.like.length + report.reactions.same.length}人が同じ課題を感じています
                </p>
              ) : null}
            </div>
          </section>

          <ImprovementStory report={report} />

          <section className="card p-4">
            <h2 className="mb-3 text-head text-ink">対応の記録</h2>
            <Timeline report={report} users={demo.users} />
          </section>
        </div>

        <div className="space-y-4 md:sticky md:top-20">
          <section className="card p-4">
            <h2 className="text-head text-ink">対応する</h2>
            <p className="mb-3 text-note text-ink-muted">
              どれを選んでも投稿者に通知されます
            </p>

            {done ? (
              <p className="mb-3 animate-pop text-note font-bold text-dot-adopted">✅ {done}</p>
            ) : null}

            <div className="grid gap-1.5">
              {availableActions.map((action) => {
                const active = selected === action.value;
                return (
                  <div key={action.value}>
                    <button
                      type="button"
                      onClick={() => setSelected(active ? null : action.value)}
                      aria-pressed={active}
                      className={`flex min-h-12 w-full items-center gap-2 rounded-lg border px-3 text-body font-bold transition ${
                        active
                          ? "border-brand bg-brand-soft text-brand-dark"
                          : "border-line text-ink"
                      }`}
                    >
                      <span aria-hidden>{action.emoji}</span>
                      <span className="flex-1 text-left">{action.label}</span>
                      {action.points > 0 ? (
                        <span className="text-note text-ink-muted">+{action.points}pt</span>
                      ) : null}
                    </button>

                    {active ? (
                      <div className="mt-2 space-y-2">
                        <p className="text-note text-ink-muted">{action.description}</p>
                        {action.value === "declined" ? (
                          <div className="flex flex-wrap gap-1.5">
                            {DECLINE_REASONS.map((reason) => (
                              <button
                                key={reason}
                                type="button"
                                onClick={() =>
                                  setComment((current) =>
                                    current ? `${current}\n${reason}：` : `${reason}：`,
                                  )
                                }
                                className="rounded-full border border-line bg-surface px-2.5 py-1 text-note font-bold text-ink-muted transition active:scale-95"
                              >
                                {reason}
                              </button>
                            ))}
                          </div>
                        ) : null}
                        <textarea
                          value={comment}
                          onChange={(event) => setComment(event.target.value)}
                          rows={4}
                          placeholder={
                            action.value === "declined"
                              ? "見送る理由を、次につながる言葉で（必須）"
                              : action.value === "done"
                                ? "改善後どう変わりましたか？（例：探す時間が減った・通路が広くなった）（必須）"
                                : action.requiresComment
                                  ? "修正した内容を伝えてください（必須）"
                                  : "ひとことコメント（任意）"
                          }
                          className="w-full rounded-lg border border-line bg-canvas p-3 text-body text-ink outline-none focus:border-brand"
                        />
                        {action.value === "adopted" || action.value === "partial" ? (
                          <input
                            value={plannedDate}
                            onChange={(event) => setPlannedDate(event.target.value)}
                            placeholder="実施予定（例：今月末までに全通路）"
                            className="min-h-11 w-full rounded-lg border border-line bg-canvas px-3 text-body text-ink outline-none focus:border-brand"
                          />
                        ) : null}
                        <button
                          type="button"
                          onClick={submit}
                          disabled={!canSubmit}
                          className="min-h-12 w-full rounded-full bg-brand text-body font-bold text-white transition active:scale-[0.99] disabled:bg-line disabled:text-ink-faint"
                        >
                          この内容で通知する
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>

          <section className="card p-4">
            <h2 className="text-head text-ink">広げる</h2>
            <p className="mb-3 text-note text-ink-muted">
              良い改善は1拠点で終わらせない。対応と同時でも、あとからでも押せます
            </p>
            <div className="grid gap-1.5">
              {SHARE_OPTIONS.map((option) => {
                const on =
                  option.value === "share_sites" ? report.sharedToSites : report.sharedToHq;
                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={on}
                    onClick={() => {
                      toggleShare(report.id, option.value);
                      notify(on ? `${option.shortLabel}を解除しました` : `${option.shortLabel}しました`);
                    }}
                    className={`flex min-h-12 w-full items-center gap-2 rounded-lg border px-3 text-body font-bold transition ${
                      on ? "border-brand bg-brand-soft text-brand-dark" : "border-line text-ink"
                    }`}
                  >
                    <span aria-hidden>{option.emoji}</span>
                    <span className="flex-1 text-left">
                      {on ? `${option.shortLabel}ずみ` : option.label}
                    </span>
                    <span className="text-note text-ink-muted">
                      {on ? "解除" : `+${option.points}pt`}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
