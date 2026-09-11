import { reportTypeOf, statusOf, urgencyOf } from "@/lib/labels";
import type { ReportStatus, ReportType, Urgency, User } from "@/lib/types";

/**
 * ステータスは基本、丸＋グレーの文字で示す。
 * ただし「採用」「一部採用」だけは唯一の例外として、ハンコ風スタンプで
 * 押した瞬間のモチベが伝わるようにする
 */
export function StatusDot({
  status,
  size = "sm",
}: {
  status: ReportStatus;
  size?: "sm" | "lg";
}) {
  const meta = statusOf(status);
  // 採用が決まった瞬間と、改善が形になった瞬間だけハンコで見せる
  if (status === "adopted" || status === "partial" || status === "done") {
    return (
      <span
        role="img"
        aria-label={`${meta.label}スタンプ`}
        className={`stamp ${size === "lg" ? "stamp-lg" : "stamp-sm"}`}
      >
        {meta.label}
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-note text-ink-muted">
      <span aria-hidden className={`h-2 w-2 rounded-full ${meta.dot}`} />
      {meta.label}
    </span>
  );
}

/** 緊急度はカード左端の細い帯として表す（通常は表示しない） */
export function UrgencyBar({ urgency }: { urgency: Urgency }) {
  if (urgency === "normal") return null;
  return (
    <span
      aria-hidden
      className={`absolute inset-y-0 left-0 w-1 ${urgencyOf(urgency).bar}`}
    />
  );
}

export function UrgencyText({ urgency }: { urgency: Urgency }) {
  if (urgency === "normal") return null;
  const meta = urgencyOf(urgency);
  return <span className={`font-bold ${meta.text}`}>{meta.label}</span>;
}

export function typeText(type: ReportType) {
  const meta = reportTypeOf(type);
  return `${meta.emoji} ${meta.short}`;
}

export function Avatar({
  user,
  anonymous = false,
  size = 32,
}: {
  user: User | null;
  anonymous?: boolean;
  size?: number;
}) {
  const label = anonymous || !user ? "匿" : user.name.slice(0, 1);
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        background: anonymous || !user ? "#94a2b3" : user.color,
        fontSize: size * 0.44,
      }}
      className="grid shrink-0 place-items-center rounded-full font-bold text-white"
    >
      {label}
    </span>
  );
}

export function authorName(user: User | null, anonymous: boolean) {
  if (anonymous) return "匿名";
  return user?.name ?? "不明なユーザー";
}
