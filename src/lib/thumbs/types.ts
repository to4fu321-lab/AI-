/** クローラーが見つけた 1 件のメディア（画像・動画・埋め込み動画）。 */
export interface MediaItem {
  /** 重複除去に使うキー（正規化した src） */
  id: string;
  /** image: 画像 / video: 動画ファイル / embed: YouTube などの埋め込み動画 */
  kind: "image" | "video" | "embed";
  /** 本体の URL（画像そのもの、動画ファイル、または埋め込みプレーヤーの URL） */
  src: string;
  /** 一覧に出すサムネイル。動画でポスター画像がない場合は省略 */
  thumb?: string;
  /** 見つかったページ */
  pageUrl: string;
  /** 拡張子などから判定した形式（JPG, PNG, GIF, MP4, M3U8, YouTube ...） */
  format?: string;
  /** alt やタイトルなどの説明 */
  title?: string;
  /** HTML に書かれていたサイズ（あれば） */
  width?: number;
  height?: number;
}

/** /api/thumbs/crawl が 1 行ずつ返すイベント（NDJSON）。 */
export type CrawlEvent =
  | { type: "page"; url: string; depth: number; found: number }
  | { type: "media"; items: MediaItem[] }
  | { type: "skip"; url: string; reason: string }
  | { type: "error"; url: string; message: string }
  | { type: "done"; pages: number; media: number; truncated: boolean };

export interface CrawlOptions {
  /** 入力ページから何階層下までリンクを辿るか（0 = 入力ページのみ） */
  depth: number;
  /** 読み込むページ数の上限 */
  maxPages: number;
}
