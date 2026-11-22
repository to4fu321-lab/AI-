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
  | { type: "note"; url: string; message: string }
  | { type: "error"; url: string; message: string }
  | { type: "continue"; state: CrawlState }
  | { type: "done"; pages: number; media: number; truncated: boolean };

export interface CrawlOptions {
  /** 入力ページから何階層下までリンクを辿るか（0 = 入力ページのみ、最大 20） */
  depth: number;
  /** 読み込むページ数の上限（全体） */
  maxPages: number;
  /** ページ送り（2ページ目・次へ）を何ページまで辿るか */
  maxPagination: number;
  /** true なら入力したサイト以外へのリンクも辿る */
  crossSite: boolean;
  /**
   * ブラウザ（Chromium）で開いて JavaScript の描画後に集めるか。
   * auto: JavaScript で描くページで画像がほとんど取れないときだけ / always: 毎回 / off: 使わない
   */
  render: "auto" | "always" | "off";
}

export interface QueueItem {
  url: string;
  depth: number;
}

/**
 * クロールの途中経過。サーバーの 1 回の実行時間には上限があるので、
 * 時間切れの前にこれを画面へ返し、画面がそのまま送り返して続きをやってもらう。
 */
export interface CrawlState {
  queue: QueueItem[];
  seen: string[];
  pages: number;
  paginationUsed: number;
}
