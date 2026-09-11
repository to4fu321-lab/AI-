import type { BuzzVideo, SortMode } from "@/data/videos";

/**
 * 「本日ブレイク」は、いいねの何割が今日ついたか（今日投稿でも、
 * 長らく無風だった動画が今日急に伸びても、どちらも比率が高くなる）で判定する。
 */
export function getBreakoutRatio(video: BuzzVideo): number {
  return video.engagement.today / Math.max(video.likes, 1);
}

export function getSortValue(video: BuzzVideo, mode: SortMode): number {
  if (mode === "breakout") return getBreakoutRatio(video);
  return video.engagement[mode];
}

export function isPostedToday(video: BuzzVideo, now: Date = new Date()): boolean {
  const published = new Date(video.publishedAt);
  return (
    published.getUTCFullYear() === now.getUTCFullYear() &&
    published.getUTCMonth() === now.getUTCMonth() &&
    published.getUTCDate() === now.getUTCDate()
  );
}

const BREAKOUT_THRESHOLD = 0.5;

export function isBreakout(video: BuzzVideo): boolean {
  return getBreakoutRatio(video) >= BREAKOUT_THRESHOLD;
}
