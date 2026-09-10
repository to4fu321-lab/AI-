"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { LoadingBlock } from "@/components/EmptyState";
import { PhotoField } from "@/components/PhotoField";
import { PointsBurst } from "@/components/PointsBurst";
import { AREAS, REPORT_TYPES, URGENCIES } from "@/lib/labels";
import { postPointLines, postPoints } from "@/lib/points";
import { putImage } from "@/lib/storage";
import { createReport, useDemoState } from "@/lib/store";
import type { Report, ReportType, Urgency } from "@/lib/types";

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
  if (created) return <SubmittedScreen report={created} />;

  const submit = async () => {
    if (!type || !title.trim()) return;
    setSaving(true);
    try {
      const beforeRef = before ? await putImage(await dataUrlToBlob(before)) : undefined;
      const afterRef = after ? await putImage(await dataUrlToBlob(after)) : undefined;
      setCreated(
        createReport({
          type,
          urgency,
          title,
          body,
          area,
          areaNote,
          anonymous,
          beforeImage: beforeRef,
          afterImage: afterRef,
        }),
      );
    } finally {
      setSaving(false);
    }
  };

  const points = postPoints({
    beforeImage: before ?? undefined,
    afterImage: after ?? undefined,
  });

  return (
    <div className="space-y-5">
      <button
        type="button"
        onClick={() => (step === 0 ? router.push("/") : setStep(step - 1))}
        className="inline-flex min-h-11 items-center text-body font-bold text-ink-muted"
      >
        ← {step === 0 ? "やめる" : "もどる"}
      </button>

      <div className="flex gap-1.5" aria-hidden>
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className={`h-1 flex-1 rounded-full ${index <= step ? "bg-brand" : "bg-line"}`}
          />
        ))}
      </div>

      {step === 0 ? (
        <section className="space-y-4">
          <h1 className="text-title text-ink">どんな内容ですか？</h1>
          <div className="grid grid-cols-2 gap-2.5">
            {REPORT_TYPES.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => setType(item.value)}
                aria-pressed={type === item.value}
                className={`card flex min-h-28 flex-col items-start gap-1 p-3.5 text-left transition ${
                  type === item.value ? "border-brand bg-brand-soft" : ""
                }`}
              >
                <span aria-hidden className="text-xl">
                  {item.emoji}
                </span>
                <span className="text-head text-ink">{item.label}</span>
                <span className="text-note text-ink-muted">{item.hint}</span>
              </button>
            ))}
          </div>

          <div>
            <p className="mb-2 text-body font-bold text-ink">急ぎ具合</p>
            <div className="flex gap-2">
              {[...URGENCIES].reverse().map((item) => (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => setUrgency(item.value)}
                  aria-pressed={urgency === item.value}
                  className={`min-h-11 flex-1 rounded-full border text-note font-bold transition ${
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
          <h1 className="text-title text-ink">写真で伝えましょう</h1>
          <p className="-mt-2 text-note text-ink-muted">
            撮った写真に、指で丸や矢印を書き込めます。
          </p>
          <PhotoField label="現状（Before）" hint="任意" value={before} onChange={setBefore} />
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
          <h1 className="text-title text-ink">ひとことで教えてください</h1>

          <div className="card space-y-4 p-4">
            <Field label="タイトル">
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={40}
                placeholder="例）棚のラベルが小さくて見えない"
                className="min-h-12 w-full rounded-lg border border-line bg-canvas px-3 text-body text-ink outline-none focus:border-brand"
              />
            </Field>

            <Field label="くわしく（任意）">
              <textarea
                value={body}
                onChange={(event) => setBody(event.target.value)}
                rows={4}
                placeholder="ひとことでも大丈夫です"
                className="w-full rounded-lg border border-line bg-canvas p-3 text-body text-ink outline-none focus:border-brand"
              />
            </Field>

            <Field label="場所">
              <select
                value={area}
                onChange={(event) => setArea(event.target.value)}
                className="min-h-12 w-full rounded-lg border border-line bg-canvas px-3 text-body text-ink outline-none focus:border-brand"
              >
                {AREAS.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="場所のメモ（任意）">
              <input
                value={areaNote}
                onChange={(event) => setAreaNote(event.target.value)}
                maxLength={40}
                placeholder="例）A-3通路の突き当たり"
                className="min-h-12 w-full rounded-lg border border-line bg-canvas px-3 text-body text-ink outline-none focus:border-brand"
              />
            </Field>

            <label className="flex min-h-11 items-center justify-between gap-3">
              <span className="text-body text-ink">匿名で投稿する</span>
              <input
                type="checkbox"
                checked={anonymous}
                onChange={(event) => setAnonymous(event.target.checked)}
                className="h-6 w-6 accent-[#ea5504]"
              />
            </label>
          </div>

          <p className="text-center text-note text-ink-muted">
            送信すると <span className="font-bold text-brand">+{points}pt</span>
            ・採用されるとさらに +50pt
          </p>

          <StepButton disabled={!title.trim() || saving} onClick={submit}>
            {saving ? "送信中…" : "この内容で報告する"}
          </StepButton>
        </section>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-note text-ink-muted">{label}</span>
      {children}
    </label>
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
      className="min-h-14 w-full rounded-full bg-brand text-head text-white transition active:scale-[0.99] disabled:bg-line disabled:text-ink-faint"
    >
      {children}
    </button>
  );
}

function SubmittedScreen({ report }: { report: Report }) {
  return (
    <div className="space-y-5 pt-8">
      <div className="animate-pop text-center">
        <p className="text-4xl" aria-hidden>
          🎉
        </p>
        <h1 className="mt-2 text-title text-ink">報告ありがとうございます！</h1>
        <p className="mt-1 text-note text-ink-muted">
          担当者に届きました。内容にかかわらず、必ず返事があります。
        </p>
      </div>

      <PointsBurst lines={postPointLines(report)} />

      <div className="grid gap-2">
        <Link
          href={`/report/${report.id}`}
          className="grid min-h-14 place-items-center rounded-full bg-brand text-head text-white"
        >
          投稿を見る
        </Link>
        <Link
          href="/"
          className="grid min-h-14 place-items-center rounded-full border border-line bg-surface text-head text-ink"
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
