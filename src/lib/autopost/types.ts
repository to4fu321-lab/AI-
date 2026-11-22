/** 動画オート投稿：画面とサーバーの両方で使う型と、投稿先ごとの決まり。 */

export type SiteKind = "youtube" | "x" | "instagram" | "own" | "manual";

export interface SiteRules {
  /** 本文に必ず入れる文（入っていなければ末尾に足す） */
  required: string;
  /** 必ず付けるハッシュタグ（空白区切り） */
  hashtags: string;
  /** 口調・書き方の指示 */
  tone: string;
  titleMax: number;
  bodyMax: number;
  /** YouTube の公開範囲 */
  privacy: "public" | "unlisted" | "private";
  /** 手動投稿サイトの投稿ページ */
  postUrl: string;
}

export interface Site {
  id: string;
  kind: SiteKind;
  name: string;
  enabled: boolean;
  auto: boolean;
  rules: SiteRules;
  /** 保存済みのログイン情報の項目名（中身はブラウザに返さない） */
  credFields: string[];
}

export interface Video {
  id: string;
  name: string;
  memo: string;
  path: string;
  thumb: string;
  duration: number;
  width: number;
  height: number;
  size: number;
  created_at: string;
}

export type PostStatus = "draft" | "posting" | "posted" | "failed";

export interface Post {
  id: string;
  video_id: string;
  site_id: string;
  title: string;
  body: string;
  status: PostStatus;
  url: string;
  error: string;
  created_at: string;
  posted_at: string | null;
}

export interface Member {
  id: string;
  login_id: string;
  name: string;
  active: boolean;
  created_at: string;
}

export interface AppState {
  setup: { db: boolean; secret: boolean; ai: boolean };
  videos: Video[];
  sites: Site[];
  posts: Post[];
  members: Member[];
}

export interface CredField {
  key: string;
  label: string;
  /** 画面で伏せ字にするか */
  secret?: boolean;
}

export interface KindInfo {
  label: string;
  emoji: string;
  /** 自動で投稿できるか（false は文を作って手で貼る） */
  autoPost: boolean;
  usesTitle: boolean;
  creds: CredField[];
  defaults: Pick<SiteRules, "titleMax" | "bodyMax">;
  help: string;
}

export const KINDS: Record<SiteKind, KindInfo> = {
  youtube: {
    label: "YouTube",
    emoji: "▶️",
    autoPost: true,
    usesTitle: true,
    creds: [
      { key: "clientId", label: "クライアント ID" },
      { key: "clientSecret", label: "クライアント シークレット", secret: true },
    ],
    defaults: { titleMax: 100, bodyMax: 5000 },
    help: "Google Cloud で「YouTube Data API v3」を有効にし、OAuth クライアント（ウェブ アプリケーション）を作って ID とシークレットを入れます。リダイレクト URI には「このサイトの URL + /api/autopost/oauth/callback」を登録。保存したあと「Google と連携」を押してください。",
  },
  x: {
    label: "X（旧 Twitter）",
    emoji: "✖️",
    autoPost: true,
    usesTitle: false,
    creds: [
      { key: "apiKey", label: "API Key" },
      { key: "apiSecret", label: "API Key Secret", secret: true },
      { key: "accessToken", label: "Access Token" },
      { key: "accessSecret", label: "Access Token Secret", secret: true },
    ],
    defaults: { titleMax: 0, bodyMax: 280 },
    help: "X の開発者ポータルでアプリを作り、権限を「Read and write」にしてから 4 つの鍵を発行して入れます。文字数は X の数え方（全角は 2 文字ぶん・上限 280）で数えます。",
  },
  instagram: {
    label: "Instagram（リール）",
    emoji: "📸",
    autoPost: true,
    usesTitle: false,
    creds: [
      { key: "igUserId", label: "Instagram ユーザー ID（数字）" },
      { key: "accessToken", label: "アクセストークン", secret: true },
    ],
    defaults: { titleMax: 0, bodyMax: 2200 },
    help: "プロアカウント（ビジネス／クリエイター）が必要です。Meta for Developers でアプリを作り、投稿の権限（instagram_content_publish）つきの長期トークンを入れます。",
  },
  own: {
    label: "自分の会員サイト",
    emoji: "🏠",
    autoPost: true,
    usesTitle: true,
    creds: [],
    defaults: { titleMax: 60, bodyMax: 2000 },
    help: "このサイトの会員制ページ（/members）に公開します。ここで付けた名前が会員サイトの名前になります。",
  },
  manual: {
    label: "その他のサイト（手で貼る）",
    emoji: "📋",
    autoPost: false,
    usesTitle: true,
    creds: [
      { key: "loginId", label: "ログイン ID" },
      { key: "password", label: "パスワード", secret: true },
    ],
    defaults: { titleMax: 100, bodyMax: 2000 },
    help: "投稿用の API がないサイト向け。題名と本文を作るところまで自動で、投稿ページを開いて貼り付けます。ログイン情報は暗号化して控えておけます。",
  },
};

export function defaultRules(kind: SiteKind): SiteRules {
  return { required: "", hashtags: "", tone: "", privacy: "private", postUrl: "", ...KINDS[kind].defaults };
}

/** X の数え方：全角（日本語など）は 2、半角は 1 */
export function xLength(text: string): number {
  let n = 0;
  for (const ch of text) n += /[\u0000-ჿ -‍‐-‟′-‷]/.test(ch) ? 1 : 2;
  return n;
}

export function textLength(kind: SiteKind, text: string): number {
  return kind === "x" ? xLength(text) : [...text].length;
}

function cut(kind: SiteKind, text: string, max: number): string {
  if (max <= 0) return "";
  if (textLength(kind, text) <= max) return text;
  const chars = [...text];
  while (chars.length && textLength(kind, chars.join("") + "…") > max) chars.pop();
  return chars.join("").trimEnd() + "…";
}

/**
 * 投稿先の決まりを必ず守らせる（AI まかせにしない）。
 * 必ず入れる文とハッシュタグが本文になければ末尾に足し、上限を超えるぶんは前の文のほうを削る。
 */
export function applyRules(site: Pick<Site, "kind" | "rules">, draft: { title: string; body: string }): { title: string; body: string } {
  const { rules, kind } = site;
  let main = draft.body.trim();
  const tail: string[] = [];
  const required = rules.required.trim();
  if (required && !main.includes(required)) tail.push(required);
  const tags = rules.hashtags
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => (t.startsWith("#") ? t : `#${t}`))
    .filter((t) => !main.includes(t) && !required.includes(t));
  if (tags.length) tail.push(tags.join(" "));
  const suffix = tail.length ? `\n\n${tail.join("\n")}` : "";
  if (rules.bodyMax > 0) main = cut(kind, main, rules.bodyMax - textLength(kind, suffix));
  const title = KINDS[kind].usesTitle ? cut(kind, draft.title.trim().replace(/\s*\n\s*/g, " "), rules.titleMax || 100) : "";
  return { title, body: (main + suffix).trim() };
}
