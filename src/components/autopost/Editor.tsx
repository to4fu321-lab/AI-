"use client";

import { useEffect, useRef, useState } from "react";
import { ASPECTS, aspectRatio, formatTime, isNoop, runEdit, type EditSpec, type Meta } from "./media";

const field = "w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-[16px] dark:border-neutral-700 dark:bg-neutral-900";

/** 簡易編集：切り出し（始点・終点）、形（縦長・正方形など）、大きさ、消音。仕上がりの見え方をその場で確かめられる */
export function Editor({ blob, meta, onDone, onCancel }: { blob: Blob; meta: Meta; onDone: (edited: Blob) => void; onCancel: () => void }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const created = URL.createObjectURL(blob);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUrl(created);
    return () => URL.revokeObjectURL(created);
  }, [blob]);
  const video = useRef<HTMLVideoElement>(null);
  const [spec, setSpec] = useState<EditSpec>({ start: 0, end: meta.duration, aspect: "original", fit: "crop", maxSide: 0, mute: false });
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState("");
  const set = (patch: Partial<EditSpec>) => setSpec((s) => ({ ...s, ...patch }));
  const now = () => video.current?.currentTime ?? 0;
  const clamp = (v: number) => Math.min(Math.max(v, 0), meta.duration);

  // 終点まで来たら止める（切り出したあとの見え方に合わせる）
  const onTime = () => {
    const v = video.current;
    if (v && !v.paused && v.currentTime >= spec.end) v.pause();
  };

  const exportVideo = async () => {
    setError("");
    setProgress(0);
    try {
      onDone(await runEdit(blob, spec, meta, setProgress));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
    }
  };

  const busy = progress !== null;
  return (
    <div className="space-y-4 rounded-2xl border border-fuchsia-300 bg-fuchsia-50/50 p-4 dark:border-fuchsia-900 dark:bg-fuchsia-950/20">
      <div className="mx-auto max-h-[60vh] overflow-hidden rounded-xl bg-black" style={{ aspectRatio: aspectRatio(spec.aspect, meta), maxWidth: `calc(60vh * ${aspectRatio(spec.aspect, meta)})` }}>
        <video ref={video} src={url || undefined} controls playsInline muted={spec.mute} onTimeUpdate={onTime} className="h-full w-full" style={{ objectFit: spec.fit === "crop" ? "cover" : "contain" }} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        {(["start", "end"] as const).map((key) => (
          <label key={key} className="block text-sm font-semibold">
            {key === "start" ? "始点（秒）" : "終点（秒）"}
            <input
              type="number"
              inputMode="decimal"
              min={0}
              max={meta.duration}
              step={0.1}
              value={Number(spec[key].toFixed(1))}
              onChange={(e) => {
                const value = clamp(Number(e.target.value) || 0);
                set({ [key]: value });
                // 変えた位置の絵をすぐ見せる
                if (video.current) video.current.currentTime = value;
              }}
              className={`${field} mt-1`}
            />
            <button type="button" onClick={() => set({ [key]: clamp(now()) })} className="mt-1 text-xs font-semibold text-fuchsia-600">
              ⏱ いま止めている位置にする
            </button>
          </label>
        ))}
      </div>
      <p className="text-xs text-neutral-500">
        切り出したあとの長さ：{formatTime(Math.max(0, spec.end - spec.start))}（元は {formatTime(meta.duration)}）
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm font-semibold">
          形
          <select value={spec.aspect} onChange={(e) => set({ aspect: e.target.value as EditSpec["aspect"] })} className={`${field} mt-1`}>
            {ASPECTS.map((a) => (
              <option key={a.value} value={a.value}>{a.label}</option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-semibold">
          形が合わないとき
          <select value={spec.fit} disabled={spec.aspect === "original"} onChange={(e) => set({ fit: e.target.value as EditSpec["fit"] })} className={`${field} mt-1 disabled:opacity-50`}>
            <option value="crop">はみ出しを切り落とす</option>
            <option value="pad">黒い余白を足す（全体を残す）</option>
          </select>
        </label>
        <label className="block text-sm font-semibold">
          大きさ
          <select value={spec.maxSide} onChange={(e) => set({ maxSide: Number(e.target.value) })} className={`${field} mt-1`}>
            <option value={0}>元のまま</option>
            <option value={1080}>フル HD（1080）まで小さく</option>
            <option value={720}>HD（720）まで小さく</option>
            <option value={480}>480 まで小さく（軽い）</option>
          </select>
        </label>
        <label className="flex items-center gap-2 self-end pb-2 text-sm font-semibold">
          <input type="checkbox" checked={spec.mute} onChange={(e) => set({ mute: e.target.checked })} className="h-5 w-5" />
          音を消す
        </label>
      </div>

      {error && <p className="whitespace-pre-wrap text-sm font-semibold text-red-600">{error}</p>}
      {busy && (
        <div>
          <div className="h-2 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
            <div className="h-full bg-fuchsia-500 transition-all" style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
          </div>
          <p className="mt-1 text-xs text-neutral-500">書き出しています… {Math.round((progress ?? 0) * 100)}%（このページを閉じないでください）</p>
        </div>
      )}
      <div className="flex gap-2">
        <button type="button" disabled={busy || isNoop(spec, meta) || spec.end - spec.start < 0.2} onClick={exportVideo} className="flex-1 rounded-full bg-fuchsia-600 px-4 py-3 text-sm font-bold text-white disabled:opacity-40">
          ✂️ この内容で書き出す
        </button>
        <button type="button" disabled={busy} onClick={onCancel} className="rounded-full bg-neutral-200 px-4 py-3 text-sm font-semibold dark:bg-neutral-800">
          やめる
        </button>
      </div>
    </div>
  );
}
