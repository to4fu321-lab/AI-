"use client";

import { useState } from "react";
import { Avatar } from "@/components/Badges";
import { DemoNote } from "@/components/DemoNote";
import { EmptyState, LoadingBlock } from "@/components/EmptyState";
import { LevelProgress } from "@/components/LevelProgress";
import { ReportCard } from "@/components/ReportCard";
import { ACCEPTED_STATUSES, FINISHED_STATUSES } from "@/lib/labels";
import { badgesOf, monthlyRanking, userPoints, userReports } from "@/lib/points";
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
  const adopted = mine.filter((r) => ACCEPTED_STATUSES.includes(r.status)).length;
  const improved = mine.filter((r) => FINISHED_STATUSES.includes(r.status)).length;
  const badges = badgesOf(me.id, demo.reports);
  const staffIds = demo.users.filter((user) => user.role === "staff").map((user) => user.id);
  const ranking = monthlyRanking(staffIds, demo.reports, now);
  const myRank = ranking.find((row) => row.userId === me.id);
  const visibleRanking = ranking
    .slice(0, 3)
    .concat(myRank && myRank.rank > 3 ? [myRank] : []);

  return (
    <div className="space-y-5">
      <section className="card p-4">
        <div className="mb-4 flex items-center gap-3">
          <Avatar user={me} size={44} />
          <div className="min-w-0">
            <p className="text-head text-ink">{me.name}</p>
            <p className="text-note text-ink-muted">
              {me.site}・{me.team}
            </p>
          </div>
        </div>

        <LevelProgress points={userPoints(me.id, demo.reports)} />

        <dl className="mt-4 grid grid-cols-3 gap-2 border-t border-line pt-3 text-center">
          <div>
            <dt className="text-note text-ink-muted">報告した</dt>
            <dd className="text-head text-ink">{mine.length}件</dd>
          </div>
          <div>
            <dt className="text-note text-ink-muted">採用された</dt>
            <dd className="text-head text-ink">{adopted}件</dd>
          </div>
          <div>
            <dt className="text-note text-ink-muted">改善された</dt>
            <dd className="text-head text-dot-adopted">{improved}件</dd>
          </div>
        </dl>
      </section>

      <section className="card p-4">
        <h2 className="mb-3 text-head text-ink">バッジ</h2>
        <ul className="grid grid-cols-3 gap-2">
          {badges.map((badge) => (
            <li
              key={badge.id}
              title={badge.description}
              className={`flex flex-col items-center gap-1 rounded-lg py-3 text-center ${
                badge.earned ? "bg-brand-soft" : "bg-canvas opacity-45"
              }`}
            >
              <span aria-hidden className={`text-xl ${badge.earned ? "" : "grayscale"}`}>
                {badge.emoji}
              </span>
              <span className="text-note font-bold text-ink">{badge.name}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card p-4">
        <h2 className="mb-3 text-head text-ink">今月のランキング</h2>
        <ol className="space-y-1">
          {visibleRanking.map((row) => {
            const user = demo.users.find((item) => item.id === row.userId) ?? null;
            const isMe = row.userId === me.id;
            return (
              <li
                key={row.userId}
                className={`flex items-center gap-3 rounded-lg px-2 py-2 ${
                  isMe ? "bg-brand-soft" : ""
                }`}
              >
                <span className="w-5 shrink-0 text-center text-body font-bold text-ink-faint">
                  {row.rank}
                </span>
                <Avatar user={user} size={24} />
                <span className="min-w-0 flex-1 truncate text-body text-ink">{user?.name}</span>
                <span className="shrink-0 text-note font-bold tabular-nums text-ink">
                  {row.points}pt
                </span>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="space-y-2.5">
        <h2 className="text-head text-ink">自分の報告（{mine.length}件）</h2>
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

      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 pt-2 text-note text-ink-faint">
        <label className="flex items-center gap-1.5">
          ログイン中：
          <select
            value={me.id}
            onChange={(event) => setStaffUser(event.target.value)}
            aria-label="デモ用にログインするスタッフを切り替える"
            className="min-h-9 rounded-lg border border-line bg-surface px-2 text-note text-ink"
          >
            {demo.users
              .filter((user) => user.role === "staff")
              .map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}（{user.site}）
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
          className="min-h-9 underline"
        >
          {resetting ? "リセット中…" : "デモを初期状態にもどす"}
        </button>
      </div>

      <DemoNote />
    </div>
  );
}
