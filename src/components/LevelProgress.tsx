import { levelOf } from "@/lib/points";

export function LevelProgress({
  points,
  compact = false,
}: {
  points: number;
  compact?: boolean;
}) {
  const level = levelOf(points);
  const remaining = level.next ? level.next - points : 0;

  return (
    <div className="w-full">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className={`font-bold text-ink ${compact ? "text-xs" : "text-sm"}`}>
          {level.name}
        </span>
        <span className={`font-bold text-brand ${compact ? "text-sm" : "text-lg"}`}>
          {points}
          <span className="ml-0.5 text-[11px] text-ink-muted">pt</span>
        </span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-canvas"
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
      {level.next ? (
        <p className="mt-1 text-[11px] text-ink-muted">
          あと <span className="font-bold text-ink">{remaining}pt</span> で「{level.nextName}
          」
        </p>
      ) : (
        <p className="mt-1 text-[11px] text-ink-muted">最高レベルに到達しています 🎉</p>
      )}
    </div>
  );
}
