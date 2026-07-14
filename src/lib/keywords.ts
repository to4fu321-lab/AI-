import type { BuzzVideo } from "@/data/videos";

/** YouTubeの定型ハッシュタグなど、話題性のない汎用語を除外する */
const STOPWORDS = new Set([
  "shorts",
  "youtube",
  "youtubeshorts",
  "おすすめ",
  "公式",
  "切り抜き",
]);

/**
 * タイトル中の【】括弧内タグや #ハッシュタグを集計し、
 * 複数動画で繰り返し登場するものを「注目キーワード」として抽出する。
 */
export function extractTrendingKeywords(videos: BuzzVideo[], limit = 8): string[] {
  const counts = new Map<string, number>();

  const addKeyword = (raw: string) => {
    const keyword = raw.trim();
    if (keyword.length < 2 || keyword.length > 12) return;
    if (STOPWORDS.has(keyword.toLowerCase())) return;
    counts.set(keyword, (counts.get(keyword) ?? 0) + 1);
  };

  for (const video of videos) {
    const bracketMatches = video.title.match(/【([^】]+)】/g) ?? [];
    for (const bracket of bracketMatches) {
      const inner = bracket.slice(1, -1);
      inner.split(/[/・]/).forEach(addKeyword);
    }

    const hashtags = video.title.match(/#[^\s#]+/g) ?? [];
    hashtags.forEach((tag) => addKeyword(tag.slice(1)));
  }

  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([keyword]) => keyword);
}
