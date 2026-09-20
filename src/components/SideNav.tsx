"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { RoleSwitcher } from "./RoleSwitcher";
import { ThemeToggle } from "./ThemeToggle";
import { useUnreadNoticeCount } from "@/lib/store";

/**
 * タブレット（10インチ・縦向き 820px）以上で出る横のナビ。
 * スマホでは下のボトムナビが担当するので、ここは md 未満では出さない。
 *
 * 現場はスマホ片手が前提なので下＝親指の届く場所が正しいが、
 * タブレット・PCは両手で持つ／机に置くため、下端に横長のバーがあっても遠い。
 * 幅がある端末では、視線の始点に近い左側にまとめる
 */
const STAFF_ITEMS = [
  { href: "/", label: "ホーム", icon: "🏠" },
  { href: "/notices", label: "お知らせ", icon: "📣" },
  { href: "/me", label: "マイページ", icon: "🏅" },
];

const ADMIN_ITEMS = [
  { href: "/admin", label: "ダッシュボード", icon: "📊" },
  { href: "/admin/notice", label: "お知らせを送る", icon: "📣" },
];

export function SideNav({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  const unread = useUnreadNoticeCount();
  const items = isAdmin ? ADMIN_ITEMS : STAFF_ITEMS;

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    // 報告の個別画面（/admin/xxx）もダッシュボードの一部として扱う
    if (href === "/admin") {
      return pathname.startsWith("/admin") && !pathname.startsWith("/admin/notice");
    }
    return pathname.startsWith(href);
  };

  return (
    <aside className="sticky top-0 hidden h-dvh w-[220px] shrink-0 flex-col border-r border-line bg-surface px-3 py-4 md:flex">
      <Link href={isAdmin ? "/admin" : "/"} className="flex min-h-11 items-center gap-2 px-1">
        <span
          aria-hidden
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand text-sm font-black text-white"
        >
          改
        </span>
        <span className="text-[17px] font-bold tracking-tight text-ink">カイゼンボード</span>
      </Link>
      <span className="mt-1 self-start rounded border border-line px-1.5 py-0.5 text-[11px] font-bold leading-none text-ink-faint">
        DEMO
      </span>

      {isAdmin ? null : (
        <Link href="/new" className="btn btn-primary mt-4 w-full">
          <span aria-hidden>＋</span>
          報告する
        </Link>
      )}

      <nav aria-label="メインナビゲーション" className="mt-4">
        <ul className="space-y-1">
          {items.map((item) => {
            const active = isActive(item.href);
            const badge = item.href === "/notices" ? unread : 0;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`flex min-h-12 items-center gap-2.5 rounded-[14px] px-3 text-body font-bold transition ${
                    active ? "bg-brand-soft text-brand-dark" : "text-ink-muted hover:bg-canvas"
                  }`}
                >
                  <span aria-hidden className="text-base leading-none">
                    {item.icon}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {badge > 0 ? (
                    <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-danger px-1 text-[11px] font-bold leading-none text-white">
                      {badge}
                    </span>
                  ) : null}
                  {badge > 0 ? <span className="sr-only">未読{badge}件</span> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="mt-auto flex items-center gap-2 border-t border-line pt-3">
        <ThemeToggle />
        <RoleSwitcher />
      </div>
    </aside>
  );
}
