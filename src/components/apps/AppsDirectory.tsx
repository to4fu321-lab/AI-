"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { AppEntry } from "@/data/apps";

export function AppsDirectory({ apps }: { apps: (AppEntry & { isNew: boolean })[] }) {
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState<string | null>(null);

  const tags = useMemo(() => [...new Set(apps.flatMap((a) => a.tags))], [apps]);
  const q = query.trim().toLowerCase();
  const visible = apps.filter(
    (a) =>
      (!tag || a.tags.includes(tag)) &&
      (!q || `${a.name} ${a.description} ${a.tags.join(" ")}`.toLowerCase().includes(q)),
  );

  return (
    <div className="min-h-screen bg-neutral-50 pb-16 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="mx-auto max-w-5xl px-4 pb-4 pt-[max(1.5rem,env(safe-area-inset-top))]">
        <p className="text-xs font-bold tracking-widest text-fuchsia-500">MY APPS</p>
        <h1 className="mt-1 text-2xl font-black tracking-tight">アプリ一覧</h1>
        <p className="mt-1 text-sm text-neutral-500">これまでに作ったアプリ（{apps.length}個）</p>

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
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((app) => {
            const external = /^https?:\/\//.test(app.href);
            const card = (
              <>
                <div className={`flex h-24 items-center justify-center bg-gradient-to-br text-5xl ${app.color}`}>
                  <span className="drop-shadow">{app.emoji}</span>
                </div>
                <div className="flex flex-1 flex-col p-4">
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-black">{app.name}</h2>
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
            const className =
              "flex h-full flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm transition active:scale-[0.98] hover:shadow-md dark:border-neutral-800 dark:bg-neutral-900";
            return (
              <li key={app.href}>
                {external ? (
                  <a href={app.href} target="_blank" rel="noopener noreferrer" className={className}>
                    {card}
                  </a>
                ) : (
                  <Link href={app.href} className={className}>
                    {card}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
        {visible.length === 0 && <p className="mt-10 text-center text-sm text-neutral-400">見つかりませんでした</p>}
      </main>
    </div>
  );
}
