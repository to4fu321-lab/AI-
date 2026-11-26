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
  /** 見つかったページ（「元ページ」で開く場所） */
  pageUrl: string;
  /**
   * 再生・保存のときに Referer として名乗るページ。iframe の中のプレーヤーで見つけた動画は
   * そのプレーヤーのページでないと再生を断られることがあるため、pageUrl と別に持つ
   */
  referer?: string;
  /** 拡張子などから判定した形式（JPG, PNG, GIF, MP4, M3U8, YouTube ...） */
  format?: string;
  /** alt やタイトルなどの説明 */
  title?: string;
  /** 動画の再生時間（秒）。ファイルの中・ページの情報・一覧のカードの表示から */
  duration?: number;
  /** HTML に書かれていたサイズ（あれば） */
  width?: number;
  height?: number;
  /**
   * URL の見た目だけで動画と判断したもの（リンクやスクリプト内の文字列）。
   * 本当に動画ファイルか、サーバーが一覧に出す前に確かめる。画面には送らない
   */
  unverified?: boolean;
  /**
   * 拡張子もなく、キー名（"video_url" など）だけで動画かもしれないと見たもの。
   * 動画だと確かめられなかったときは一覧に出さない。画面には送らない
   */
  guess?: boolean;
  /**
   * リンク切れでないと確かめた印。サーバーは true を付けて送り、画面は受け取った時刻（ミリ秒）に置き換えて保存する。
   * 画面は、確かめてから時間がたったもの・印のないものを、確かめ直してから表示する
   */
  checked?: boolean | number;
  /**
   * 中身の指紋（ファイル全体の大きさ＋先頭の要約）。URL が違っても指紋が同じなら同じファイルなので、2 個目は出さない
   */
  fp?: string;
  /**
   * ファイルを読むときに送る Cookie（"ドメイン|名前=値"）。Gofile のように、合言葉がないとファイルを渡さないサービス用。
   * 確認・再生・保存のときに、そのドメイン宛てにだけ送る
   */
  cookie?: string;
  /** サーバー内部用：確かめようとして時間切れになった回数 */
  tries?: number;
}

/** /api/thumbs/crawl が 1 行ずつ返すイベント（NDJSON）。 */
export type CrawlEvent =
  /** gofile：Gofile のフォルダを読み終えた印（ok: 中身があった / gone: 消されていた・空だった）。画面が「読んだフォルダ」として覚える */
  | { type: "page"; url: string; depth: number; found: number; gofile?: "ok" | "gone" }
  | { type: "media"; items: MediaItem[] }
  | { type: "skip"; url: string; reason: string }
  | { type: "note"; url: string; message: string }
  /**
   * サイトが「人間かどうかの確認」を求める・自動アクセスを断るので読めなかったページ、
   * または読めたが動画を取り出せなかったページ（サムネイルだけでも見せる）。
   * 画面は、そのページを本人のブラウザで開くボタンを出す（サイト自体にアクセスしてもらう）
   */
  | { type: "gated"; url: string; thumb?: string; title?: string; duration?: number; video?: string; app?: string }
  | { type: "error"; url: string; message: string }
  | { type: "continue"; state: CrawlState }
  /** 途中経過の記録（数秒おき）。止まったときに画面がここから再開できる */
  | { type: "checkpoint"; state: CrawlState }
  /** truncated（ページ数の上限で打ち切り）のときは、続きのための state も付く */
  | { type: "done"; pages: number; media: number; truncated: boolean; state?: CrawlState };

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
  /** 取得する種類：すべて / 動画のみ / 画像のみ */
  kinds: "all" | "video" | "image";
  /** 除外リスト（取得しないサイト・URL。exclude.ts の書き方） */
  exclude: string[];
  /** robots.txt（サイトが出している「自動で読まないでほしい場所」の指定）を守るか。入力したページ自体は常に読む */
  robots: boolean;
  /**
   * ネット全体から探す。検索結果のページから出発して、結果のサイト（X の投稿・掲示板・まとめ・動画サイト）を辿る。
   * 検索サイト自身のメニューは辿らず、結果のサイトの中では動画らしいリンクだけを辿る
   */
  hunt?: boolean;
  /** Gofile 探し：Gofile のリンクの中身だけを集める（ほかの動画・読めなかったページのタイルは出さない） */
  gofileOnly?: boolean;
  /** ファイル置き場を探すとき、集めない置き場（Gofile・pixeldrain・Google ドライブ・Dropbox・catbox のうち、設定で外したもの） */
  skipHosts?: string[];
  /** 前に読んだ Gofile のフォルダの番号（画面が覚えているもの）。もう一度は聞かない（Gofile への問い合わせを減らす） */
  knownGofile?: string[];
  /**
   * 前に動画が見つかったページ（画面・巡回が覚えているもの。入力したページと同じ形に正規化前の URL）。
   * そこへのリンクは辿らない（新しく増えたページだけを読む。サイトへの問い合わせも減り、確認を求められにくくなる）。
   * 入力したページとページ送り（一覧の続き）は、新しいリンクを見つけるために、いつも読む
   */
  knownPages?: string[];
  /** 前に動画を取り出した X の投稿の番号。もう一度は聞かず、その番号の入ったページへのリンクも辿らない */
  knownTweets?: string[];
  /**
   * 入力したページの中身（HTML）。本人のブラウザで開いているページを、ブックマークレットでこのアプリに送ったもの。
   * これがあれば、入力したページはサーバーから読みに行かず、この中身を使う（確認を求めるサイトでも、本人が見ているページは読める）
   */
  rootHtml?: string;
  /** Gofile のアカウントトークン（画面で設定したもの。なければゲスト登録する） */
  gofileToken?: string;
  /** gofile-douga の新着を読むとき、X に投稿された Gofile のリンクも探すか（省略時は探す） */
  alsoX?: boolean;
  /** 自動巡回用：使ってよいトークン（上から順に。断られたら次へ） */
  gofileTokens?: string[];
}

