/**
 * まとめサイト（/apps）に並べるアプリの一覧。
 * 新しいアプリを作ったら、ここに 1 件追加するだけでまとめサイトに載り、
 * access に応じたパスワード保護も自動でかかる。
 */

/**
 * 誰が使えるか。
 * - public:     誰でも（パスワードなし）
 * - sale:       個人販売用。アプリごとに別のパスワード（環境変数 PASSWORD_APP_<SLUG>）
 * - ezoshirube: エゾシルベのメンバー用。共通パスワード（PASSWORD_EZOSHIRUBE）
 * - private:    自分だけ（PASSWORD_PRIVATE）。このパスワードは全部の鍵を開けられる
 */
export type Access = "public" | "sale" | "ezoshirube" | "private";

export interface AppEntry {
  /** 英小文字の識別名（販売用パスワードの環境変数名にも使う） */
  slug: string;
  /** 開くときの URL（このサイト内なら "/thumbs"、外部サイトなら "https://..."） */
  href: string;
  name: string;
  /** カードに大きく出す絵文字 */
  emoji: string;
  /** 1〜2 文の説明 */
  description: string;
  /** 絞り込み用のタグ */
  tags: string[];
  /** 公開日（YYYY-MM-DD）。新しい順に並ぶ */
  addedAt: string;
  /** カードの色（Tailwind のグラデーション） */
  color: string;
  access: Access;
  /**
   * パスワードで守る URL の先頭部分。画面だけでなく、そのアプリが使う API も入れること。
   * （public のアプリには不要）
   */
  paths?: string[];
  /** "beta" を付けると「試作」バッジが出る */
  status?: "beta";
}

export const APPS: AppEntry[] = [
  {
    slug: "migrate",
    href: "/migrate",
    name: "アカウント引っ越し",
    emoji: "📬",
    description: "Gmail から登録済みのサービスを洗い出し、ログインページを開いて、新しいメールアドレスへの変更を 1 件ずつ進めます。",
    tags: ["メール", "ツール"],
    addedAt: "2026-11-25",
    color: "from-emerald-500 to-teal-400",
    access: "private",
    paths: ["/migrate", "/api/migrate"],
    status: "beta",
  },
  {
    slug: "autopost",
    href: "/autopost",
    name: "動画オート投稿",
    emoji: "🚀",
    description: "動画を選ぶだけで、YouTube・X・Instagram・会員サイトなど投稿先ごとの題名と本文を AI が作り、簡易編集から投稿まで進めます。",
    tags: ["動画", "AI", "投稿", "ツール"],
    addedAt: "2026-11-22",
    color: "from-violet-500 to-fuchsia-400",
    access: "private",
    paths: ["/autopost", "/api/autopost"],
    status: "beta",
  },
  {
    slug: "members",
    href: "/members",
    name: "会員制動画サイト",
    emoji: "🎟️",
    description: "会員だけがログインして動画を見られるページ。動画オート投稿から「自分の会員サイト」へ投稿したものが並びます。",
    tags: ["動画", "会員制"],
    addedAt: "2026-11-22",
    color: "from-neutral-700 to-neutral-500",
    // 鍵は会員ごとのログイン（/members/login）で守る。共通パスワードの鍵はかけない
    access: "public",
    status: "beta",
  },
  {
    slug: "thumbs",
    href: "/thumbs",
    name: "サムネ収集",
    emoji: "🖼️",
    description: "URL を入れると、その先と下の階層の画像・動画をサムネイルで一覧表示。タップで再生、ダウンロードもできます。",
    tags: ["画像", "動画", "ツール"],
    addedAt: "2026-11-22",
    color: "from-fuchsia-500 to-pink-400",
    access: "private",
    paths: ["/thumbs", "/api/thumbs"],
    status: "beta",
  },
  {
    slug: "repair",
    href: "/repair",
    name: "動画修復",
    emoji: "🛠️",
    description: "撮影の中断や転送の失敗で再生できなくなった MP4・MOV を、iPhone のブラウザだけで修復します。",
    tags: ["動画", "ツール", "iPhone"],
    addedAt: "2026-11-12",
    color: "from-sky-500 to-cyan-400",
    access: "sale",
    paths: ["/repair"],
  },
  {
    slug: "buzztube",
    href: "/",
    name: "BuzzTube",
    emoji: "🔥",
    description: "X や YouTube で今バズっている動画を AI が集めて要約するキュレーションサイト。",
    tags: ["動画", "AI", "まとめ"],
    addedAt: "2026-05-23",
    color: "from-orange-500 to-amber-400",
    access: "public",
  },
];
