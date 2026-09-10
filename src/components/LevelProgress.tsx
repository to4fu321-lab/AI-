import { levelOf } from "@/lib/points";

export function LevelProgress({ points }: { points: number }) {
  const level = levelOf(points);
  const remaining = level.next ? level.next - points : 0;

  return (
    <div className="w-full">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-body font-bold text-ink">{level.name}</span>
        <span className="text-num text-brand">
          {points}
          <span className="ml-0.5 text-note font-bold text-ink-muted">pt</span>
        </span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-canvas"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(level.progress * 100)}
        aria-label={`${level.name}の進捗`}
      >
        <div
          className="h-full rounded-full bg-brand transition-all duration-700"
          style={{ width: `${Math.max(4, level.progress * 100)}%` }}
        />
      </div>
      <p className="mt-1 text-note text-ink-muted">
        {level.next
          ? `あと ${remaining}pt で「${level.nextName}」`
          : "最高レベルに到達しています"}
      </p>
    </div>
  );
}
