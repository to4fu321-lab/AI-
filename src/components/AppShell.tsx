"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { BottomNav } from "./BottomNav";
import { RoleSwitcher } from "./RoleSwitcher";
import { setRole, useDemoState } from "@/lib/store";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const demo = useDemoState();
  const isAdmin = pathname.startsWith("/admin");

  // URL がロールの正。/admin 配下は管理者ビューとして扱う
  useEffect(() => {
    const next = isAdmin ? "admin" : "staff";
    if (demo && demo.role !== next) setRole(next);
  }, [demo, isAdmin]);

  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
        <div
          className={`mx-auto flex h-14 items-center justify-between gap-3 px-4 ${
            isAdmin ? "max-w-5xl" : "max-w-[520px]"
          }`}
        >
          <Link href={isAdmin ? "/admin" : "/"} className="flex items-center gap-2">
            <span
              aria-hidden
              className="grid h-8 w-8 place-items-center rounded-lg bg-brand text-sm font-black text-white"
            >
              改
            </span>
            <span className="text-[15px] font-bold tracking-tight text-ink">
              カイゼンボード
            </span>
          </Link>
          <RoleSwitcher />
        </div>
      </header>

      <main
        className={`mx-auto w-full flex-1 px-4 pt-4 ${isAdmin ? "pb-12" : "pb-28"} ${
          isAdmin ? "max-w-5xl" : "max-w-[520px]"
        }`}
      >
        {children}
      </main>

      {isAdmin ? null : <BottomNav />}
    </div>
  );
}
