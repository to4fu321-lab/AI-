export function AdSlot({
  className = "",
  label = "ここに広告タグが入ります",
}: {
  className?: string;
  label?: string;
}) {
  return (
    <div
      className={`flex items-center justify-center rounded-2xl border-2 border-dashed border-neutral-300 bg-neutral-100/60 text-center dark:border-neutral-700 dark:bg-neutral-900/50 ${className}`}
    >
      <div className="space-y-1 p-6">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-neutral-400 dark:text-neutral-600">
          Advertisement
        </p>
        <p className="text-sm font-medium text-neutral-400 dark:text-neutral-600">
          {label}
        </p>
      </div>
    </div>
  );
}
