"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useDemoState } from "@/lib/store";

const STAFF_ITEMS = [
  { href: "/", label: "ホーム", icon: "🏠" },
  { href: "/new", label: "報告する", icon: "➕" },
  { href: "/me", label: "マイページ", icon: "🏅" },
];

const ADMIN_ITEMS = [
  { href: "/admin", label: "ダッシュボード", icon: "📊" },
  { href: "/", label: "現場フィード", icon: "🏠" },
];

export function BottomNav() {
  const pathname = usePathname();
  const demo = useDemoState();
  const items = demo?.role === "admin" ? ADMIN_ITEMS : STAFF_ITEMS;

  return (
    <nav
      aria-label="メインナビゲーション"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
    >
      <ul className="mx-auto flex max-w-[520px] items-stretch">
        {items.map((item) => {
          const active =
            item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-bold transition ${
                  active ? "text-brand" : "text-ink-faint"
                }`}
              >
                <span aria-hidden className="text-lg leading-none">
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
