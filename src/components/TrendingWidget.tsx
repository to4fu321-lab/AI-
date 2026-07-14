import type { BuzzVideo, SortMode } from "@/data/videos";
import { sortModes } from "@/data/videos";
import { formatCount } from "@/lib/format";
import { getBreakoutRatio, getSortValue } from "@/lib/ranking";

export function TrendingWidget({
  videos,
  period,
}: {
  videos: BuzzVideo[];
  period: SortMode;
}) {
  const ranked = [...videos]
    .sort((a, b) => getSortValue(b, period) - getSortValue(a, period))
    .slice(0, 3);
  const periodLabel = sortModes.find((p) => p.value === period)?.label ?? "";

  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
      <h2 className="mb-3 flex items-center gap-1 text-sm font-bold text-neutral-900 dark:text-white">
        📈 急上昇ランキング（{periodLabel}）
      </h2>
      <ol className="space-y-3">
        {ranked.map((video, index) => (
          <li key={video.id} className="flex items-start gap-3">
            <span className="mt-0.5 text-lg font-black text-fuchsia-500">
              {index + 1}
            </span>
            <div className="min-w-0">
              <p className="line-clamp-2 text-sm font-semibold text-neutral-800 dark:text-neutral-100">
                {video.title}
              </p>
              <p className="mt-0.5 text-xs text-neutral-400">
                {period === "breakout"
                  ? `🚀 いいねの${Math.round(getBreakoutRatio(video) * 100)}%が本日分`
                  : `❤️ +${formatCount(video.engagement[period])}（${periodLabel}）`}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
