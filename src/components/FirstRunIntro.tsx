"use client";

import { useIntroGuide } from "@/lib/introGuide";

const STEPS = [
  { emoji: "👀", label: "気づく", note: "危ない・やりにくいに気づく" },
  { emoji: "📮", label: "報告する", note: "写真とひとことで30秒" },
  { emoji: "🤝", label: "共有する", note: "同じ課題の人が見える" },
  { emoji: "🎊", label: "改善する", note: "担当者が動き、現場が変わる" },
];

/**
 * 初回だけ出る導入。閉じたら二度と自動では出さないが、
 * DemoNote の「使い方をもう一度見る」からいつでも呼び戻せる
 */
export function FirstRunIntro() {
  const [open, setOpen] = useIntroGuide();

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-scrim/50 px-4 pb-6 pt-10 sm:items-center">
      <div className="w-full max-w-[440px] rounded-[14px] bg-surface p-5">
        <p className="text-note font-bold text-brand">カイゼンボード</p>
        <h2 className="mt-1 text-title text-ink">
          現場の「ちょっと困った」を、
          <br />
          カイゼンに変える。
        </h2>
        <p className="mt-2 text-note text-ink-muted">
          個人制作のポートフォリオです（トラスコ中山様への応募用デモ）。
        </p>

        <div className="mt-4 rounded-[14px] bg-canvas p-3">
          <p className="text-note font-bold text-ink">このデモの登場人物</p>
          <p className="mt-1 text-note text-ink-muted">
            今あなたは現場スタッフの<b className="text-ink">森下 陽介</b>として見ています。
            管理者は<b className="text-ink">中村 隆志</b>（センター長）です。
          </p>
        </div>

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

        <p className="mt-4 text-note text-ink-muted">
          右上のボタンで「現場」⇄「管理者」をいつでも切り替えられます。両方見てみてください。
        </p>

        <button type="button" onClick={() => setOpen(false)} className="btn btn-lg btn-primary mt-5">
          はじめる
        </button>
      </div>
    </div>
  );
}
