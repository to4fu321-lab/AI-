"use client";

import { useState } from "react";
import { useIntroGuide } from "@/lib/introGuide";

const STEPS = [
  { emoji: "👀", label: "気づく", note: "危ない・やりにくいに気づく" },
  { emoji: "📮", label: "報告する", note: "写真とひとことで30秒" },
  { emoji: "🤝", label: "共有する", note: "同じ課題の人が見える" },
  { emoji: "🎊", label: "改善する", note: "担当者が動き、現場が変わる" },
];

/**
 * 初回だけ出る導入。1枚目にこのアプリを作った想い、2枚目に使い方を置く。
 * 閉じたら二度と自動では出さないが、DemoNote の「このアプリについて」から呼び戻せる
 */
export function FirstRunIntro() {
  const [open, setOpen] = useIntroGuide();
  // このコンポーネントは常時マウントされたままなので、閉じるときに1枚目へ戻す
  const [step, setStep] = useState<0 | 1>(0);

  if (!open) return null;

  const close = () => {
    setStep(0);
    setOpen(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-scrim/50 px-4 pb-6 pt-10 sm:items-center">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="intro-title"
        className="max-h-[calc(100dvh-4rem)] w-full max-w-[440px] overflow-y-auto rounded-[14px] bg-surface p-5"
      >
        {step === 0 ? (
          <>
            <p className="text-note font-bold text-brand">このアプリを作った想い</p>
            <h2 id="intro-title" className="mt-1 text-title text-ink">
              貴社の物流現場でピッキングや配送に携わり、
              <span className="text-brand">現場の小さな気づきを「改善」につなげたい。</span>
            </h2>

            <p className="mt-3 text-body text-ink-muted">
              その想いを、まずは一つの<b className="text-ink">改善共有モックアプリ</b>
              として形にしました。
            </p>

            {/* このアプリが扱うのはまさにこの3つ。段落に流さず、独立した声として見せる */}
            <ul className="mt-3 space-y-1.5 rounded-[14px] bg-canvas p-3 text-body text-ink">
              <li>「この作業、もっと早くできないか」</li>
              <li>「この情報があれば、ミスを減らせるはず」</li>
              <li>「現場の工夫を、チーム全体で共有したい」</li>
            </ul>

            <div className="mt-3 space-y-3 text-body text-ink-muted">
              <p>
                60万点を超える在庫を、ロボットによる自動化で動かす世界水準の物流。その仕組みだからこそ、現場で働く人にしか気づけないことが、大きな価値になると考えています。
              </p>
              <p>
                このモックを出発点に、現場を深く知り、現場から新しい物流を考える側として挑戦したいです！
              </p>
            </div>

            <p className="mt-3 text-right text-note text-ink-muted">吉岡 敏文</p>
          </>
        ) : (
          <>
            <p className="text-note font-bold text-brand">カイゼンボード</p>
            <h2 id="intro-title" className="mt-1 text-title text-ink">
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
              {STEPS.map((item, index) => (
                <li key={item.label} className="flex items-center gap-3">
                  <span
                    aria-hidden
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-canvas text-base"
                  >
                    {item.emoji}
                  </span>
                  <span className="min-w-0">
                    <span className="text-body font-bold text-ink">
                      {index + 1}. {item.label}
                    </span>
                    <span className="block text-note text-ink-muted">{item.note}</span>
                  </span>
                </li>
              ))}
            </ol>

            <p className="mt-4 text-note text-ink-muted">
              「現場」⇄「管理者」のボタンでいつでも切り替えられます。両方見てみてください。
            </p>
          </>
        )}

        <div className="mt-5 flex items-center justify-center gap-1.5" aria-hidden>
          <span
            className={`h-1.5 rounded-full transition-all ${
              step === 0 ? "w-4 bg-brand" : "w-1.5 bg-line"
            }`}
          />
          <span
            className={`h-1.5 rounded-full transition-all ${
              step === 1 ? "w-4 bg-brand" : "w-1.5 bg-line"
            }`}
          />
        </div>

        {step === 0 ? (
          <button
            type="button"
            onClick={() => setStep(1)}
            className="btn btn-lg btn-primary mt-3"
          >
            アプリを見る
          </button>
        ) : (
          <>
            <button type="button" onClick={close} className="btn btn-lg btn-primary mt-3">
              はじめる
            </button>
            <button
              type="button"
              onClick={() => setStep(0)}
              className="mt-1 min-h-11 w-full text-note font-bold text-ink-faint"
            >
              ← 想いを読む
            </button>
          </>
        )}
      </div>
    </div>
  );
}
