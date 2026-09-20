"use client";

import { useIntroGuide } from "@/lib/introGuide";

export function DemoNote() {
  const [, setOpen] = useIntroGuide();

  return (
    <div className="px-1 pb-2 text-center">
      <p className="text-note text-ink-faint">
        個人制作のデモアプリです（企業非公式）。データは端末内にのみ保存されます。
      </p>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1 min-h-11 text-note font-bold text-brand-dark"
      >
        使い方をもう一度見る
      </button>
    </div>
  );
}
