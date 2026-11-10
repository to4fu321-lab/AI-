"use client";

import { useEffect, useRef, useState } from "react";
import { RepairError, repairVideo, type RepairErrorCode, type RepairResult, type RepairStage } from "@/lib/repair";
import { createWasmProber, type WasmProber } from "@/lib/repair/wasmProber";

type Phase =
  | { kind: "idle" }
  | { kind: "running"; stage: RepairStage; fraction: number }
  | { kind: "done"; result: RepairResult; url: string; name: string }
  | { kind: "error"; message: string; hint?: string };

const STAGE_LABEL: Record<RepairStage, string> = {
  inspect: "ファイルを確認しています",
  sample: "動画の形式を調べています",
  scan: "映像と音声のフレームを探しています",
  estimate: "再生に必要な設定を割り出しています",
  write: "修復した動画を書き出しています",
};

const ERRORS: Record<RepairErrorCode, { message: string; hint?: string }> = {
  REFERENCE_INVALID: {
    message: "参考動画を読み取れませんでした。",
    hint: "正常に再生できるMP4またはMOVを選んでください。",
  },
  REFERENCE_UNSUPPORTED: {
    message: "この参考動画の形式には対応していません。",
    hint: "H.264またはHEVC（H.265）で記録された動画を選んでください。",
  },
  NO_VIDEO_FOUND: {
    message: "このファイルから映像データを見つけられませんでした。",
    hint: "同じカメラ・同じ設定で撮った正常な動画を「参考動画」に指定すると、修復できる場合があります。",
  },
  HEVC_NEEDS_REFERENCE: {
    message: "この動画はHEVC（高効率）形式のため、参考動画が必要です。",
    hint: "同じカメラ・同じ設定で撮った正常な動画を「参考動画」に指定して、もう一度お試しください。",
  },
  ESTIMATE_FAILED: {
    message: "再生に必要な設定を自動では割り出せませんでした。",
    hint: "同じカメラ・同じ設定で撮った正常な動画を「参考動画」に指定して、もう一度お試しください。",
  },
  PROBER_UNAVAILABLE: {
    message: "解析エンジンを読み込めませんでした。",
    hint: "通信環境を確認して再度お試しいただくか、参考動画を指定してください（参考動画があれば読み込みは不要です）。",
  },
};

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}分${s % 60}秒` : `${s}秒`;
}

function outputName(name: string): string {
  const base = name.replace(/\.[^.]+$/, "");
  return `${base || "video"}_repaired.mp4`;
}

function FilePicker({
  label,
  file,
  onPick,
  onClear,
  disabled,
}: {
  label: string;
  file: File | null;
  onPick: (f: File) => void;
  onClear?: () => void;
  disabled: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div>
      <input
        ref={input}
        type="file"
        accept="video/*,.mp4,.mov,.m4v,.3gp"
        className="sr-only"
        disabled={disabled}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
          e.target.value = "";
        }}
      />
      {file ? (
        <div className="flex items-center gap-3 rounded-2xl border border-black/10 bg-white px-4 py-3 dark:border-white/15 dark:bg-white/5">
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{file.name}</p>
            <p className="text-sm text-black/55 dark:text-white/55">{formatBytes(file.size)}</p>
          </div>
          <button
            type="button"
            disabled={disabled}
            onClick={() => (onClear ? onClear() : input.current?.click())}
            className="shrink-0 rounded-full px-3 py-2 text-sm font-medium text-teal-700 disabled:opacity-40 dark:text-teal-300"
          >
            {onClear ? "外す" : "変更"}
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => input.current?.click()}
          className="flex min-h-14 w-full items-center justify-center rounded-2xl border border-dashed border-black/25 bg-white px-4 py-4 text-base font-medium text-black/75 active:bg-black/5 disabled:opacity-40 dark:border-white/25 dark:bg-white/5 dark:text-white/80"
        >
          {label}
        </button>
      )}
    </div>
  );
}

export function RepairApp() {
  const [broken, setBroken] = useState<File | null>(null);
  const [reference, setReference] = useState<File | null>(null);
  const [rotation, setRotation] = useState(-1);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [canShare, setCanShare] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const prober = useRef<WasmProber | null>(null);
  const lastUrl = useRef<string | null>(null);

  useEffect(() => {
    // Feature detection has to wait for the browser: the server render cannot know.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function" && typeof navigator.canShare === "function");
    return () => {
      abort.current?.abort();
      prober.current?.dispose();
      if (lastUrl.current) URL.revokeObjectURL(lastUrl.current);
    };
  }, []);

  const running = phase.kind === "running";

  const reset = () => {
    if (lastUrl.current) URL.revokeObjectURL(lastUrl.current);
    lastUrl.current = null;
    setPhase({ kind: "idle" });
  };

  const start = async () => {
    if (!broken) return;
    reset();
    const controller = new AbortController();
    abort.current = controller;
    setPhase({ kind: "running", stage: "inspect", fraction: 0 });
    try {
      const result = await repairVideo(broken, {
        reference,
        rotation: rotation >= 0 ? rotation : null,
        signal: controller.signal,
        prober: async () => (prober.current ??= await createWasmProber()),
        onProgress: (stage, fraction) => setPhase({ kind: "running", stage, fraction }),
      });
      const url = URL.createObjectURL(result.blob);
      lastUrl.current = url;
      setPhase({ kind: "done", result, url, name: outputName(broken.name) });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        setPhase({ kind: "idle" });
      } else if (e instanceof RepairError) {
        setPhase({ kind: "error", ...ERRORS[e.code] });
      } else {
        setPhase({ kind: "error", message: "修復中に問題が発生しました。", hint: "ファイルを選び直して、もう一度お試しください。" });
      }
    } finally {
      abort.current = null;
    }
  };

  const share = async (result: RepairResult, name: string) => {
    const file = new File([result.blob], name, { type: "video/mp4" });
    try {
      if (navigator.canShare({ files: [file] })) await navigator.share({ files: [file] });
    } catch {
      // The share sheet was dismissed.
    }
  };

  return (
    // The page sets its own colours: the site-wide body colours do not follow the light/dark
    // setting, which would leave this text unreadable.
    <div className="min-h-screen bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col gap-6 px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(1.5rem,env(safe-area-inset-top))]">
      <header className="pt-2">
        <h1 className="text-2xl font-bold tracking-tight">動画修復</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-black/65 dark:text-white/65">
          撮影の中断や転送の失敗で再生できなくなったMP4・MOVを修復します。動画はこの端末の中だけで処理され、どこにも送信されません。
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-bold text-black/55 dark:text-white/55">1. 壊れた動画</h2>
        <FilePicker
          label="再生できない動画を選ぶ"
          file={broken}
          disabled={running}
          onPick={(f) => {
            setBroken(f);
            reset();
          }}
        />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-bold text-black/55 dark:text-white/55">2. 参考動画（あれば）</h2>
        <FilePicker
          label="正常に再生できる動画を選ぶ"
          file={reference}
          disabled={running}
          onPick={setReference}
          onClear={() => setReference(null)}
        />
        <p className="text-sm leading-relaxed text-black/55 dark:text-white/55">
          壊れた動画と同じカメラ・同じ設定で撮った正常な動画があれば指定してください。なくても、一般的な形式（H.264）なら自動で修復を試みます。
        </p>
      </section>

      <details className="rounded-2xl border border-black/10 px-4 py-3 text-[15px] dark:border-white/15">
        <summary className="cursor-pointer font-medium">詳細設定</summary>
        <label className="mt-3 flex items-center justify-between gap-3">
          <span>映像の向き</span>
          <select
            value={rotation}
            disabled={running}
            onChange={(e) => setRotation(Number(e.target.value))}
            className="rounded-lg border border-black/15 bg-white px-3 py-2 text-base dark:border-white/20 dark:bg-neutral-900"
          >
            <option value={-1}>自動</option>
            <option value={0}>回転しない</option>
            <option value={90}>右に90°</option>
            <option value={180}>180°</option>
            <option value={270}>左に90°</option>
          </select>
        </label>
        <p className="mt-2 text-sm text-black/55 dark:text-white/55">修復後の映像が横倒しになっている場合に変更してください。</p>
      </details>

      {phase.kind !== "running" && (
        <button
          type="button"
          disabled={!broken}
          onClick={start}
          className="min-h-14 rounded-2xl bg-teal-700 px-4 text-lg font-bold text-white active:bg-teal-800 disabled:bg-black/15 disabled:text-black/40 dark:disabled:bg-white/15 dark:disabled:text-white/40"
        >
          {phase.kind === "done" ? "もう一度修復する" : "修復する"}
        </button>
      )}

      {phase.kind === "running" && (
        <section className="rounded-2xl border border-black/10 bg-white p-4 dark:border-white/15 dark:bg-white/5" aria-live="polite">
          <p className="font-medium">{STAGE_LABEL[phase.stage]}</p>
          <div
            className="mt-3 h-2 overflow-hidden rounded-full bg-black/10 dark:bg-white/15"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(phase.fraction * 100)}
          >
            <div className="h-full rounded-full bg-teal-600 transition-[width] duration-200" style={{ width: `${Math.max(3, phase.fraction * 100)}%` }} />
          </div>
          <p className="mt-2 text-sm text-black/55 dark:text-white/55">
            {phase.stage === "estimate"
              ? "参考動画がないため、解析エンジン（約32MB）を使って設定を割り出しています。1〜2分かかることがあります。"
              : "画面を開いたままお待ちください。"}
          </p>
          <button
            type="button"
            onClick={() => abort.current?.abort()}
            className="mt-3 min-h-11 w-full rounded-xl border border-black/15 text-base font-medium dark:border-white/20"
          >
            中止
          </button>
        </section>
      )}

      {phase.kind === "error" && (
        <section className="rounded-2xl border border-red-600/30 bg-red-50 p-4 dark:border-red-400/30 dark:bg-red-950/40" role="alert">
          <p className="font-bold text-red-800 dark:text-red-200">{phase.message}</p>
          {phase.hint && <p className="mt-1 text-[15px] leading-relaxed text-red-900/80 dark:text-red-100/80">{phase.hint}</p>}
        </section>
      )}

      {phase.kind === "done" && (
        <section className="flex flex-col gap-4 rounded-2xl border border-black/10 bg-white p-4 dark:border-white/15 dark:bg-white/5">
          <div>
            <p className="text-lg font-bold">修復できました</p>
            <p className="mt-1 text-[15px] text-black/65 dark:text-white/65">
              {phase.result.width}×{phase.result.height}・{formatDuration(phase.result.durationSeconds)}・
              {phase.result.audioFrames > 0 ? "音声あり" : "音声なし"}・{formatBytes(phase.result.blob.size)}
            </p>
          </div>
          <video src={phase.url} controls playsInline preload="metadata" className="max-h-[70vh] w-full rounded-xl bg-black" />
          <div className="flex flex-col gap-2">
            {canShare && (
              <button
                type="button"
                onClick={() => share(phase.result, phase.name)}
                className="min-h-14 rounded-2xl bg-teal-700 px-4 text-lg font-bold text-white active:bg-teal-800"
              >
                保存・共有する
              </button>
            )}
            <a
              href={phase.url}
              download={phase.name}
              className={
                canShare
                  ? "flex min-h-12 items-center justify-center rounded-2xl border border-black/15 px-4 text-base font-medium dark:border-white/20"
                  : "flex min-h-14 items-center justify-center rounded-2xl bg-teal-700 px-4 text-lg font-bold text-white active:bg-teal-800"
              }
            >
              ファイルとしてダウンロード
            </a>
          </div>
          <ul className="flex flex-col gap-1 text-sm leading-relaxed text-black/60 dark:text-white/60">
            {canShare && <li>「保存・共有する」→「ビデオを保存」で写真アプリに保存できます。</li>}
            {phase.result.audioFrames === 0 && (
              <li>
                {phase.result.unsupportedAudio
                  ? "この動画の音声形式には対応していないため、映像のみ修復しました。"
                  : "音声は見つからなかったため、映像のみ修復しました。"}
              </li>
            )}
            {phase.result.estimated && (
              <li>設定を自動で割り出して修復しました。色や明るさが不自然な場合は、参考動画を指定してやり直してください。</li>
            )}
            {phase.result.hadMoov && <li>このファイルには再生用の索引が残っていましたが、映像データから作り直しました。</li>}
            {phase.result.discardedBytes > 0 && <li>ファイルの末尾で途切れていた最後の一瞬（{formatBytes(phase.result.discardedBytes)}）は復元できませんでした。</li>}
          </ul>
        </section>
      )}

      <footer className="mt-auto pt-4 text-sm leading-relaxed text-black/50 dark:text-white/50">
        <p>対応形式：H.264 / HEVC（H.265）の映像とAAC音声を含むMP4・MOV。記録の途中で終了して索引（moov）が書き込まれなかったファイルを修復します。</p>
      </footer>
    </main>
    </div>
  );
}
