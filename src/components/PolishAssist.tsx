"use client";

import { useState } from "react";

interface Polished {
  title: string;
  body: string;
}

/**
 * 箇条書きのメモを報告文に整えるサポート。
 *
 * 設計の約束:
 * - 任意。使わずにそのまま出せる
 * - 結果は必ず見比べてから採用する（勝手に置き換えない）
 * - 元のメモは呼び出し側で保存し、管理者がいつでも読める
 */
export function PolishAssist({
  title,
  body,
  category,
  area,
  onApply,
}: {
  title: string;
  body: string;
  category: string;
  area: string;
  onApply: (result: Polished & { rawNote: string }) => void;
}) {
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

  return (
    <div className="rounded-lg border border-line bg-canvas p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-body font-bold text-ink">箇条書きでも大丈夫です</p>
          <p className="text-note text-ink-muted">
            思いついたまま書いて、AIに報告文へ整えてもらえます
          </p>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={!canRun}
          className="min-h-11 shrink-0 rounded-full border border-brand bg-surface px-4 text-note font-bold text-brand-dark transition active:scale-95 disabled:border-line disabled:text-ink-faint"
        >
          {loading ? "整えています…" : "✨ 整える"}
        </button>
      </div>

      {error ? <p className="mt-2 text-note text-danger">{error}</p> : null}

      {result ? (
        <div className="mt-3 space-y-2 rounded-lg border border-line bg-surface p-3">
          <p className="text-note font-bold text-ink-muted">整えた文</p>
          <p className="text-body font-bold text-ink">{result.title}</p>
          <p className="whitespace-pre-wrap text-body text-ink-muted">{result.body}</p>
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={() => {
                onApply({ ...result, rawNote: notes });
                setResult(null);
              }}
              className="min-h-11 flex-1 rounded-full bg-brand text-note font-bold text-white transition active:scale-[0.99]"
            >
              これにする
            </button>
            <button
              type="button"
              onClick={() => setResult(null)}
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
