"use client";

import { useRef, useState } from "react";
import { PhotoAnnotator } from "./PhotoAnnotator";
import { fileToScaledDataUrl } from "@/lib/image";

/** デモ用のサンプル写真（カメラの無いPCからでも試せるように） */
const SAMPLES = [
  { src: "/seed/shelf-label-before.svg", label: "棚ラベル" },
  { src: "/seed/cart-before.svg", label: "台車" },
  { src: "/seed/cable-hazard.svg", label: "通路のコード" },
  { src: "/seed/box-damage.svg", label: "破損した箱" },
];

export function PhotoField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: string | null;
  onChange: (dataUrl: string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [annotating, setAnnotating] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const dataUrl = await fileToScaledDataUrl(file);
      setAnnotating(dataUrl);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="card p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <p className="text-sm font-bold text-ink">{label}</p>
        <p className="text-[11px] text-ink-muted">{hint}</p>
      </div>

      {value ? (
        <div className="space-y-2">
          <div className="overflow-hidden rounded-xl border border-line">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={value} alt={`${label}のプレビュー`} className="w-full" />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setAnnotating(value)}
              className="min-h-11 flex-1 rounded-xl border border-line bg-surface text-xs font-bold text-ink"
            >
              ✏️ 書き込みを続ける
            </button>
            <button
              type="button"
              onClick={() => onChange(null)}
              className="min-h-11 rounded-xl border border-line px-3 text-xs font-bold text-ink-muted"
            >
              削除
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="flex min-h-24 w-full flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-brand-line bg-brand-soft text-sm font-bold text-brand-dark disabled:opacity-60"
          >
            <span aria-hidden className="text-2xl">
              📷
            </span>
            {busy ? "読み込み中…" : "写真を撮る / 選ぶ"}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            onChange={(event) => pickFile(event.target.files?.[0])}
          />
          <div>
            <p className="mb-1.5 text-[11px] text-ink-muted">
              カメラが使えない場合はサンプル写真でお試しください
            </p>
            <div className="no-scrollbar flex gap-2 overflow-x-auto">
              {SAMPLES.map((sample) => (
                <button
                  key={sample.src}
                  type="button"
                  onClick={() => setAnnotating(sample.src)}
                  className="shrink-0 overflow-hidden rounded-lg border border-line"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={sample.src}
                    alt={sample.label}
                    className="h-16 w-20 object-cover"
                  />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {annotating ? (
        <PhotoAnnotator
          src={annotating}
          onCancel={() => setAnnotating(null)}
          onSave={(dataUrl) => {
            onChange(dataUrl);
            setAnnotating(null);
          }}
        />
      ) : null}
    </div>
  );
}
