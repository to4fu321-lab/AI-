import type { BuzzVideo } from "@/data/videos";
import { YouTubeEmbed } from "./YouTubeEmbed";
import { XEmbed } from "./XEmbed";

function formatCount(n: number) {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function VideoCard({ video }: { video: BuzzVideo }) {
  return (
    <article className="flex flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg dark:border-neutral-800 dark:bg-neutral-900">
      {video.platform === "youtube" ? (
        <YouTubeEmbed videoId={video.embedId} title={video.title} />
      ) : (
        <XEmbed statusUrl={video.sourceUrl} />
      )}

      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center rounded-full bg-fuchsia-100 px-2.5 py-1 text-xs font-semibold text-fuchsia-700 dark:bg-fuchsia-900/40 dark:text-fuchsia-300">
            {video.category}
          </span>
          <span className="text-xs text-neutral-400">{video.postedAt}</span>
        </div>

        <h3 className="line-clamp-2 text-base font-bold leading-snug text-neutral-900 dark:text-neutral-50">
          {video.title}
        </h3>

        <div className="rounded-xl bg-neutral-50 p-3 dark:bg-neutral-800/60">
          <p className="mb-1 flex items-center gap-1 text-[11px] font-semibold text-neutral-400">
            🤖 AIバズ解説
          </p>
          <p className="line-clamp-3 text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">
            {video.aiSummary}
          </p>
        </div>

        <div className="mt-auto flex items-center justify-between border-t border-neutral-100 pt-3 dark:border-neutral-800">
          <span className="truncate text-xs font-medium text-neutral-400">
            @{video.channelName}
          </span>
          <div className="flex shrink-0 items-center gap-3">
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-neutral-500 dark:text-neutral-400">
              ❤️ {formatCount(video.likes)}
            </span>
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-neutral-500 dark:text-neutral-400">
              ⭐ {formatCount(video.favorites)}
            </span>
          </div>
        </div>
      </div>
    </article>
  );
}
