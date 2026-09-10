"use client";

import Link from "next/link";
import { Avatar, StatusBadge, TypeChip, UrgencyBadge, authorName } from "./Badges";
import { ReportImage } from "./ReportImage";
import { timeAgo } from "@/lib/format";
import { reportTypeOf } from "@/lib/labels";
import type { Report, User } from "@/lib/types";

export function ReportCard({
  report,
  author,
  href,
  now,
}: {
  report: Report;
  author: User | null;
  href: string;
  now: number;
}) {
  const likes = report.reactions.like.length + report.reactions.same.length;
  const replied = report.actions.length > 0;

  return (
    <Link
      href={href}
      className="card block overflow-hidden transition active:scale-[0.99] hover:border-brand-line"
    >
      <div className="flex gap-3 p-3">
        <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-xl bg-canvas">
          <ReportImage
            src={report.beforeImage}
            alt=""
            fallbackEmoji={reportTypeOf(report.type).emoji}
            className="h-full w-full object-cover"
          />
          {report.afterImage ? (
            <span className="absolute bottom-1 left-1 rounded-md bg-ink/85 px-1.5 py-0.5 text-[10px] font-bold text-white">
              Before / After
            </span>
          ) : null}
        </div>

        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            <StatusBadge status={report.status} />
            <UrgencyBadge urgency={report.urgency} />
            <TypeChip type={report.type} />
          </div>

          <h3 className="line-clamp-2 text-[15px] font-bold leading-snug text-ink">
            {report.title}
          </h3>

          <p className="mt-1 truncate text-xs text-ink-muted">📍 {report.area}</p>

          <div className="mt-2 flex items-center gap-2 text-[11px] text-ink-faint">
            <Avatar user={author} anonymous={report.anonymous} size={20} />
            <span className="truncate">{authorName(author, report.anonymous)}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0">{timeAgo(report.createdAt, now)}</span>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-line bg-canvas/60 px-3 py-2 text-[11px] font-bold text-ink-muted">
        <span>
          👍 {likes} 件の共感
        </span>
        <span className={replied ? "text-status-adopted" : "text-brand"}>
          {replied ? "💬 管理者から返信あり" : "返信待ち"}
        </span>
      </div>
    </Link>
  );
}
