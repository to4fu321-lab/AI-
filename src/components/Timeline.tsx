import { actionOf } from "@/lib/labels";
import { formatDateTime } from "@/lib/format";
import type { Report, User } from "@/lib/types";

/**
 * 投稿から管理者アクションまでの流れ。
 * カードの入れ子はやめ、線と丸だけの素直なリストにしている。
 */
export function Timeline({ report, users }: { report: Report; users: User[] }) {
  const items = [
    {
      id: "posted",
      title: "報告しました",
      body: "",
      meta: formatDateTime(report.createdAt),
    },
    ...report.actions.map((action) => {
      const meta = actionOf(action.type);
      const actor = users.find((user) => user.id === action.actorId);
      const parts = [actor?.name ?? "管理者", formatDateTime(action.createdAt)];
      if (action.plannedDate) parts.push(`実施予定：${action.plannedDate}`);
      if (action.bonusPoints > 0) parts.push(`+${action.bonusPoints}pt`);
      return {
        id: action.id,
        title: `${meta.emoji} ${meta.pastLabel}`,
        body: action.comment,
        meta: parts.join("・"),
      };
    }),
  ];

  if (report.actions.length === 0) {
    items.push({
      id: "waiting",
      title: "担当者の確認待ちです",
      body: "内容にかかわらず、必ず返事があります",
      meta: "",
    });
  }

  return (
    <ol>
      {items.map((item, index) => {
        const last = index === items.length - 1;
        return (
          <li key={item.id} className={`relative pl-5 ${last ? "" : "pb-5"}`}>
            <span
              aria-hidden
              className="absolute left-0 top-[7px] h-2.5 w-2.5 rounded-full bg-ink-faint"
            />
            {last ? null : (
              <span
                aria-hidden
                className="absolute bottom-0 left-[4px] top-4 w-px bg-line"
              />
            )}
            <p className="text-body font-bold text-ink">{item.title}</p>
            {item.body ? (
              <p className="mt-0.5 whitespace-pre-wrap text-body text-ink-muted">{item.body}</p>
            ) : null}
            {item.meta ? <p className="mt-0.5 text-note text-ink-faint">{item.meta}</p> : null}
          </li>
        );
      })}
    </ol>
  );
}
