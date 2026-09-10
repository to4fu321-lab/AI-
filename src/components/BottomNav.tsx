"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** 「報告する」はFABに一本化しているので、ここは2つだけ */
const ITEMS = [
  { href: "/", label: "ホーム", icon: "🏠" },
  { href: "/me", label: "マイページ", icon: "🏅" },
];

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="メインナビゲーション"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]"
    >
      <ul className="mx-auto flex max-w-[520px] items-stretch">
        {ITEMS.map((item) => {
          const active =
            item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-14 flex-col items-center justify-center gap-0.5 text-note font-bold ${
                  active ? "text-brand" : "text-ink-faint"
                }`}
              >
                <span aria-hidden className="text-base leading-none">
                  {item.icon}
                </span>
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
