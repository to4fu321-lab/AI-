/**
 * 型定義と固定の選択肢（カテゴリー・地域・急上昇期間）。
 * 実際の動画データは Supabase の `buzztube_videos` テーブルから取得する
 * （src/lib/videos.ts の getVideos）。OpenClaw / Make などの外部ワークフローは
 * POST /api/videos にこの BuzzVideo 相当の項目を送ることで動的にページへ反映できる。
 */

export type Platform = "youtube" | "x";

/** いいねが付いた時期・勢いを見るための増加数（各期間中に「新たに」付いた数） */
export interface EngagementStats {
  /** 直近1時間ほどの勢い */
  now: number;
  /** 本日中の増加数 */
  today: number;
  /** 直近7日間の増加数 */
  week: number;
}

export interface BuzzVideo {
  id: string;
  platform: Platform;
  /** 元動画・投稿の URL */
  sourceUrl: string;
  /** YouTube の video ID、または X の status ID */
  embedId: string;
  title: string;
  /** AIが自動生成したバズ解説テキスト（3行程度） */
  aiSummary: string;
  category: string;
  /** 投稿・話題の発信地域（国内 / 海外 など。将来的に都道府県レベルまで拡張予定） */
  region: string;
  channelName: string;
  postedAt: string;
  /** 実際の投稿日時（ISO文字列）。本日投稿・ブレイク判定に使用 */
  publishedAt: string;
  /** 累計いいね数 */
  likes: number;
  favorites: number;
  /** 期間別のいいね増加数（急上昇タブの並び替えに使用） */
  engagement: EngagementStats;
}

export const categories = ["おもしろ", "癒やし", "ライフハック"];

export const regions = ["国内", "海外"];

export const platformOptions: { value: Platform; label: string }[] = [
  { value: "youtube", label: "YouTube" },
  { value: "x", label: "X" },
];

export type TrendingPeriod = "now" | "today" | "week";

export const trendingPeriods: { value: TrendingPeriod; label: string }[] = [
  { value: "now", label: "今" },
  { value: "today", label: "今日" },
  { value: "week", label: "1週間" },
];

/**
 * 「本日ブレイク」= 今日投稿してバズった動画も、ずっと無風だったのに
 * 今日急に伸びた動画も、どちらも見つけられる並び替えモード。
 */
export type SortMode = TrendingPeriod | "breakout";

export const sortModes: { value: SortMode; label: string }[] = [
  ...trendingPeriods,
  { value: "breakout", label: "🚀本日ブレイク" },
];

/**
 * Supabase 未設定時や取得失敗時のフォールバック。
 * ダミーの演出データは置かず、空にして「取得できていない」ことが分かるようにしている。
 */
export const FALLBACK_VIDEOS: BuzzVideo[] = [];
