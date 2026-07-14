/**
 * ダミーの動画データ。
 * 将来的には OpenClaw / Make(Integromat) などの外部ワークフローから
 * この同じ形（BuzzVideo[]）で API 経由で流し込み、動的に一覧を生成する想定。
 * 今はこの配列を書き換える／fetch() の結果に差し替えるだけで済むようにしてある。
 */

export type Platform = "youtube" | "x";

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
  channelName: string;
  postedAt: string;
  likes: number;
  favorites: number;
}

export const categories = ["おもしろ", "癒やし", "ライフハック"];

export const buzzVideos: BuzzVideo[] = [
  {
    id: "buzz-001",
    platform: "youtube",
    sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    embedId: "dQw4w9WgXcQ",
    title: "伝説の“釣りリンク”動画、今なお世界を席巻中",
    aiSummary:
      "SNSで“釣りリンク”として貼られ続ける伝説の一曲がまた急上昇。何度見ても思わずニヤけてしまう中毒性の高いパフォーマンスが再拡散のきっかけに。世代を超えて愛される定番ネタとして、コメント欄も盛り上がっています。",
    category: "おもしろ",
    channelName: "Rick Astley",
    postedAt: "3時間前",
    likes: 128000,
    favorites: 5400,
  },
  {
    id: "buzz-002",
    platform: "youtube",
    sourceUrl: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    embedId: "jNQXAC9IVRw",
    title: "YouTube史上“最初の動画”が今また話題に",
    aiSummary:
      "わずか19秒のシンプルな映像が“原点回帰”ブームに乗って再燃中。動物園でのなにげない一コマが、歴史的価値と相まってタイムラインを席巻しています。飾らない日常感が逆に新鮮だという声も。",
    category: "癒やし",
    channelName: "jawed",
    postedAt: "5時間前",
    likes: 45200,
    favorites: 2100,
  },
  {
    id: "buzz-003",
    platform: "x",
    sourceUrl: "https://twitter.com/Interior/status/463440424141459456",
    embedId: "463440424141459456",
    title: "研究者も驚いた、自然界の“渋滞回避術”",
    aiSummary:
      "野生バイソンの群れ移動を捉えた一枚が“交通渋滞の教科書”としてまさかの拡散。統率の取れたフォーメーションに、日常の工程管理にも応用できるヒントがあると話題になっています。",
    category: "ライフハック",
    channelName: "US Department of the Interior",
    postedAt: "1日前",
    likes: 8600,
    favorites: 610,
  },
];
