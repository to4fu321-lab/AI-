"use client";

import { useState } from "react";

interface Polished {
  title: string;
  body: string;
}

interface PolishAssistState {
  loading: boolean;
  error: string;
  result: Polished | null;
  canRun: boolean;
  run: () => void;
  dismiss: () => void;
}

/**
 * 箇条書きのメモを報告文に整えるサポートのロジック。
 *
 * 設計の約束:
 * - 任意。使わずにそのまま出せる
 * - 結果は必ず見比べてから採用する（勝手に置き換えない）
 * - 元のメモは呼び出し側で保存し、管理者がいつでも読める
 *
 * UIを「説明バナー（見出し直後）」と「ボタン（くわしく欄の下）」に離して
 * 置けるよう、状態管理だけをこのフックに持たせている。
 */
export function usePolishAssist({
  title,
  body,
  category,
  area,
}: {
  title: string;
  body: string;
  category: string;
  area: string;
}): PolishAssistState {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Polished | null>(null);

  const notes = [title, body].filter((part) => part.trim()).join("\n");
  const canRun = notes.trim().length > 0 && !loading;

  const run = async () => {
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const response = await fetch("/api/polish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes, category, area }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(typeof data?.error === "string" ? data.error : "整えられませんでした");
        return;
      }
      setResult({ title: data.title, body: data.body });
    } catch {
      setError("通信できませんでした");
    } finally {
      setLoading(false);
    }
  };

  return { loading, error, result, canRun, run, dismiss: () => setResult(null) };
}

/** 見出しの直後に置く、AIサポートがあることを伝えるだけの説明バナー */
export function PolishHintBanner() {
  return (
    <div className="rounded-lg border border-line bg-canvas p-3">
      <p className="text-body font-bold text-ink">箇条書きでも大丈夫です</p>
      <p className="text-note text-ink-muted">
        思いついたまま書いて、AIに報告文へ整えてもらえます
      </p>
    </div>
  );
}

/** 「くわしく」欄の下に置く、実際に整えるボタンと結果 */
export function PolishButton({
  state,
  onApply,
  rawNoteSource,
}: {
  state: PolishAssistState;
  onApply: (result: Polished & { rawNote: string }) => void;
  /** 適用時に元メモとして保存する文字列（タイトル＋本文） */
  rawNoteSource: string;
}) {
  const { loading, error, result, canRun, run, dismiss } = state;

  return (
    <div>
      <button
        type="button"
        onClick={run}
        disabled={!canRun}
        className="flex min-h-11 w-full items-center justify-center gap-1.5 rounded-full border border-brand bg-brand-soft text-note font-bold text-brand-dark transition active:scale-[0.99] disabled:border-line disabled:bg-canvas disabled:text-ink-faint"
      >
        {loading ? "整えています…" : "✨ AIに報告文へ整えてもらう"}
      </button>

      {error ? <p className="mt-1.5 text-note text-danger">{error}</p> : null}

      {result ? (
        <div className="mt-2 space-y-2 rounded-lg border border-line bg-canvas p-3">
          <p className="text-note font-bold text-ink-muted">整えた文</p>
          <p className="text-body font-bold text-ink">{result.title}</p>
          <p className="whitespace-pre-wrap text-body text-ink-muted">{result.body}</p>
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={() => {
                onApply({ ...result, rawNote: rawNoteSource });
                dismiss();
              }}
              className="min-h-11 flex-1 rounded-full bg-brand text-note font-bold text-white transition active:scale-[0.99]"
            >
              これにする
            </button>
            <button
              type="button"
              onClick={dismiss}
              className="min-h-11 rounded-full border border-line px-4 text-note font-bold text-ink-muted"
            >
              元のまま
            </button>
          </div>
          <p className="text-note text-ink-faint">
            書いた元のメモも残るので、担当者はそのまま読めます
          </p>
        </div>
      ) : null}
    </div>
  );
}
