"use client";

import Link from "next/link";
import { EmptyState, LoadingBlock } from "@/components/EmptyState";
import { NewReportScreen } from "@/features/NewReportScreen";
import { useDemoState } from "@/lib/store";

export function EditReportScreen({ id }: { id: string }) {
  const demo = useDemoState();
  if (!demo) return <LoadingBlock />;

  const report = demo.reports.find((item) => item.id === id);
  if (!report) {
    return (
      <div className="space-y-4">
        <EmptyState emoji="🔍" title="報告が見つかりませんでした" />
        <Link href="/" className="block text-center text-body font-bold text-brand">
          フィードにもどる
        </Link>
      </div>
    );
  }

  if (report.authorId !== demo.staffUserId) {
    return (
      <div className="space-y-4">
        <EmptyState
          emoji="🔒"
          title="この投稿は編集できません"
          description="自分の投稿だけ修正・取り消しができます"
        />
        <Link
          href={`/report/${id}`}
          className="block text-center text-body font-bold text-brand"
        >
          投稿にもどる
        </Link>
      </div>
    );
  }

  return <NewReportScreen editReport={report} />;
}
