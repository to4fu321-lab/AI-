"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useUnreadNoticeCount } from "@/lib/store";

/** 「報告する」はFABに一本化しているので、ここは3つだけ */
const ITEMS = [
  { href: "/", label: "ホーム", icon: "🏠" },
  { href: "/notices", label: "お知らせ", icon: "📣" },
  { href: "/me", label: "マイページ", icon: "🏅" },
];

export function BottomNav() {
  const pathname = usePathname();
  const unread = useUnreadNoticeCount();

  return (
    <nav
      aria-label="メインナビゲーション"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]"
    >
      <ul className="mx-auto flex max-w-[520px] items-stretch">
        {ITEMS.map((item) => {
          const active =
            item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          const badge = item.href === "/notices" ? unread : 0;
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-14 flex-col items-center justify-center gap-0.5 text-note font-bold ${
                  active ? "text-brand" : "text-ink-faint"
                }`}
              >
                <span aria-hidden className="relative text-base leading-none">
                  {item.icon}
                  {badge > 0 ? (
                    <span className="absolute -right-2.5 -top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-danger px-1 text-[11px] font-bold leading-none text-white">
                      {badge}
                    </span>
                  ) : null}
                </span>
                {item.label}
                {badge > 0 ? <span className="sr-only">未読{badge}件</span> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
