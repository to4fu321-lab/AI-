"use client";

import { useRouter } from "next/navigation";
import { setRole, useDemoState } from "@/lib/store";

/** デモ用：現場スタッフ / 管理者 をワンタップで切り替える */
export function RoleSwitcher() {
  const demo = useDemoState();
  const router = useRouter();

  if (!demo) return <div className="h-9 w-[152px] rounded-full bg-canvas" />;

  const change = (role: "staff" | "admin") => {
    setRole(role);
    router.push(role === "admin" ? "/admin" : "/");
  };

  return (
    <div
      role="group"
      aria-label="表示するロールの切り替え（デモ用）"
      className="flex items-center rounded-full border border-line bg-canvas p-0.5 text-xs font-bold"
    >
      {(
        [
          { value: "staff", label: "現場スタッフ" },
          { value: "admin", label: "管理者" },
        ] as const
      ).map((option) => {
        const active = demo.role === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => change(option.value)}
            aria-pressed={active}
            className={`rounded-full px-3 py-1.5 transition ${
              active ? "bg-brand text-white shadow-sm" : "text-ink-muted"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
