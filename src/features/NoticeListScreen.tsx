"use client";

import Link from "next/link";
import { useMemo } from "react";
import { EmptyState, LoadingBlock } from "@/components/EmptyState";
import { formatDateTime } from "@/lib/format";
import { noticeCategoryOf } from "@/lib/labels";
import { markNoticeRead, noticesFor, useDemoState } from "@/lib/store";
import type { Notice } from "@/lib/types";

/**
 * 現場が受け取る連絡の一覧。
 * 詳細ページに飛ばさず、この1画面で全文が読めるようにしている
 */
export function NoticeListScreen() {
  const demo = useDemoState();
  const me = demo?.users.find((user) => user.id === demo.staffUserId) ?? null;

  const notices = useMemo(
    () => (demo && me ? noticesFor(demo, me) : []),
    [demo, me],
  );

  if (!demo || !me) return <LoadingBlock />;

  const unread = notices.filter((notice) => !notice.readBy.includes(me.id));

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-title text-ink">お知らせ</h1>
        <p className="text-note text-ink-muted">
          {unread.length > 0
            ? `${me.site}から ${unread.length}件の新しい連絡があります`
            : `${me.site}からの連絡です`}
        </p>
      </header>

      {notices.length === 0 ? (
        <EmptyState emoji="📭" title="お知らせはまだありません" />
      ) : (
        <ul className="space-y-2.5">
          {notices.map((notice) => (
            <li key={notice.id}>
              <NoticeCard
                notice={notice}
                read={notice.readBy.includes(me.id)}
                authorName={
                  demo.users.find((user) => user.id === notice.authorId)?.name ?? "管理者"
                }
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NoticeCard({
  notice,
  read,
  authorName,
}: {
  notice: Notice;
  read: boolean;
  authorName: string;
}) {
  const category = noticeCategoryOf(notice.category);

  return (
    <article
      className={`card overflow-hidden p-4 ${read ? "" : "border-brand"}`}
      aria-label={read ? undefined : "未読のお知らせ"}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <span className="rounded-full border border-line bg-canvas px-2 py-0.5 text-note font-bold text-ink-muted">
          <span aria-hidden>{category.emoji}</span> {category.label}
        </span>
        {read ? null : (
          <span className="rounded-full bg-brand px-2 py-0.5 text-note font-bold text-white">
            新着
          </span>
        )}
        <span className="ml-auto text-note text-ink-faint">
          {formatDateTime(notice.createdAt)}
        </span>
      </div>

      <h2 className="text-head text-ink">{notice.title}</h2>
      <p className="mt-1.5 whitespace-pre-wrap text-body text-ink">{notice.body}</p>

      <p className="mt-3 text-note text-ink-faint">{authorName} より</p>

      {notice.reportId ? (
        <Link
          href={`/report/${notice.reportId}`}
          className="mt-1 inline-flex min-h-11 items-center text-note font-bold text-brand"
        >
          もとになった報告を見る →
        </Link>
      ) : null}

      {read ? (
        <p className="mt-2 text-note font-bold text-dot-adopted">✓ 確認ずみ</p>
      ) : (
        <button
          type="button"
          onClick={() => markNoticeRead(notice.id)}
          className="mt-2 min-h-12 w-full rounded-full bg-brand text-body font-bold text-white transition active:scale-[0.99]"
        >
          確認しました
        </button>
      )}
    </article>
  );
}
