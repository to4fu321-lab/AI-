"use client";

import Link from "next/link";
import { useMemo } from "react";
import { EmptyState, LoadingBlock } from "@/components/EmptyState";
import { NoticeBody } from "@/components/NoticeBody";
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

/**
 * 1件の連絡。上から順に、何の連絡か → 要点 → 誰がいつ → 操作、と優先度が下がる。
 * 立ったまま数秒見るだけでも、タイトルと箇条書きだけで用が足りることを狙っている
 */
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
      className={`card p-4 ${read ? "" : "border-brand"}`}
      aria-label={read ? undefined : "未読のお知らせ"}
    >
      {/* 何の連絡かを最初に置く。スクロール中に見失わないよう追従も試したが、
          タイトルが本文を覆って画面を圧迫するのでやめた。
          箇条書きを切り出して本文が短くなり、追従させる必要自体が減っている */}
      <h2 className="text-title text-ink">{notice.title}</h2>

      <div className="mb-2.5 mt-1.5 flex flex-wrap items-center gap-1.5">
        {read ? null : (
          <span className="tag border-brand bg-brand text-white">
            <span aria-hidden>🔔</span> 新着
          </span>
        )}
        <span className={`tag ${category.tone} bg-canvas text-ink`}>
          <span aria-hidden>{category.emoji}</span> {category.label}
        </span>
      </div>

      <NoticeBody body={notice.body} />

      <p className="mt-3 text-note text-ink-faint">
        {authorName} より・{formatDateTime(notice.createdAt)}
      </p>

      {notice.reportId ? (
        <Link href={`/report/${notice.reportId}`} className="btn-link-row mt-2.5">
          <span aria-hidden>📄</span>
          もとになった報告を見る
          <span aria-hidden className="ml-auto">
            →
          </span>
        </Link>
      ) : null}

      {read ? (
        <p className="btn btn-outline mt-2.5 w-full border-dot-adopted text-dot-adopted">
          <span aria-hidden>✓</span> 確認済み
        </p>
      ) : (
        <button
          type="button"
          onClick={() => markNoticeRead(notice.id)}
          className="btn btn-lg btn-primary mt-2.5"
        >
          確認しました
        </button>
      )}
    </article>
  );
}
