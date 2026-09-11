import type { Report } from "@/lib/types";

/**
 * 「報告して終わり」にしないための要。
 * 改善前 → 実施した改善 → 改善後 を1つの流れとして見せる。
 * 完了していない報告では、まだ埋まっていない段を薄く見せて先を示す。
 */
export function ImprovementStory({ report }: { report: Report }) {
  const decided = [...report.actions]
    .reverse()
    .find((action) => action.type === "adopted" || action.type === "partial");
  const finished = [...report.actions].reverse().find((action) => action.type === "done");

  // 採用もされていない段階では、まだストーリーとして見せない
  if (!decided) return null;

  return (
    <section className="card p-4">
      <h2 className="mb-3 text-head text-ink">改善のあゆみ</h2>
      <ol className="space-y-3">
        <Step label="改善前" text={report.body || report.title} />
        <Step
          label="実施した改善"
          text={decided.comment || "採用が決まりました"}
          note={decided.plannedDate ? `実施予定：${decided.plannedDate}` : undefined}
        />
        {finished ? (
          <Step label="改善後" text={finished.comment} tone="done" />
        ) : (
          <Step label="改善後" text="対応が完了すると、現場がどう変わったかが記録されます" tone="pending" />
        )}
      </ol>
    </section>
  );
}

function Step({
  label,
  text,
  note,
  tone = "normal",
}: {
  label: string;
  text: string;
  note?: string;
  tone?: "normal" | "done" | "pending";
}) {
  return (
    <li>
      <p
        className={`text-note font-bold ${
          tone === "done" ? "text-dot-adopted" : tone === "pending" ? "text-ink-faint" : "text-ink-muted"
        }`}
      >
        {label}
      </p>
      <p
        className={`mt-0.5 whitespace-pre-wrap text-body ${
          tone === "pending" ? "text-ink-faint" : "text-ink"
        }`}
      >
        {text}
      </p>
      {note ? <p className="mt-0.5 text-note text-ink-muted">{note}</p> : null}
    </li>
  );
}
