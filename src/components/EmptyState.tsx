export function EmptyState({
  emoji = "🗒",
  title,
  description,
}: {
  emoji?: string;
  title: string;
  description?: string;
}) {
  return (
    <div className="card flex flex-col items-center gap-2 px-6 py-12 text-center">
      <span aria-hidden className="text-4xl">
        {emoji}
      </span>
      <p className="text-sm font-bold text-ink">{title}</p>
      {description ? <p className="text-xs text-ink-muted">{description}</p> : null}
    </div>
  );
}

export function LoadingBlock({ label = "読み込み中…" }: { label?: string }) {
  return (
    <div className="space-y-3" aria-live="polite">
      <span className="sr-only">{label}</span>
      {[0, 1, 2].map((i) => (
        <div key={i} className="card h-32 animate-pulse bg-surface" />
      ))}
    </div>
  );
}
