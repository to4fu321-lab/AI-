import { Avatar } from "./Badges";
import { actionOf } from "@/lib/labels";
import { formatDateTime } from "@/lib/format";
import type { Report, User } from "@/lib/types";

/** 投稿から管理者アクションまでの流れ。「必ず返事がある」ことを可視化する */
export function Timeline({
  report,
  users,
}: {
  report: Report;
  users: User[];
}) {
  const findUser = (id: string) => users.find((user) => user.id === id) ?? null;

  return (
    <ol className="space-y-3">
      <li className="flex gap-3">
        <TimelineDot emoji="📮" />
        <div className="flex-1 pb-1">
          <p className="text-sm font-bold text-ink">報告しました</p>
          <p className="text-[11px] text-ink-faint">{formatDateTime(report.createdAt)}</p>
        </div>
      </li>

      {report.actions.map((action) => {
        const meta = actionOf(action.type);
        const actor = findUser(action.actorId);
        return (
          <li key={action.id} className="flex gap-3">
            <TimelineDot emoji={meta.emoji} />
            <div className="flex-1">
              <div className="card p-3">
                <div className="mb-1.5 flex items-center gap-2">
                  <Avatar user={actor} size={22} />
                  <span className="text-xs font-bold text-ink">{actor?.name ?? "管理者"}</span>
                  <span className="rounded-full bg-canvas px-2 py-0.5 text-[10px] font-bold text-ink-muted">
                    {meta.pastLabel}
                  </span>
                </div>
                {action.comment ? (
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">
                    {action.comment}
                  </p>
                ) : null}
                {action.plannedDate ? (
                  <p className="mt-2 rounded-lg bg-canvas px-2 py-1 text-[11px] font-bold text-ink-muted">
                    🗓 実施予定：{action.plannedDate}
                  </p>
                ) : null}
                {action.tags?.length ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {action.tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full border border-brand-line bg-brand-soft px-2 py-0.5 text-[10px] font-bold text-brand-dark"
                      >
                        #{tag}
                      </span>
                    ))}
                  </div>
                ) : null}
                {action.bonusPoints > 0 ? (
                  <p className="mt-2 text-[11px] font-bold text-brand">
                    投稿者に +{action.bonusPoints}pt
                  </p>
                ) : null}
              </div>
              <p className="mt-1 text-[11px] text-ink-faint">
                {formatDateTime(action.createdAt)}
              </p>
            </div>
          </li>
        );
      })}

      {report.actions.length === 0 ? (
        <li className="flex gap-3">
          <TimelineDot emoji="⏳" muted />
          <div className="flex-1">
            <p className="text-sm font-bold text-ink-muted">担当者の確認待ちです</p>
            <p className="text-[11px] text-ink-faint">
              内容にかかわらず、必ず何らかの返事があります
            </p>
          </div>
        </li>
      ) : null}
    </ol>
  );
}

function TimelineDot({ emoji, muted = false }: { emoji: string; muted?: boolean }) {
  return (
    <div className="flex flex-col items-center">
      <span
        aria-hidden
        className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-sm ${
          muted ? "bg-canvas" : "bg-brand-soft"
        }`}
      >
        {emoji}
      </span>
      <span aria-hidden className="mt-1 w-px flex-1 bg-line" />
    </div>
  );
}
