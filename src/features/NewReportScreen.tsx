"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { PhotoField } from "@/components/PhotoField";
import { PointsBurst } from "@/components/PointsBurst";
import { LoadingBlock } from "@/components/EmptyState";
import { AREAS, REPORT_TYPES, URGENCIES } from "@/lib/labels";
import { postPointLines } from "@/lib/points";
import { putImage } from "@/lib/storage";
import { createReport, useDemoState } from "@/lib/store";
import type { Report, ReportType, Urgency } from "@/lib/types";

const STEPS = ["種類をえらぶ", "写真と書き込み", "ひとこと"];

export function NewReportScreen() {
  const demo = useDemoState();
  const router = useRouter();

  const [step, setStep] = useState(0);
  const [type, setType] = useState<ReportType | null>(null);
  const [urgency, setUrgency] = useState<Urgency>("normal");
  const [before, setBefore] = useState<string | null>(null);
  const [after, setAfter] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [area, setArea] = useState(AREAS[0]);
  const [areaNote, setAreaNote] = useState("");
  const [anonymous, setAnonymous] = useState(false);
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<Report | null>(null);

  if (!demo) return <LoadingBlock />;

  if (created) {
    return <SubmittedScreen report={created} />;
  }

  const submit = async () => {
    if (!type || !title.trim()) return;
    setSaving(true);
    try {
      const beforeRef = before ? await putImage(await dataUrlToBlob(before)) : undefined;
      const afterRef = after ? await putImage(await dataUrlToBlob(after)) : undefined;
      const report = createReport({
        type,
        urgency,
        title,
        body,
        area,
        areaNote,
        anonymous,
        beforeImage: beforeRef,
        afterImage: afterRef,
      });
      setCreated(report);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => (step === 0 ? router.push("/") : setStep(step - 1))}
          className="min-h-11 text-sm font-bold text-ink-muted"
        >
          ← {step === 0 ? "やめる" : "もどる"}
        </button>
        <p className="text-xs font-bold text-ink-muted">
          STEP {step + 1} / 3・{STEPS[step]}
        </p>
      </div>

      <div className="flex gap-1.5" aria-hidden>
        {STEPS.map((label, index) => (
          <div
            key={label}
            className={`h-1.5 flex-1 rounded-full ${index <= step ? "bg-brand" : "bg-line"}`}
          />
        ))}
      </div>

      {step === 0 ? (
        <section className="space-y-4">
          <h1 className="text-lg font-bold text-ink">どんな内容ですか？</h1>
          <div className="grid grid-cols-2 gap-3">
            {REPORT_TYPES.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => setType(item.value)}
                aria-pressed={type === item.value}
                className={`card flex min-h-32 flex-col items-start gap-1 p-4 text-left transition ${
                  type === item.value ? "border-brand bg-brand-soft" : ""
                }`}
              >
                <span aria-hidden className="text-2xl">
                  {item.emoji}
                </span>
                <span className="text-sm font-bold text-ink">{item.label}</span>
                <span className="text-[11px] leading-snug text-ink-muted">{item.hint}</span>
              </button>
            ))}
          </div>

          <div>
            <p className="mb-2 text-sm font-bold text-ink">急ぎ具合</p>
            <div className="flex gap-2">
              {URGENCIES.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => setUrgency(item.value)}
                  aria-pressed={urgency === item.value}
                  className={`min-h-11 flex-1 rounded-xl border text-xs font-bold transition ${
                    urgency === item.value
                      ? "border-brand bg-brand-soft text-brand-dark"
                      : "border-line bg-surface text-ink-muted"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <StepButton disabled={!type} onClick={() => setStep(1)}>
            つぎへ
          </StepButton>
        </section>
      ) : null}

      {step === 1 ? (
        <section className="space-y-4">
          <h1 className="text-lg font-bold text-ink">写真で伝えましょう</h1>
          <p className="-mt-2 text-xs text-ink-muted">
            撮った写真に指で丸や矢印を書き込めます。文章より一瞬で伝わります。
          </p>
          <PhotoField
            label="現状（Before）"
            hint="任意"
            value={before}
            onChange={setBefore}
          />
          <PhotoField
            label="こうしたい / 直した後（After）"
            hint="任意・+10pt"
            value={after}
            onChange={setAfter}
          />
          <StepButton onClick={() => setStep(2)}>つぎへ</StepButton>
        </section>
      ) : null}

      {step === 2 ? (
        <section className="space-y-4">
          <h1 className="text-lg font-bold text-ink">ひとことで教えてください</h1>

          <div className="card space-y-4 p-4">
            <label className="block">
              <span className="mb-1 block text-sm font-bold text-ink">
                タイトル <span className="text-brand">必須</span>
              </span>
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={40}
                placeholder="例）棚のラベルが小さくて見えない"
                className="min-h-12 w-full rounded-xl border border-line bg-canvas px-3 text-[15px] text-ink outline-none focus:border-brand"
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-sm font-bold text-ink">
                くわしく <span className="text-ink-faint">任意</span>
              </span>
              <textarea
                value={body}
                onChange={(event) => setBody(event.target.value)}
                rows={4}
                placeholder="いつ・どこで・どう困っているか。ひとことでも大丈夫です。"
                className="w-full rounded-xl border border-line bg-canvas p-3 text-[15px] leading-relaxed text-ink outline-none focus:border-brand"
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-sm font-bold text-ink">場所</span>
              <select
                value={area}
                onChange={(event) => setArea(event.target.value)}
                className="min-h-12 w-full rounded-xl border border-line bg-canvas px-3 text-[15px] text-ink outline-none focus:border-brand"
              >
                {AREAS.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block text-sm font-bold text-ink">
                場所のメモ <span className="text-ink-faint">任意</span>
              </span>
              <input
                value={areaNote}
                onChange={(event) => setAreaNote(event.target.value)}
                maxLength={40}
                placeholder="例）A-3通路の突き当たり"
                className="min-h-12 w-full rounded-xl border border-line bg-canvas px-3 text-[15px] text-ink outline-none focus:border-brand"
              />
            </label>

            <label className="flex items-center justify-between gap-3 rounded-xl bg-canvas p-3">
              <span className="text-sm font-bold text-ink">
                匿名で投稿する
                <span className="block text-[11px] font-normal text-ink-muted">
                  名前を出さずに送れます（ポイントは付きます）
                </span>
              </span>
              <input
                type="checkbox"
                checked={anonymous}
                onChange={(event) => setAnonymous(event.target.checked)}
                className="h-6 w-6 accent-[#ea5504]"
              />
            </label>
          </div>

          <div className="card p-4">
            <p className="text-xs font-bold text-ink-muted">この報告でもらえるポイント</p>
            <ul className="mt-2 space-y-1 text-sm">
              {postPointLines({
                beforeImage: before ?? undefined,
                afterImage: after ?? undefined,
              }).map((line) => (
                <li key={line.label} className="flex justify-between">
                  <span className="text-ink-muted">{line.label}</span>
                  <span className="font-bold text-brand">+{line.points}pt</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 border-t border-line pt-2 text-[11px] text-ink-muted">
              採用されると、さらに +50pt（一部修正採用なら +30pt）
            </p>
          </div>

          <StepButton disabled={!title.trim() || saving} onClick={submit}>
            {saving ? "送信中…" : "この内容で報告する"}
          </StepButton>
        </section>
      ) : null}
    </div>
  );
}

function StepButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="min-h-14 w-full rounded-2xl bg-brand text-base font-bold text-white shadow-lg shadow-brand/25 transition active:scale-[0.99] disabled:bg-line disabled:text-ink-faint disabled:shadow-none"
    >
      {children}
    </button>
  );
}

function SubmittedScreen({ report }: { report: Report }) {
  const lines = postPointLines(report);
  return (
    <div className="space-y-4 pt-6">
      <div className="animate-pop text-center">
        <p className="text-5xl" aria-hidden>
          🎉
        </p>
        <h1 className="mt-2 text-xl font-bold text-ink">報告ありがとうございます！</h1>
        <p className="mt-1 text-sm text-ink-muted">
          担当者に届きました。内容にかかわらず、必ず返事があります。
        </p>
      </div>

      <PointsBurst lines={lines} />

      <div className="grid gap-2">
        <Link
          href={`/report/${report.id}`}
          className="grid min-h-14 place-items-center rounded-2xl bg-brand text-base font-bold text-white"
        >
          投稿を見る
        </Link>
        <Link
          href="/"
          className="grid min-h-14 place-items-center rounded-2xl border border-line bg-surface text-base font-bold text-ink"
        >
          フィードにもどる
        </Link>
      </div>
    </div>
  );
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl);
  return response.blob();
}
