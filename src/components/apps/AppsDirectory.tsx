"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { Access, AppEntry } from "@/data/apps";
import { lockAll } from "@/app/unlock/actions";

export type ListedApp = AppEntry & { isNew: boolean; locked: boolean };

const SECTIONS: { access: Access; title: string; note: string }[] = [
  { access: "public", title: "公開アプリ", note: "誰でも使えます" },
  { access: "sale", title: "個人販売", note: "購入された方はパスワードで開けます" },
  { access: "ezoshirube", title: "エゾシルベ", note: "メンバー専用" },
  { access: "private", title: "自分専用", note: "管理者だけに表示されています" },
];

export function AppsDirectory({
  apps,
  unlocked,
}: {
  apps: ListedApp[];
  unlocked: { ezoshirube: boolean; owner: boolean };
}) {
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState<string | null>(null);

  const tags = useMemo(() => [...new Set(apps.flatMap((a) => a.tags))], [apps]);
  const q = query.trim().toLowerCase();
  const filtering = !!q || !!tag;
  const visible = apps.filter(
    (a) =>
      (!tag || a.tags.includes(tag)) &&
      (!q || `${a.name} ${a.description} ${a.tags.join(" ")}`.toLowerCase().includes(q)),
  );
  const signedIn = unlocked.ezoshirube || unlocked.owner || apps.some((a) => a.access === "sale" && !a.locked);

  return (
    <div className="min-h-screen bg-neutral-50 pb-16 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="mx-auto max-w-5xl px-4 pb-2 pt-[max(1.5rem,env(safe-area-inset-top))]">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs font-bold tracking-widest text-fuchsia-500">MY APPS</p>
            <h1 className="mt-1 text-2xl font-black tracking-tight">アプリ一覧</h1>
          </div>
          {signedIn && (
            <form action={lockAll}>
              <button type="submit" className="rounded-full bg-neutral-200/70 px-3 py-1.5 text-xs font-semibold text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                🔒 鍵をかける
              </button>
            </form>
          )}
        </div>

        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="アプリを探す"
          className="mt-4 w-full rounded-full border border-neutral-200 bg-white px-4 py-2.5 text-[16px] outline-none focus:border-fuchsia-400 dark:border-neutral-700 dark:bg-neutral-900"
        />
        <div className="mt-3 flex gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {[null, ...tags].map((t) => (
            <button
              key={t ?? "all"}
              type="button"
              onClick={() => setTag(t)}
              className={`shrink-0 rounded-full px-3.5 py-1.5 text-xs font-bold transition ${
                tag === t
                  ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
                  : "bg-neutral-200/70 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
              }`}
            >
              {t ?? "すべて"}
            </button>
          ))}
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4">
        {SECTIONS.map((section) => {
          const list = visible.filter((a) => a.access === section.access);
          const isMembers = section.access === "ezoshirube";
          const isOwner = section.access === "private";
          // 自分専用は、鍵が開いているときだけ見出しごと表示する
          if (isOwner && !unlocked.owner) return null;
          // 絞り込み中は、該当なしの見出しを出さない
          if (filtering && list.length === 0) return null;
          if (!isMembers && list.length === 0) return null;
          return (
            <section key={section.access} className="mt-6">
              <h2 className="flex items-baseline gap-2">
                <span className="text-base font-black">{section.title}</span>
                <span className="text-xs text-neutral-400">{section.note}</span>
              </h2>
              {isMembers && !unlocked.ezoshirube ? (
                <Link
                  href="/unlock?key=ezoshirube&next=%2Fapps"
                  className="mt-2 flex items-center gap-3 rounded-2xl border border-dashed border-neutral-300 bg-white p-4 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                >
                  <span className="text-2xl">🔒</span>
                  <span className="flex-1">
                    <span className="block font-bold">メンバーの方はこちら</span>
                    <span className="text-xs text-neutral-500">パスワードを入れるとアプリが表示されます</span>
                  </span>
                  <span className="text-neutral-400">›</span>
                </Link>
              ) : list.length === 0 ? (
                <p className="mt-2 text-sm text-neutral-400">まだアプリはありません</p>
              ) : (
                <ul className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {list.map((app) => (
                    <li key={app.slug}>
                      <AppCard app={app} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
        {filtering && visible.length === 0 && <p className="mt-10 text-center text-sm text-neutral-400">見つかりませんでした</p>}

        {!unlocked.owner && (
          <p className="mt-12 text-center">
            <Link href="/unlock?key=private&next=%2Fapps" className="text-[11px] text-neutral-300 dark:text-neutral-700">
              管理者
            </Link>
          </p>
        )}
      </main>
    </div>
  );
}

function AppCard({ app }: { app: ListedApp }) {
  const external = /^https?:\/\//.test(app.href);
  const className =
    "flex h-full flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm transition active:scale-[0.98] hover:shadow-md dark:border-neutral-800 dark:bg-neutral-900";
  const body = (
    <>
      <div className={`relative flex h-24 items-center justify-center bg-gradient-to-br text-5xl ${app.color}`}>
        <span className="drop-shadow">{app.emoji}</span>
        {app.locked && (
          <span className="absolute right-2 top-2 rounded-full bg-black/40 px-2 py-0.5 text-[11px] font-bold text-white backdrop-blur">
            🔒 パスワード
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col p-4">
        <div className="flex items-center gap-2">
          <h3 className="text-base font-black">{app.name}</h3>
          {app.isNew && <span className="rounded bg-fuchsia-500 px-1.5 py-0.5 text-[10px] font-bold text-white">NEW</span>}
          {app.status === "beta" && (
            <span className="rounded bg-amber-400 px-1.5 py-0.5 text-[10px] font-bold text-amber-950">試作</span>
          )}
        </div>
        <p className="mt-1.5 flex-1 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">{app.description}</p>
        <div className="mt-3 flex items-center justify-between text-[11px] text-neutral-400">
          <span className="flex flex-wrap gap-1">
            {app.tags.map((t) => (
              <span key={t} className="rounded-full bg-neutral-100 px-2 py-0.5 dark:bg-neutral-800">
                {t}
              </span>
            ))}
          </span>
          <span>{app.addedAt.replaceAll("-", ".")}</span>
        </div>
      </div>
    </>
  );
  return external ? (
    <a href={app.href} target="_blank" rel="noopener noreferrer" className={className}>
      {body}
    </a>
  ) : (
    // 鍵付きアプリはそのまま開こうとすると門番（proxy）がパスワード画面へ案内する
    <Link href={app.href} prefetch={!app.locked} className={className}>
      {body}
    </Link>
  );
}
