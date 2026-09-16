"use client";

import { useTheme, type Theme } from "@/lib/theme";

/**
 * 明るさの切り替え。
 *
 * ヘッダーは狭いので、選択肢を並べずにボタン1つで
 * 「おまかせ → 明るく → 暗く」と回す。今どれなのかは絵文字と読み上げで伝える
 */
const NEXT: Record<Theme, Theme> = {
  system: "light",
  light: "dark",
  dark: "system",
};

const FACE: Record<Theme, { emoji: string; label: string }> = {
  system: { emoji: "🌓", label: "画面の明るさ：端末におまかせ" },
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
