import { reportTypeOf, statusOf, urgencyOf } from "@/lib/labels";
import type { ReportStatus, ReportType, Urgency, User } from "@/lib/types";

export function StatusBadge({ status }: { status: ReportStatus }) {
  const meta = statusOf(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold ${meta.className}`}
    >
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
      {meta.label}
    </span>
  );
}

export function UrgencyBadge({ urgency }: { urgency: Urgency }) {
  if (urgency === "normal") return null;
  const meta = urgencyOf(urgency);
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-bold ${meta.className}`}
    >
      {urgency === "danger" ? "⚠️" : "⏱"} {meta.label}
    </span>
  );
}

export function TypeChip({ type }: { type: ReportType }) {
  const meta = reportTypeOf(type);
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-canvas px-2.5 py-1 text-[11px] font-bold text-ink-muted">
      <span aria-hidden>{meta.emoji}</span>
      {meta.short}
    </span>
  );
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
        background: anonymous || !user ? "#93a1b3" : user.color,
        fontSize: size * 0.44,
      }}
      className="grid shrink-0 place-items-center rounded-full font-bold text-white"
    >
      {label}
    </span>
  );
}

export function authorName(user: User | null, anonymous: boolean) {
  if (anonymous) return "匿名で投稿";
  return user?.name ?? "不明なユーザー";
}
