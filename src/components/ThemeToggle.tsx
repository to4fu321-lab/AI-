"use client";

import { useTheme, type Theme } from "@/lib/theme";

/**
 * 明るさの切り替え。既定は常にライト（明るく）で、
 * 押すたびにライト⇄ダークだけを行き来する。
 * 端末のダークモード設定には追従しないので、選択肢もそれに合わせて2つだけにしている
 */
const NEXT: Record<Theme, Theme> = {
  light: "dark",
  dark: "light",
};

const FACE: Record<Theme, { emoji: string; label: string }> = {
  light: { emoji: "☀️", label: "画面の明るさ：明るく" },
  dark: { emoji: "🌙", label: "画面の明るさ：暗く" },
};

export function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const face = FACE[theme];

  return (
    <button
      type="button"
      onClick={() => setTheme(NEXT[theme])}
      title={`${face.label}（押すと切り替わります）`}
      className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-line bg-canvas text-base transition active:bg-canvas"
    >
      <span aria-hidden>{face.emoji}</span>
      <span className="sr-only">{face.label}。押すと切り替わります</span>
    </button>
  );
}
