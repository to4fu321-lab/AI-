import type { BuzzVideo } from "@/data/videos";

export function TrendingWidget({ videos }: { videos: BuzzVideo[] }) {
  const ranked = [...videos].sort((a, b) => b.likes - a.likes).slice(0, 3);

  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
      <h2 className="mb-3 flex items-center gap-1 text-sm font-bold text-neutral-900 dark:text-white">
        📈 今の急上昇ランキング
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
                ❤️ {video.likes.toLocaleString()}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
