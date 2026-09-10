"use client";

import Link from "next/link";
import { StatusDot, UrgencyBar, authorName, typeText } from "./Badges";
import { ReportImage } from "./ReportImage";
import { timeAgo } from "@/lib/format";
import { reportTypeOf } from "@/lib/labels";
import type { Report, User } from "@/lib/types";

/**
 * 1カードの要素は4つだけ（緊急度の帯・タイトル・補助1行・ステータス）。
 * 情報を足したくなったら、まず何かを削れないか考えること。
 */
export function ReportCard({
  report,
  author,
  href,
  now,
  /** 他拠点から共有されてきた事例として表示する */
  fromOtherSite = false,
}: {
  report: Report;
  author: User | null;
  href: string;
  now: number;
  fromOtherSite?: boolean;
}) {
  const reactions = report.reactions.like.length + report.reactions.same.length;
  const meta = [
    typeText(report.type),
    authorName(author, report.anonymous),
    timeAgo(report.createdAt, now),
  ];
  if (reactions > 0) meta.push(`👍 ${reactions}`);

  return (
    <Link
      href={href}
      className="card relative flex gap-3 overflow-hidden p-3 transition active:bg-canvas"
    >
      <UrgencyBar urgency={report.urgency} />

      <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-canvas">
        <ReportImage
          src={report.beforeImage}
          alt=""
          fallbackEmoji={reportTypeOf(report.type).emoji}
          className="h-full w-full object-cover"
        />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <h3 className="line-clamp-2 text-head text-ink">{report.title}</h3>
          <StatusDot status={report.status} />
        </div>
        <p className="mt-1 truncate text-note text-ink-muted">{meta.join("・")}</p>
        {fromOtherSite ? (
          <p className="mt-0.5 truncate text-note text-ink-faint">
            🏢 {report.site}の事例
          </p>
        ) : null}
      </div>
    </Link>
  );
}
