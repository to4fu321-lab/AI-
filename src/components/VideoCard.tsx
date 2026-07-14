import type { BuzzVideo } from "@/data/videos";
import { trendingPeriods } from "@/data/videos";
import { formatCount } from "@/lib/format";
import { isBreakout, isPostedToday } from "@/lib/ranking";
import { YouTubeEmbed } from "./YouTubeEmbed";
import { XEmbed } from "./XEmbed";

export function VideoCard({ video }: { video: BuzzVideo }) {
  const postedToday = isPostedToday(video);
  const breakout = isBreakout(video);

  return (
    <article className="flex flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg dark:border-neutral-800 dark:bg-neutral-900">
      {video.platform === "youtube" ? (
        <YouTubeEmbed videoId={video.embedId} title={video.title} />
      ) : (
        <XEmbed statusUrl={video.sourceUrl} />
      )}

      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center rounded-full bg-fuchsia-100 px-2.5 py-1 text-xs font-semibold text-fuchsia-700 dark:bg-fuchsia-900/40 dark:text-fuchsia-300">
              {video.category}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-semibold text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
              📍{video.region}
            </span>
            {postedToday && (
              <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                🆕本日投稿
              </span>
            )}
            {breakout && (
              <span className="inline-flex items-center rounded-full bg-orange-100 px-2.5 py-1 text-xs font-semibold text-orange-700 dark:bg-orange-900/40 dark:text-orange-300">
                🚀本日ブレイク
              </span>
            )}
          </div>
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

        <div className="flex items-center justify-between gap-2 rounded-xl border border-neutral-100 px-3 py-2 text-xs dark:border-neutral-800">
          {trendingPeriods.map(({ value, label }) => (
            <div key={value} className="flex flex-col items-center">
              <span className="text-neutral-400">{label}</span>
              <span className="font-bold text-fuchsia-600 dark:text-fuchsia-400">
                +{formatCount(video.engagement[value])}
              </span>
            </div>
          ))}
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