export interface QueueItem {
  url: string;
  /** 入力ページからリンクを何回辿ったか（「下の階層」の上限に使う） */
  depth: number;
  /**
   * 読む順番の段（小さいほど先）。ページ送りも 1 段進めるので、
   * 「一覧 1 ページ目 → その詳細ページ → 一覧 2 ページ目 → …」の順に交互に読める
   */
  rank?: number;
  /** 同じ段の中での優先度（大きいほど先）。サムネイル付きリンク・動画らしいリンクが上 */
  prio?: number;
  /** このページへのリンクに付いていたサムネイル（詳細ページの動画のサムネイルに引き継ぐ） */
  thumb?: string;
  /**
   * 入力した場所から見た範囲。0（省略）: 入力した階層の中 / 1: 同じサイトの別の場所 / 2: 別のサイト。
   * 1・2 のページは「動画を探すため」に読むので、画像は集めない
   */
  zone?: number;
  /** このページへのリンクのカードに出ていた再生時間（秒）。詳細ページの動画に引き継ぐ */
  duration?: number;
  /** このページへのリンクのカードに書かれていた題名（サイトが付けた動画のタイトル）。詳細ページの動画に引き継ぐ */
  title?: string;
  /** 一覧ページのカードにあったプレビュー動画（この詳細ページに本編が見つからなければ、代わりに出す） */
  preview?: string;
  /** このページへのリンクがあったページ（リンク先がそのまま動画ファイルだったとき、元ページ・Referer にする） */
  from?: string;
  /** サイトが機械向けに出している一覧（サイトマップ・RSS）として読むもの */
  feed?: boolean;
  /** 一覧の続きが断られて読めず、後でもう一度試すことにした回数 */
  retry?: number;
  /** 入力したページ（とそこからの自動転送先）。ここを基準に「同じサイト・同じ階層」を決める */
  root?: boolean;
}

/** 「同じサイト・同じ階層」の基準（入力したページが転送された先に合わせる） */
export interface CrawlHome {
  /** 同じサイトとみなすドメイン（example.com なら www. や m. も同じ扱い） */
  sites: string[];
  /** 入力した階層（/gallery/ など） */
  scope: string;
  /** 入力したページのパス */
  path: string;
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
  /** 範囲や階層の外だったので後回しにしたリンク。動画が見つからないときに、ここから範囲を広げる */
  reserve?: QueueItem[];
  /** ここまでに見つけた動画の数 */
  videos?: number;
  /** ここまでに見つけた画像・動画の数 */
  found?: number;
  /** 範囲を広げて読んだページ数（0 ならまだ広げていない） */
  widened?: number;
  home?: CrawlHome;
  /** 見つけたが、まだリンク切れかどうか確かめていない画像・動画 */
  pending?: MediaItem[];
  /** 送った画像・動画の中身の指紋 */
  prints?: string[];
  /**
   * 1 回の実行の時間切れまでに読み終わらなかったページと、その回数（[正規化した URL, 回数]）。
   * 1 回目は時間のかかる処理（ブラウザで開く等）をせずに読み直し、2 回目は飛ばす
   */
  stuck?: [string, number][];
  /** 見つけたが出さなかった動画の数 [ファイルがない, サイトに断られた] */
  dropped?: [number, number];
  /** 動画が見つからなかったページの「形」と、その数（同じ形のページは読まなくなる） */
  barren?: [string, number][];
  /** 動画が見つかったページの「形」 */
  fruitful?: string[];
  /** サイトから渡された Cookie（ドメイン, "a=b; c=d"） */
  cookies?: [string, string][];
}
