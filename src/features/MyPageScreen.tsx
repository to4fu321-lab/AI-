"use client";

import { useState } from "react";
import { Avatar } from "@/components/Badges";
import { DemoNote } from "@/components/DemoNote";
import { EmptyState, LoadingBlock } from "@/components/EmptyState";
import { LevelProgress } from "@/components/LevelProgress";
import { ReportCard } from "@/components/ReportCard";
import {
  badgesOf,
  monthlyRanking,
  streakBonus,
  userPoints,
  userReports,
} from "@/lib/points";
import { resetDemo, setStaffUser, useDemoState } from "@/lib/store";
import { useNow } from "@/lib/useNow";

export function MyPageScreen() {
  const demo = useDemoState();
  const now = useNow();
  const [resetting, setResetting] = useState(false);

  if (!demo) return <LoadingBlock />;

  const me = demo.users.find((user) => user.id === demo.staffUserId);
  if (!me) return <EmptyState title="ユーザーが見つかりません" />;

  const mine = userReports(me.id, demo.reports);
  const points = userPoints(me.id, demo.reports);
  const badges = badgesOf(me.id, demo.reports);
  const staffIds = demo.users.filter((user) => user.role === "staff").map((user) => user.id);
  const ranking = monthlyRanking(staffIds, demo.reports, now);
  const bonus = streakBonus(mine);

  return (
    <div className="space-y-4">
      <section className="card p-4">
        <div className="flex items-center gap-3">
          <Avatar user={me} size={52} />
          <div className="min-w-0">
            <p className="text-lg font-bold text-ink">{me.name}</p>
            <p className="text-xs text-ink-muted">{me.team}</p>
          </div>
        </div>
        <div className="mt-4">
          <LevelProgress points={points} />
        </div>
        {bonus > 0 ? (
          <p className="mt-3 rounded-xl bg-brand-soft px-3 py-2 text-[11px] font-bold text-brand-dark">
            🔥 週3件の連続報告ボーナス +{bonus}pt を獲得しています
          </p>
        ) : null}
      </section>

      <section className="card p-4">
        <h2 className="mb-3 text-sm font-bold text-ink">バッジ</h2>
        <ul className="grid grid-cols-3 gap-2">
          {badges.map((badge) => (
            <li
              key={badge.id}
              className={`flex flex-col items-center gap-1 rounded-xl border p-3 text-center ${
                badge.earned
                  ? "border-brand-line bg-brand-soft"
                  : "border-line bg-canvas opacity-50"
              }`}
            >
              <span aria-hidden className={`text-2xl ${badge.earned ? "" : "grayscale"}`}>
                {badge.emoji}
              </span>
              <span className="text-[11px] font-bold leading-tight text-ink">{badge.name}</span>
              <span className="text-[10px] leading-tight text-ink-muted">
                {badge.description}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card p-4">
        <h2 className="mb-1 text-sm font-bold text-ink">今月のランキング</h2>
        <p className="mb-3 text-[11px] text-ink-muted">
          「たくさん出した人」ではなく「気づいた人」を称えるための、ゆるい順位です
        </p>
        <ol className="space-y-1.5">
          {ranking.map((row) => {
            const user = demo.users.find((item) => item.id === row.userId) ?? null;
            const isMe = row.userId === me.id;
            return (
              <li
                key={row.userId}
                className={`flex items-center gap-3 rounded-xl px-3 py-2 ${
                  isMe ? "bg-brand-soft" : "bg-canvas"
                }`}
              >
                <span
                  className={`w-6 shrink-0 text-center text-sm font-black ${
                    row.rank <= 3 ? "text-brand" : "text-ink-faint"
                  }`}
                >
                  {row.rank}
                </span>
                <Avatar user={user} size={28} />
                <span className="min-w-0 flex-1 truncate text-sm font-bold text-ink">
                  {user?.name}
                  {isMe ? <span className="ml-1 text-[11px] text-brand">（自分）</span> : null}
                </span>
                <span className="shrink-0 text-xs text-ink-muted">{row.count}件</span>
                <span className="w-14 shrink-0 text-right text-sm font-bold tabular-nums text-ink">
                  {row.points}pt
                </span>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-bold text-ink">自分の報告（{mine.length}件）</h2>
        {mine.length === 0 ? (
          <EmptyState title="まだ報告がありません" description="小さな気づきから始めましょう" />
        ) : (
          [...mine]
            .sort((a, b) => b.createdAt - a.createdAt)
            .map((report) => (
              <ReportCard
                key={report.id}
                report={report}
                author={me}
                href={`/report/${report.id}`}
                now={now}
              />
            ))
        )}
      </section>

      <section className="card p-4">
        <h2 className="mb-2 text-sm font-bold text-ink">デモ設定</h2>
        <label className="block">
          <span className="mb-1 block text-xs text-ink-muted">
            現場スタッフとしてログインする人を切り替える
          </span>
          <select
            value={me.id}
            onChange={(event) => setStaffUser(event.target.value)}
            className="min-h-12 w-full rounded-xl border border-line bg-canvas px-3 text-sm text-ink"
          >
            {demo.users
              .filter((user) => user.role === "staff")
              .map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}（{user.team}）
                </option>
              ))}
          </select>
        </label>
        <button
          type="button"
          onClick={async () => {
            setResetting(true);
            await resetDemo();
            setResetting(false);
          }}
          className="mt-3 min-h-12 w-full rounded-xl border border-line text-sm font-bold text-ink-muted"
        >
          {resetting ? "リセット中…" : "デモを初期状態にもどす"}
        </button>
      </section>

      <DemoNote />
    </div>
  );
}
