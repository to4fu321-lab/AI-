"use client";

import { useState } from "react";

const SEEN_KEY = "kaizen-board:intro-seen";

const STEPS = [
  { emoji: "👀", label: "気づく", note: "危ない・やりにくいに気づく" },
  { emoji: "📮", label: "報告する", note: "写真とひとことで30秒" },
  { emoji: "🤝", label: "共有する", note: "同じ課題の人が見える" },
  { emoji: "🎊", label: "改善する", note: "担当者が動き、現場が変わる" },
];

function hasSeen(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return true;
  }
}

/**
 * 初回だけ出る導入。毎回出ると現場では邪魔になるので、閉じたら二度と出さない。
 */
export function FirstRunIntro() {
  const [open, setOpen] = useState(() => !hasSeen());

  if (!open) return null;

  const close = () => {
    try {
      window.localStorage.setItem(SEEN_KEY, "1");
    } catch {
      // 保存できなくても体験は止めない
    }
    setOpen(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 px-4 pb-6 pt-10 sm:items-center">
      <div className="w-full max-w-[440px] rounded-[14px] bg-surface p-5">
        <p className="text-note font-bold text-brand">カイゼンボード</p>
        <h2 className="mt-1 text-title text-ink">
          現場の「ちょっと困った」を、
          <br />
          カイゼンに変える。
        </h2>

        <ol className="mt-4 space-y-2.5">
          {STEPS.map((step, index) => (
            <li key={step.label} className="flex items-center gap-3">
              <span
                aria-hidden
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-canvas text-base"
              >
                {step.emoji}
              </span>
              <span className="min-w-0">
                <span className="text-body font-bold text-ink">
                  {index + 1}. {step.label}
                </span>
                <span className="block text-note text-ink-muted">{step.note}</span>
              </span>
            </li>
          ))}
        </ol>

        <button
          type="button"
          onClick={close}
          className="mt-5 min-h-14 w-full rounded-full bg-brand text-head text-white transition active:scale-[0.99]"
        >
          はじめる
        </button>
      </div>
    </div>
  );
}
