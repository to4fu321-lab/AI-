export function TrendingKeywords({
  keywords,
  onSelect,
}: {
  keywords: string[];
  onSelect: (keyword: string) => void;
}) {
  if (keywords.length === 0) return null;

  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
      <h2 className="mb-3 text-sm font-bold text-neutral-900 dark:text-white">
        🔍 注目キーワード
      </h2>
      <div className="flex flex-wrap gap-2">
        {keywords.map((keyword) => (
          <button
            key={keyword}
            type="button"
            onClick={() => onSelect(keyword)}
            className="rounded-full bg-neutral-100 px-3 py-1 text-xs font-semibold text-neutral-600 transition hover:bg-fuchsia-100 hover:text-fuchsia-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-fuchsia-900/40 dark:hover:text-fuchsia-300"
          >
            #{keyword}
          </button>
        ))}
      </div>
    </div>
  );
}
