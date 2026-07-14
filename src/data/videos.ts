/**
 * ダミーの動画データ。
 * 将来的には OpenClaw / Make(Integromat) などの外部ワークフローから
 * この同じ形（BuzzVideo[]）で API 経由で流し込み、動的に一覧を生成する想定。
 * 今はこの配列を書き換える／fetch() の結果に差し替えるだけで済むようにしてある。
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
  /** 累計いいね数 */
  likes: number;
  favorites: number;
  /** 期間別のいいね増加数（急上昇タブの並び替えに使用） */
  engagement: EngagementStats;
}

export const categories = ["おもしろ", "癒やし", "ライフハック"];

export const regions = ["国内", "海外"];

export type TrendingPeriod = "now" | "today" | "week";

export const trendingPeriods: { value: TrendingPeriod; label: string }[] = [
  { value: "now", label: "今" },
  { value: "today", label: "今日" },
  { value: "week", label: "1週間" },
];

export const buzzVideos: BuzzVideo[] = [
  {
    id: "buzz-001",
    platform: "youtube",
    sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    embedId: "dQw4w9WgXcQ",
    title: "誰かに送りつけると必ずコレが流れる、伝説の“釣りリンク”動画",
    aiSummary:
      "「絶対見て」というリンクを開くと必ずこの曲が流れる、通称“リックロール”の元祖動画。悪ふざけのつもりで開いたのに、曲とダンスのクオリティの高さに最後まで見入ってしまう人が続出し、ミーム文化を知らない世代からも再評価されています。",
    category: "おもしろ",
    region: "海外",
    channelName: "Rick Astley",
    postedAt: "3時間前",
    likes: 128000,
    favorites: 5400,
    engagement: { now: 820, today: 6200, week: 24500 },
  },
  {
    id: "buzz-002",
    platform: "youtube",
    sourceUrl: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    embedId: "jNQXAC9IVRw",
    title: "YouTube史上“最初の投稿”がなぜか今また伸びている",
    aiSummary:
      "映っているのは象を19秒間ただ眺めるだけの映像。凝った編集も演出も一切ない、YouTube最初の投稿がかえって新鮮だと再注目されています。情報過多の反動からか「なにも起きない動画」を求める人が増えているようです。",
    category: "癒やし",
    region: "海外",
    channelName: "jawed",
    postedAt: "5時間前",
    likes: 45200,
    favorites: 2100,
    engagement: { now: 260, today: 3100, week: 15800 },
  },
  {
    id: "buzz-003",
    platform: "x",
    sourceUrl: "https://twitter.com/Interior/status/463440424141459456",
    embedId: "463440424141459456",
    title: "1枚の自然写真が“5秒でできる息抜き”として拡散中",
    aiSummary:
      "国立公園の公式アカウントが投稿した、雄大な自然の写真1枚。忙しい合間にタイムラインでふと目に入り「数秒眺めるだけで気分転換になる」とリプライ欄で話題に。ちょっとした休憩テクニックとして保存・共有する人が増えています。",
    category: "ライフハック",
    region: "海外",
    channelName: "US Department of the Interior",
    postedAt: "1日前",
    likes: 8600,
    favorites: 610,
    engagement: { now: 90, today: 1400, week: 5200 },
  },
];
