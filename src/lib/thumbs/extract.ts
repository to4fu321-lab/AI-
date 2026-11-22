import type { MediaItem } from "./types";
import { parseClock, parseIsoDuration } from "./duration";
import { hostedFile } from "./filehost";
import { isAdUrl } from "./adblock";
import { findTweetIds, gifVideoFromThumb, isTwitterVideoThumb, tweetIdInUrl, tweetIdOf } from "./twitter";

/** Gofile の共有フォルダの番号（gofile.io/d/番号。違えば null）。gofile.ts はサーバー専用なので、ここにも小さく持つ */
export function gofileLinkId(raw: string): string | null {
  try {
    const u = new URL(raw);
    return /(?:^|\.)gofile\.io$/i.test(u.hostname) ? (/^\/d\/([\w-]{4,40})/.exec(u.pathname)?.[1] ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * HTML からメディア（画像・動画）と、辿る候補のリンクを取り出す。
 *
 * ライブラリを使わず正規表現で「タグと属性」だけを拾う軽量パーサー。
 * ページを完全に理解する必要はなく、src / href / content などの属性値が取れれば十分なため。
 */

const IMAGE_EXT = ["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "svg", "heic"];
const VIDEO_EXT = ["mp4", "m4v", "mov", "webm", "ogv", "m3u8", "mpd"];
/** ページとして辿らない拡張子（メディアやダウンロードファイル） */
const NON_PAGE_EXT = [
  ...IMAGE_EXT,
  ...VIDEO_EXT,
  "ico", "css", "js", "json", "xml", "pdf", "zip", "rar", "7z", "gz", "mp3", "m4a", "wav", "flac",
  "woff", "woff2", "ttf", "otf", "exe", "dmg", "apk", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
];

export function extensionOf(url: string): string {
  try {
    const path = new URL(url).pathname;
    const m = /\.([a-z0-9]{1,5})$/i.exec(path);
    return m ? m[1].toLowerCase() : "";
  } catch {
    return "";
  }
}

export function kindFromUrl(url: string): "image" | "video" | null {
  const ext = extensionOf(url);
  if (IMAGE_EXT.includes(ext)) return "image";
  if (VIDEO_EXT.includes(ext)) return "video";
  return null;
}

export function kindFromContentType(type: string | null): "image" | "video" | null {
  if (!type) return null;
  const t = type.toLowerCase();
  if (t.startsWith("image/")) return "image";
  if (t.startsWith("video/") || t.includes("mpegurl") || t.includes("dash+xml")) return "video";
  return null;
}

export function isPageLikeUrl(url: string): boolean {
  return !NON_PAGE_EXT.includes(extensionOf(url));
}

/** HTML の文字参照（&amp; など）を元に戻す。属性値に使う最低限のもの。 */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

interface Tag {
  name: string;
  attrs: Record<string, string>;
  /** HTML 内の位置（<video> と <source> の対応付けに使う） */
  index: number;
}

const TAG_RE = /<([a-zA-Z][a-zA-Z0-9-]*)(\s[^<>]*?)?\/?>/g;
const ATTR_RE = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(raw: string | undefined): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (!raw) return attrs;
  for (const a of raw.matchAll(ATTR_RE)) {
    attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? "");
  }
  return attrs;
}

function parseTags(html: string, names: Set<string>): Tag[] {
  const tags: Tag[] = [];
  for (const m of html.matchAll(TAG_RE)) {
    const name = m[1].toLowerCase();
    if (!names.has(name)) continue;
    tags.push({ name, attrs: parseAttrs(m[2]), index: m.index ?? 0 });
  }
  return tags;
}

/** 相対 URL を絶対 URL にする。http(s) 以外（data: や javascript:）は捨てる。 */
export function resolveUrl(raw: string | undefined, base: string): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value || value.startsWith("data:") || value.startsWith("blob:")) return null;
  try {
    const u = new URL(value, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

/** srcset から一番大きい候補を選ぶ。 */
function pickFromSrcset(srcset: string | undefined): string | undefined {
  if (!srcset) return undefined;
  let best: { url: string; score: number } | undefined;
  for (const part of srcset.split(/,\s+/)) {
    const [url, descriptor] = part.trim().split(/\s+/);
    if (!url) continue;
    const n = descriptor ? parseFloat(descriptor) : 1;
    const score = Number.isFinite(n) ? n : 1;
    if (!best || score > best.score) best = { url, score };
  }
  return best?.url;
}

export function youtubeId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\.|^m\./, "");
    if (host === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
    if (host === "youtube.com" || host === "youtube-nocookie.com") {
      if (u.pathname === "/watch") return u.searchParams.get("v");
      const m = /^\/(?:embed|shorts|live|v)\/([\w-]{6,})/.exec(u.pathname);
      if (m) return m[1];
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * YouTube・Vimeo 以外の動画サービスの埋め込み（埋め込み用プレーヤーの URL・形式名・サムネイル）。
 * 動画を表す URL でなければ null（チャンネルやプロフィールへのリンクは対象外）
 */
export function otherEmbed(url: string): { src: string; format: string; thumb?: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(?:www|m)\./, "");
  const path = u.pathname;
  let m: RegExpExecArray | null;
  if (host === "dailymotion.com" && (m = /^\/(?:embed\/)?video\/([a-z0-9]+)/i.exec(path))) {
    return { src: `https://www.dailymotion.com/embed/video/${m[1]}`, format: "Dailymotion", thumb: `https://www.dailymotion.com/thumbnail/video/${m[1]}` };
  }
  if (host === "dai.ly" && (m = /^\/([a-z0-9]+)/i.exec(path))) {
    return { src: `https://www.dailymotion.com/embed/video/${m[1]}`, format: "Dailymotion", thumb: `https://www.dailymotion.com/thumbnail/video/${m[1]}` };
  }
  if (/(?:^|\.)nicovideo\.jp$|^nico\.ms$/.test(host) && (m = /\/((?:sm|so|nm)\d+)/.exec(path))) {
    return { src: `https://embed.nicovideo.jp/watch/${m[1]}`, format: "ニコニコ" };
  }
  if (host === "tiktok.com" && (m = /\/(?:video|embed(?:\/v2)?)\/(\d{8,})/.exec(path))) {
    return { src: `https://www.tiktok.com/embed/v2/${m[1]}`, format: "TikTok" };
  }
  if (host === "instagram.com" && (m = /^\/(?:reels?|tv)\/([\w-]+)/.exec(path))) {
    return { src: `https://www.instagram.com/reel/${m[1]}/embed`, format: "Instagram" };
  }
  if (host === "streamable.com" && (m = /^\/(?:[eo]\/)?([a-z0-9]{4,})$/i.exec(path))) {
    return { src: `https://streamable.com/e/${m[1]}`, format: "Streamable" };
  }
  if (host === "bilibili.com" && (m = /^\/video\/(BV[\w]+)/.exec(path))) {
    return { src: `https://player.bilibili.com/player.html?bvid=${m[1]}`, format: "bilibili" };
  }
  if (host === "player.bilibili.com" && /bvid=|aid=/.test(u.search)) return { src: url, format: "bilibili" };
  if (host === "facebook.com" && path.startsWith("/plugins/video.php")) return { src: url, format: "Facebook" };
  if (host === "facebook.com" && /\/videos\/\d+/.test(path)) {
    return { src: `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(url)}`, format: "Facebook" };
  }
  if (host === "x.com" || host === "twitter.com") return null;
  return null;
}

function vimeoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)vimeo\.com$/.test(u.hostname)) return null;
    const m = /\/(?:video\/)?(\d{5,})/.exec(u.pathname);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function formatOf(url: string, kind: MediaItem["kind"]): string | undefined {
  const ext = extensionOf(url);
  if (kind === "image" ? IMAGE_EXT.includes(ext) : VIDEO_EXT.includes(ext)) {
    return ext === "jpeg" ? "JPG" : ext.toUpperCase();
  }
  return undefined;
}

function toInt(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** 辿る候補のリンク */
export interface LinkCandidate {
  url: string;
  /** リンクの中にあったサムネイル画像（一覧ページのサムネイル → 詳細ページの動画に引き継ぐ） */
  thumb?: string;
  /** リンクのカードにあったプレビュー動画（詳細ページの本編と同じ動画の短い版。本編が見つかれば出さない） */
  preview?: string;
  /** リンクのカードに出ていた再生時間（秒） */
  duration?: number;
  /**
   * 優先度。4: サムネイル付きで動画らしい / 3: サムネイル付き / 2: 動画らしい（再生時間・URL など）/
   * 1: タップで移動する仕掛け（onclick・data-href）/ 0: 普通のリンク
   */
  prio: number;
}

export interface Extracted {
  /** 画面を JavaScript で後から描くサイトに見えるか（取れた件数が少ないときの説明用） */
  clientRendered: boolean;
  /** 動画プレーヤーが置かれていそうなページか（動画が見つからなければブラウザで開いて再生を試す目安） */
  playerHint: boolean;
  media: MediaItem[];
  links: LinkCandidate[];
  /** ページ送り（次へ・2・3…）のリンク。階層を増やさずに辿る */
  pagination: string[];
  /** iframe などで埋め込まれた別ページ（外部の動画プレーヤーなど）。中も読みに行く */
  frames: string[];
  /** ページの代表画像（og:image）。動画が少ないページでは、その動画のサムネイルに使う */
  ogImage?: string;
  title?: string;
  /** 自動で別のページへ移動する指定（<meta http-equiv="refresh">、location.href = "…"）の行き先 */
  redirect?: string;
  /** 年齢確認などの「入口ページ」に見えるか（ブラウザで開いて「はい」を押す目安） */
  gate: boolean;
  /**
   * リンクなどで見つけた X（旧 Twitter）の投稿。投稿ページはログインが必要で読めないので、
   * 辿らずに、投稿の番号から動画を直接もらう（twitter.ts）。カードのサムネイル・再生時間も一緒に持つ
   */
  tweets: TweetRef[];
  /** リンクなどで見つけた Gofile の共有フォルダの番号（gofile.io/d/番号）。ページは読まず、API で中身をもらう */
  gofile: string[];
  /** 「動画を再生」など、X の投稿の番号が入った自サイトのリンク（行き先が動画ファイルなら、それを使う） */
  playLinks: (TweetRef & { url: string })[];
}

export interface TweetRef {
  id: string;
  thumb?: string;
  duration?: number;
}

/** 年齢確認・入口ページらしい文言 */
const GATE_RE =
  /年齢確認|年齢認証|18歳以上|18歳未満|18才以上|18才未満|あなたは18|age.?verification|are you (?:over |at least )?18|over 18|18 years|adults? only|i am 18|i'm 18/i;

/**
 * 読みにくくした JavaScript（eval(function(p,a,c,k,e,d){…}) の形式。動画プレーヤーの設定によく使われる）を元に戻す。
 * 元に戻した文字列の中から、動画の URL を探すために使う
 */
function unpackScripts(html: string): string {
  let out = "";
  const re =
    /eval\(function\(p,a,c,k,e,[dr]\)\{[\s\S]{0,2000}?\}\(\s*'((?:[^'\\]|\\[\s\S])*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:[^'\\]|\\[\s\S])*)'\.split\('\|'\)/g;
  const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (const m of html.matchAll(re)) {
    const radix = Number(m[2]);
    if (radix < 2 || radix > 62) continue;
    const words = m[4].split("|");
    const payload = m[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\");
    const toIndex = (w: string) => {
      let n = 0;
      for (const ch of w) {
        const d = DIGITS.indexOf(ch);
        if (d < 0 || d >= radix) return -1;
        n = n * radix + d;
      }
      return n;
    };
    out += "\n" + payload.replace(/\b\w+\b/g, (w) => words[toIndex(w)] || w);
    if (out.length > 2_000_000) break;
  }
  return out;
}

/** 文字列を Base64 から元に戻す（失敗したら null） */
function decodeBase64(raw: string): string | null {
  try {
    return atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
}

/** 「動画の詳細ページらしい」URL */
export const VIDEO_URL_RE =
  /\/(?:video|videos|movie|movies|watch|v|e|vod|play|player|embed|douga|clip|clips|stream|episode)(?:[/_\-.?]|$)|[?&](?:v|vid|video_?id|viewkey|movie_?id)=/i;

/** 広告・計測・SNS ボタンなどの iframe（動画プレーヤーではないので中は読まない） */
export const AD_FRAME_RE =
  /doubleclick\.net|googlesyndication|googletagmanager|google\.com\/(?:recaptcha|maps)|gstatic\.com|facebook\.com\/(?:plugins|tr)|platform\.twitter\.com|twitter\.com\/widgets|disqus\.com|amazon-adsystem|adservice\.|\/\/ads?\d*\.|[./]adserver|exoclick|exosrv|juicyads|trafficjunky|popads|adsterra|i-mobile\.co\.jp|nend\.net/i;
/** リンクの中の再生時間（12:34 / 1:02:03） */
const DURATION_RE = /(?:^|[^\d:])\d{1,2}:\d{2}(?::\d{2})?(?:$|[^\d:])/;
/** リンクの中の、動画のサムネイルらしい部品のクラス名 */
const VIDEO_CLASS_RE = /\b[\w-]*(?:play|duration|video|movie|vid|time|length)[\w-]*\b/i;

/** リンクの中身（innerHTML）からサムネイル画像を探す */
function thumbInside(inner: string, base: string): string | undefined {
  for (const m of inner.matchAll(/<(img|source|video)\b([^>]*)>/gi)) {
    const a = parseAttrs(m[2]);
    const raw =
      m[1].toLowerCase() === "video"
        ? a.poster || a["data-poster"]
        : pickFromSrcset(a["data-srcset"]) ||
          a["data-src"] ||
          a["data-original"] ||
          a["data-lazy-src"] ||
          a["data-thumb"] ||
          a["data-lazy"] ||
          pickFromSrcset(a.srcset) ||
          a.src;
    const url = resolveUrl(raw, base);
    if (!url || /\.svg(?:$|\?)/i.test(url)) continue;
    const w = toInt(a.width);
    if (w !== undefined && w < 40) continue;
    return url;
  }
  const bg =
    /url\(\s*(?:&quot;|["'])?([^"')]+?)(?:&quot;|["'])?\s*\)/i.exec(inner) ??
    /\sdata-(?:bg|background|thumb|thumbnail|poster|image|src)\s*=\s*["']([^"']+)["']/i.exec(inner);
  if (bg) {
    const url = resolveUrl(decodeEntities(bg[1]), base);
    if (url && kindFromUrl(url) !== "video") return url;
  }
  return undefined;
}

/**
 * 一覧ページのカードの中にある、短い「予告・プレビュー動画」（マウスを乗せると流れるもの）を探す。
 * <video> / <source> や、data-preview="….mp4" のような属性に書かれる
 */
function previewInside(inner: string, base: string): string | undefined {
  for (const m of inner.matchAll(/<(video|source)\b([^>]*)>/gi)) {
    const a = parseAttrs(m[2]);
    const url = resolveUrl(a.src || a["data-src"], base);
    if (url && kindFromUrl(url) === "video") return url;
  }
  for (const m of inner.matchAll(
    /\sdata-(?:preview|preview-?url|preview-?src|preview-?video|video-?preview|trailer|trailer-?url|mediabook|teaser|hover|hover-?video|clip|webm|mp4|video|video-?src|video-?url)\s*=\s*(?:"([^"]+)"|'([^']+)')/gi,
  )) {
    const url = resolveUrl(decodeEntities(m[1] ?? m[2]), base);
    if (url && kindFromUrl(url) === "video") return url;
  }
  return undefined;
}

/** <a> ごとに、中のサムネイルと「動画らしさ」を調べる */
type AnchorInfo = { thumb?: string; videoish: boolean; text: string; preview?: string; duration?: number };
function analyzeAnchors(markup: string, base: string): Map<string, AnchorInfo> {
  const out = new Map<string, AnchorInfo>();
  for (const m of markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = parseAttrs(m[1]);
    const url = resolveUrl(attrs.href, base);
    if (!url) continue;
    // <a> の属性に書かれたプレビュー動画（<a data-preview="…">）も含めて調べる
    const inner = m[2];
    const thumb = thumbInside(inner, base);
    const preview = previewInside(`${m[1]}>${inner}`, base);
    const text = stripTags(inner);
    const videoish =
      DURATION_RE.test(text) ||
      VIDEO_URL_RE.test(url) ||
      (!!thumb && VIDEO_CLASS_RE.test(`${attrs.class ?? ""} ${inner.slice(0, 2000)}`));
    // カードに出ている再生時間（12:34）。日時（2024/01/02 12:34）と取り違えないよう、日付らしい文字があれば使わない
    const clock = /\d{4}[/.\-年]\d{1,2}/.test(text) ? undefined : parseClock(text);
    const dataDuration = /\sdata-(?:duration|length|time)\s*=\s*["']([^"']+)["']/i.exec(inner)?.[1];
    const duration = clock ?? parseIsoDuration(dataDuration);
    const prev = out.get(url);
    out.set(url, {
      thumb: prev?.thumb ?? thumb,
      videoish: (prev?.videoish ?? false) || videoish || !!preview,
      text: `${prev?.text ?? ""} ${text}`.slice(0, 200),
      preview: prev?.preview ?? preview,
      duration: prev?.duration ?? duration,
    });
  }
  return out;
}

/**
 * 動画のない「サイトの仕組みのページ」（ログイン・設定・規約・問い合わせ・言語や並び順の切り替えなど）。
 * こういうリンクを辿ると、読むページ数の上限をすぐ使い切ってしまうので辿らない
 */
const JUNK_PATH_RE =
  /(?:^|\/)(?:log-?in|log-?out|sign-?in|sign-?up|sign-?out|register|registration|join|account|accounts|settings?|config|preferences?|mypage|my|password|reset|forgot|auth|oauth|sso|privacy(?:-policy)?|policy|policies|terms(?:-of-(?:use|service))?|tos|legal|disclaimer|dmca|copyright|contact(?:-us)?|inquiry|about(?:-us)?|company|faq|help|support|guide|sitemap|rss|atom|cart|checkout|subscribe|subscription|pricing|plans?|upgrade|advertise|advertising|careers?|jobs|press|lang|language|share|report|notifications?|messages?|inbox|wp-admin|wp-login\.php|cdn-cgi)(?:[/.?#]|$)/i;
const JUNK_QUERY_RE = /[?&](?:lang|hl|locale|sort|order|orderby|share|replytocom|redirect|redirect_to|return_?to|returnurl|next|action=(?:login|register|logout))=/i;
const JUNK_TEXT_RE =
  /^(?:ログイン|ログアウト|新規登録|会員登録|無料登録|無料会員登録|サインイン|サインアップ|設定|各種設定|アカウント|マイページ|お問い合わせ|問い合わせ|利用規約|規約|プライバシー|プライバシーポリシー|個人情報保護方針|個人情報|運営会社|会社概要|運営者情報|ヘルプ|よくある質問|サイトマップ|広告掲載|広告について|免責事項|著作権|お知らせ|login|log in|logout|sign in|sign up|register|settings|account|contact|contact us|terms|privacy|privacy policy|help|faq|about|about us|language|日本語|english|dmca)$/i;

/** 動画のない仕組みのページへのリンクか（サムネイル付きのリンクには使わない） */
export function isJunkLink(url: string, text?: string): boolean {
  try {
    const u = new URL(url);
    return JUNK_PATH_RE.test(u.pathname) || JUNK_QUERY_RE.test(u.search) || (!!text && JUNK_TEXT_RE.test(text.trim()));
  } catch {
    return false;
  }
}

/** 動画を再生するボタン・リンクらしい文字 */
const PLAY_TEXT_RE = /動画を再生|再生する|^\s*再生\s*$|動画を見る|play video|watch video|^\s*play\s*$/i;

/** ダウンロード用のリンクらしい文字・URL */
const DOWNLOAD_TEXT_RE = /ダウンロード|download|動画を保存|保存する|\bDL\b/i;
const DOWNLOAD_URL_RE = /(?:^|[/_.\-?&=])(?:download|dl|get_?file|getfile|getvideo|get_video|attachment|dlfile)(?:$|[/_.\-?&=])/i;

/** URL がページ番号付きに見えるか（?page=2、/page/3、-p4 など） */
const PAGE_URL_RE =
  /[?&](?:page|p|paged|pg|pn|pagenum|pageno|offset|start)=\d+|\/page\/\d+|\/p\d+\/?$|[-_/]page[-_]?\d+/i;
/** 「次へ」系のリンク文字 */
const NEXT_TEXT_RE = /^(?:次へ|次のページ|次ページ|もっと見る|さらに表示|next|older|more|›|»|≫|>|→)/i;

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function findPagination(markup: string, tags: Tag[], base: string, pageUrl: string): string[] {
  const out = new Set<string>();
  const accept = (url: string | null) => {
    if (url && url !== pageUrl && sameOrigin(url, pageUrl) && isPageLikeUrl(url)) out.add(url);
  };
  // <link rel="next"> / <a rel="next">
  for (const t of tags) {
    if ((t.name === "link" || t.name === "a") && /\bnext\b/i.test(t.attrs.rel ?? "")) accept(resolveUrl(t.attrs.href, base));
  }
  for (const m of markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs: Record<string, string> = {};
    for (const a of m[1].matchAll(ATTR_RE)) attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? "");
    const url = resolveUrl(attrs.href, base);
    if (!url) continue;
    const text = (stripTags(m[2]) || attrs["aria-label"] || attrs.title || "").slice(0, 40);
    const hint = `${attrs.class ?? ""} ${attrs["aria-label"] ?? ""} ${attrs.rel ?? ""}`;
    const pageish = PAGE_URL_RE.test(url) || /pag(e|ination|er)|next/i.test(hint);
    if (NEXT_TEXT_RE.test(text) && text.length <= 20) accept(url);
    else if (/^\d{1,4}$/.test(text) && pageish) accept(url);
    else if (PAGE_URL_RE.test(url)) accept(url);
  }
  return [...out];
}

export function extractFromHtml(html: string, pageUrl: string): Extracted {
  // <base href> があれば相対 URL の基準を変える
  const baseTag = /<base\s[^>]*href\s*=\s*["']?([^"'\s>]+)/i.exec(html);
  const base = resolveUrl(baseTag?.[1], pageUrl) ?? pageUrl;

  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const pageTitle = titleMatch ? decodeEntities(titleMatch[1]).trim().slice(0, 200) : undefined;

  const found = new Map<string, MediaItem>();
  const add = (raw: Omit<MediaItem, "id" | "pageUrl">): MediaItem => {
    // ファイル保存サービスのプレビュー画面の URL（Dropbox の …/名前.mp4?dl=0 など）は、ファイルそのものの URL に直す
    const hosted = raw.kind !== "embed" ? hostedFile(raw.src) : null;
    const item = hosted && hosted.src !== raw.src ? { ...raw, src: hosted.src, format: hosted.service, thumb: raw.thumb ?? hosted.thumb } : raw;
    const id = item.src;
    const existing = found.get(id);
    if (existing) {
      // 既にあるなら、足りない情報（サムネ・タイトル）だけ補う
      existing.thumb ??= item.thumb;
      existing.title ??= item.title;
      existing.duration ??= item.duration;
      // どこか 1 か所でも確かな出どころ（<video> など）があれば確認済み扱い
      if (!item.unverified) existing.unverified = undefined;
      if (!item.guess) existing.guess = undefined;
      return existing;
    }
    const created = { ...item, id, pageUrl };
    found.set(id, created);
    return created;
  };

  /** 埋め込み動画・共有ファイルとして足せたら、その 1 件を返す（足せなければ null） */
  const addEmbed = (url: string, title?: string): MediaItem | null => {
    const yt = youtubeId(url);
    if (yt) {
      return add({
        kind: "embed",
        src: `https://www.youtube-nocookie.com/embed/${yt}`,
        thumb: `https://i.ytimg.com/vi/${yt}/hqdefault.jpg`,
        format: "YouTube",
        title,
      });
    }
    const vm = vimeoId(url);
    if (vm) return add({ kind: "embed", src: `https://player.vimeo.com/video/${vm}`, format: "Vimeo", title });
    const other = otherEmbed(url);
    if (other) return add({ kind: "embed", src: other.src, format: other.format, thumb: other.thumb, title });
    // ファイル保存サービスの共有リンク（Google ドライブ・Dropbox など）は、ファイルそのものの URL に書き換える
    const hosted = hostedFile(url);
    if (hosted) return add({ kind: "video", src: hosted.src, thumb: hosted.thumb, format: hosted.service, title, unverified: true, guess: !hosted.sure });
    return null;
  };

  // script / style / コメントの中身はタグとして読まない（誤検出を防ぐ）。ただし後で URL 探しには使う
  const markup = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, (m, name: string) =>
      name.toLowerCase() === "noscript" ? m.replace(/<\/?noscript[^>]*>/gi, "") : "",
    );

  const tags = parseTags(
    markup,
    new Set(["meta", "img", "source", "video", "a", "iframe", "frame", "embed", "object", "link", "image"]),
  );
  const frames = new Set<string>();
  const tweets = new Map<string, TweetRef>();
  const gofile = new Set<string>();
  const playLinks = new Map<string, TweetRef>();
  const addTweet = (id: string, thumb?: string, duration?: number) => {
    if (tweets.size >= 150 && !tweets.has(id)) return;
    const prev = tweets.get(id);
    tweets.set(id, { id, thumb: prev?.thumb ?? thumb, duration: prev?.duration ?? duration });
  };

  // --- 1. OGP / Twitter カード（ページの代表サムネイル） ---
  let ogImage: string | undefined;
  let ogVideo: string | undefined;
  /** ページの代表動画の長さ（<meta property="video:duration" content="秒">） */
  let metaDuration: number | undefined;
  let redirect: string | undefined;
  for (const t of tags) {
    if (t.name !== "meta") continue;
    if ((t.attrs["http-equiv"] ?? "").toLowerCase() === "refresh") {
      const to = /^\s*\d*\s*[;,]\s*(?:url\s*=\s*)?["']?([^"']+)["']?\s*$/i.exec(t.attrs.content ?? "");
      const url = to ? resolveUrl(to[1], base) : null;
      if (url && url !== pageUrl) redirect ??= url;
      continue;
    }
    const key = (t.attrs.property || t.attrs.name || t.attrs.itemprop || "").toLowerCase();
    if (/^(?:og:video:duration|video:duration|duration)$/.test(key)) {
      metaDuration ??= parseIsoDuration(t.attrs.content);
      continue;
    }
    const url = resolveUrl(t.attrs.content, base);
    if (!url) continue;
    if (["og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src"].includes(key)) {
      ogImage ??= url;
    } else if (["og:video", "og:video:url", "og:video:secure_url", "twitter:player:stream"].includes(key)) {
      ogVideo ??= url;
    } else if (key === "twitter:player") {
      addEmbed(url, pageTitle);
    }
  }
  if (ogVideo && !addEmbed(ogVideo, pageTitle)) {
    add({ kind: "video", src: ogVideo, thumb: ogImage, format: formatOf(ogVideo, "video"), title: pageTitle });
  }
  if (ogImage) add({ kind: "image", src: ogImage, format: formatOf(ogImage, "image"), title: pageTitle });

  // --- 2. <video> と中の <source> ---
  const videoBlocks = [...markup.matchAll(/<video\b[^>]*>([\s\S]*?)<\/video>/gi)].map((m) => ({
    start: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
  }));
  const insideVideo = (index: number) => videoBlocks.find((b) => index > b.start && index < b.end);

  for (const t of tags) {
    if (t.name !== "video") continue;
    const poster = resolveUrl(t.attrs.poster || t.attrs["data-poster"], base) ?? undefined;
    const sources: string[] = [];
    const direct = resolveUrl(t.attrs.src || t.attrs["data-src"], base);
    if (direct) sources.push(direct);
    const block = videoBlocks.find((b) => b.start === t.index);
    if (block) {
      for (const s of tags) {
        if (s.name === "source" && s.index > block.start && s.index < block.end) {
          const u = resolveUrl(s.attrs.src || s.attrs["data-src"], base);
          if (u) sources.push(u);
        }
      }
    }
    // 1 本の動画に複数形式があれば、iPhone で再生しやすい MP4 を優先
    const src = sources.find((u) => /\.(mp4|m4v|mov)$/i.test(new URL(u).pathname)) ?? sources[0];
    if (src) {
      add({
        kind: "video",
        src,
        thumb: poster,
        format: formatOf(src, "video") ?? "動画",
        title: t.attrs.title || t.attrs["aria-label"],
        width: toInt(t.attrs.width),
        height: toInt(t.attrs.height),
      });
    } else if (poster) {
      add({ kind: "image", src: poster, format: formatOf(poster, "image") });
    }
  }

  // --- 3. <img> / <picture><source> / SVG <image> ---
  for (const t of tags) {
    if (t.name === "img" || t.name === "image") {
      const raw =
        pickFromSrcset(t.attrs["data-srcset"]) ||
        t.attrs["data-src"] ||
        t.attrs["data-original"] ||
        t.attrs["data-lazy-src"] ||
        t.attrs["data-full"] ||
        pickFromSrcset(t.attrs.srcset) ||
        t.attrs.src ||
        t.attrs.href ||
        t.attrs["xlink:href"];
      const url = resolveUrl(raw, base);
      if (!url) continue;
      const width = toInt(t.attrs.width);
      const height = toInt(t.attrs.height);
      // アイコンやトラッキング用の 1px 画像は除外
      if ((width && width < 40) || (height && height < 40)) continue;
      add({ kind: "image", src: url, format: formatOf(url, "image"), title: t.attrs.alt || t.attrs.title, width, height });
    } else if (t.name === "source" && !insideVideo(t.index)) {
      const url = resolveUrl(pickFromSrcset(t.attrs.srcset) || t.attrs.src, base);
      if (!url) continue;
      const kind = kindFromUrl(url) ?? (t.attrs.type?.startsWith("video") ? "video" : "image");
      add({ kind, src: url, format: formatOf(url, kind) });
    } else if (t.name === "iframe" || t.name === "frame" || t.name === "embed" || t.name === "object") {
      const url = resolveUrl(t.attrs.src || t.attrs["data-src"] || t.attrs["data-lazy-src"] || t.attrs.data, base);
      if (!url) continue;
      const tweet = tweetIdOf(url) ?? /platform\.twitter\.com\/embed\/Tweet\.html\?(?:.*&)?id=(\d{8,20})/.exec(url)?.[1];
      if (tweet) {
        addTweet(tweet);
        continue;
      }
      if (addEmbed(url, t.attrs.title)) continue;
      const kind = kindFromUrl(url);
      if (kind === "video") add({ kind, src: url, format: formatOf(url, kind), unverified: true });
      else if (!kind && isPageLikeUrl(url) && url !== pageUrl && !AD_FRAME_RE.test(url) && !isAdUrl(url)) frames.add(url);
    } else if (t.name === "link") {
      const rel = (t.attrs.rel || "").toLowerCase();
      if (rel === "image_src") {
        const url = resolveUrl(t.attrs.href, base);
        if (url) add({ kind: "image", src: url, format: formatOf(url, "image") });
      }
    }
  }

  // --- 4. <a href> : メディアへの直リンク、YouTube へのリンク、辿る候補のページ ---
  const anchors = analyzeAnchors(markup, base);
  const links = new Map<string, LinkCandidate>();
  const addLink = (url: string, prio: number, thumb?: string, preview?: string, duration?: number) => {
    const prev = links.get(url);
    if (!prev || prio > prev.prio || (!prev.thumb && thumb) || (!prev.preview && preview) || (!prev.duration && duration)) {
      links.set(url, {
        url,
        prio: Math.max(prio, prev?.prio ?? 0),
        thumb: prev?.thumb ?? thumb,
        preview: prev?.preview ?? preview,
        duration: prev?.duration ?? duration,
      });
    }
  };
  for (const t of tags) {
    if (t.name !== "a") continue;
    const url = resolveUrl(t.attrs.href, base);
    if (!url) continue;
    // Gofile の共有フォルダへのリンク：辿らずに、番号として集める
    const share = gofileLinkId(url);
    if (share) {
      gofile.add(share);
      continue;
    }
    // X の投稿へのリンク：辿らずに、投稿の番号として集める（カードのサムネイル・再生時間も）
    const tweet = tweetIdOf(url);
    if (tweet) {
      const info = anchors.get(url);
      addTweet(tweet, info?.thumb, info?.duration);
      continue;
    }
    // X の動画を集めたサイト（twihub など）の、自分のサイト経由のリンク：/r/x/ユーザー/status/番号、/r/v/番号（「動画を再生」）。
    // 番号が X の投稿の番号として正しい形なら、投稿の番号として集める（ページを開かなくても、番号から動画をもらえる）
    const linkInfo = anchors.get(url);
    const statusId = /\/status(?:es)?\/(\d{18,19})(?:[/?#]|$)/.exec(new URL(url).pathname)?.[1];
    const viaSite =
      (statusId && tweetIdInUrl(url) === statusId ? statusId : null) ??
      (VIDEO_URL_RE.test(url) || PLAY_TEXT_RE.test(linkInfo?.text ?? "") ? tweetIdInUrl(url) : null);
    if (viaSite) {
      if (statusId) {
        addTweet(viaSite, linkInfo?.thumb, linkInfo?.duration);
        continue;
      }
      // 「動画を再生」のリンクは、たいてい動画ファイルへそのまま転送される（twihub の /r/v/番号 など）。
      // X の窓口に聞くより確実で速いので、まずリンクの行き先を見る（駄目なら投稿の番号として X に聞く）
      if (playLinks.size < 40) playLinks.set(url, { id: viaSite, thumb: linkInfo?.thumb, duration: linkInfo?.duration });
      continue;
    }
    const added = addEmbed(url, t.attrs.title);
    if (added) {
      // 一覧のカードのサムネイル・再生時間を、埋め込み動画・共有ファイルにも付ける
      const info = anchors.get(url);
      if (info) {
        if (added.kind === "video") added.thumb ??= info.thumb;
        added.duration ??= info.duration;
      }
      continue;
    }
    const kind = kindFromUrl(url);
    if (kind) {
      const info = anchors.get(url);
      add({
        kind,
        src: url,
        thumb: kind === "video" ? info?.thumb : undefined,
        duration: kind === "video" ? info?.duration : undefined,
        format: formatOf(url, kind),
        title: t.attrs.title,
        unverified: kind === "video",
      });
    } else {
      const info = anchors.get(url);
      const thumb = info?.thumb;
      const videoish = info?.videoish || VIDEO_URL_RE.test(url);
      // ダウンロード用のリンク（download.php?id=… など拡張子のないもの）は、中身が動画かもしれない。
      // 辿る先として高い優先度で読む（読んだときに中身を見て、動画ならそれ自体を 1 件にする）
      const download =
        "download" in t.attrs ||
        DOWNLOAD_TEXT_RE.test(info?.text ?? "") ||
        DOWNLOAD_URL_RE.test(new URL(url).pathname + new URL(url).search);
      if (!download && !thumb && isJunkLink(url, info?.text)) continue;
      addLink(url, download ? 5 : thumb ? (videoish ? 4 : 3) : videoish ? 2 : 0, thumb, info?.preview, info?.duration);
    }
  }

  // --- 4b. タップで移動する仕掛け（onclick="location.href='…'"、data-href など） ---
  const clickTarget = (attrs: Record<string, string>): string | null => {
    const direct = attrs["data-href"] ?? attrs["data-link"] ?? attrs["data-permalink"] ?? attrs["data-detail-url"] ?? attrs["data-url"];
    if (direct) return resolveUrl(direct, base);
    const code = attrs.onclick;
    const target = code ? /(?:location(?:\.href)?\s*=|location\.(?:assign|replace)\(|window\.open\()\s*['"]([^'"]+)['"]/.exec(code) : null;
    return target ? resolveUrl(target[1], base) : null;
  };
  // カード型（<div onclick=…><img …></div>）なら、中の画像をサムネイルとして引き継ぐ
  for (const m of markup.matchAll(
    /<(div|li|article|section|span|figure|td|button|p)\b([^>]*\b(?:onclick|data-href|data-link|data-permalink|data-detail-url|data-url)\s*=[^>]*)>([\s\S]{0,4000}?)<\/\1>/gi,
  )) {
    const url = clickTarget(parseAttrs(m[2]));
    if (!url || kindFromUrl(url) || !isPageLikeUrl(url)) continue;
    const thumb = thumbInside(m[3], base);
    const preview = previewInside(`${m[2]}>${m[3]}`, base);
    const videoish = VIDEO_URL_RE.test(url) || DURATION_RE.test(stripTags(m[3])) || !!preview;
    if (!thumb && isJunkLink(url)) continue;
    addLink(url, thumb ? (videoish ? 4 : 3) : videoish ? 2 : 1, thumb, preview);
  }
  for (const m of markup.matchAll(/\sdata-(?:href|link|permalink|detail-url|url)\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)) {
    const url = resolveUrl(decodeEntities(m[1] ?? m[2]), base);
    if (url && !kindFromUrl(url) && isPageLikeUrl(url) && !isJunkLink(url)) addLink(url, VIDEO_URL_RE.test(url) ? 2 : 1);
  }
  for (const m of markup.matchAll(/\sonclick\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const code = decodeEntities(m[1] ?? m[2]);
    const target = /(?:location(?:\.href)?\s*=|location\.(?:assign|replace)\(|window\.open\()\s*['"]([^'"]+)['"]/.exec(code);
    const url = target ? resolveUrl(target[1], base) : null;
    if (url && !kindFromUrl(url) && isPageLikeUrl(url) && !isJunkLink(url)) addLink(url, VIDEO_URL_RE.test(url) ? 2 : 1);
  }

  // --- 5. JSON-LD（構造化データ）の VideoObject / ImageObject ---
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      walkJsonLd(JSON.parse(m[1]), base, add, addEmbed);
    } catch {
      /* 壊れた JSON-LD は無視 */
    }
  }

  // --- 6. スクリプト内に書かれた動画ファイルの URL（JS で作られるプレーヤー対策） ---
  // 読みにくくしたスクリプトは元に戻してから探す
  const unescaped =
    html.replace(/\\\//g, "/").replace(/\\u002[fF]/g, "/").replace(/\\u0026/g, "&") + unpackScripts(html).replace(/\\\//g, "/");
  const addGuess = (raw: string) => {
    const url = resolveUrl(decodeEntities(raw), base);
    if (url && url !== pageUrl) add({ kind: "video", src: url, format: formatOf(url, "video"), unverified: true });
  };
  for (const m of unescaped.matchAll(/https?:\/\/[^\s"'<>\\()]+?\.(?:mp4|m4v|webm|mov|m3u8)\/?(?:\?[^\s"'<>\\()]*)?(?=["'\s<>\\),]|$)/gi)) {
    addGuess(m[0]);
  }
  // 引用符で囲まれた相対パス・プロトコル省略の動画 URL（"/media/123.mp4"、'//cdn.example.com/a.m3u8'、"video/a.mp4" など）
  for (const m of unescaped.matchAll(/["'`]((?:https?:)?\/?[^"'`\s<>\\:]*?\.(?:mp4|m4v|webm|mov|m3u8)(?:\?[^"'`\s<>\\]*)?)["'`]/gi)) {
    addGuess(m[1]);
  }
  // URL の中に入れ子になった動画 URL（player.php?url=https%3A%2F%2F…mp4 など）
  for (const m of unescaped.matchAll(/https?%3A%2F%2F[^"'&\s<>\\]+/gi)) {
    try {
      const inner = decodeURIComponent(m[0]);
      if (kindFromUrl(inner) === "video") addGuess(inner);
    } catch {
      /* 壊れた % 表記は無視 */
    }
  }
  // Base64 で隠した動画 URL（"aHR0cHM6Ly9…" = "https://…"）
  for (const m of unescaped.matchAll(/["'`=](aHR0c[A-Za-z0-9+/_-]{16,}={0,2})/g)) {
    const inner = decodeBase64(m[1]);
    if (inner && /^https?:\/\/[^\s"'<>]+$/.test(inner) && kindFromUrl(inner) === "video") addGuess(inner);
  }
  // 拡張子のない動画 URL も、"video_url": "…" のような動画用のキー名なら候補にする（本当に動画かは後で確かめる）
  let guesses = 0;
  for (const m of unescaped.matchAll(
    /["']?(?:video_?url|video_?src|video_?alt_?url|video_?file|stream_?url|hls_?url|hls_?src|hls|m3u8_?url|mp4_?url|mp4|content_?url|playback_?url|play_?url|manifest_?url|source_?url|file|src)["']?\s*[:=]\s*["'`]((?:https?:)?\/[^"'`\s<>\\]{8,})["'`]/gi,
  )) {
    if (guesses >= 15) break;
    const url = resolveUrl(decodeEntities(m[1]), base);
    if (!url || found.has(url) || url === pageUrl) continue;
    if (kindFromUrl(url) === "video") {
      addGuess(url);
      continue;
    }
    // 画像・スクリプトなど別物とわかる URL は除く。動画らしい言葉を含むものだけ
    if (extensionOf(url) && !/\.(?:php|aspx?|cgi)$/i.test(new URL(url).pathname)) continue;
    if (!/video|stream|hls|m3u8|mp4|media|play|get_file|movie|vod/i.test(url)) continue;
    guesses++;
    add({ kind: "video", src: url, format: "動画", unverified: true, guess: true });
  }

  // --- 6b. 押すまで読み込まない埋め込み動画（lite-youtube、data-youtube-id、スクリプトの中の埋め込み URL など） ---
  let embeds = 0;
  for (const m of html.matchAll(/<lite-youtube\b[^>]*\bvideoid\s*=\s*["']?([\w-]{11})|\sdata-(?:youtube-?id|yt-?id|youtube-?video|ytvideo)\s*=\s*["']([\w-]{11})["']/gi)) {
    if (embeds++ > 40) break;
    addEmbed(`https://www.youtube.com/watch?v=${m[1] ?? m[2]}`);
  }
  for (const m of unescaped.matchAll(
    /https?:\/\/(?:(?:www|m)\.)?(?:youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?v=|shorts\/)[\w-]{11}|youtu\.be\/[\w-]{11}|player\.vimeo\.com\/video\/\d+|(?:www\.)?dailymotion\.com\/(?:embed\/)?video\/[a-z0-9]+|embed\.nicovideo\.jp\/watch\/(?:sm|so|nm)\d+|(?:www\.)?tiktok\.com\/(?:embed\/v2\/\d+|@[\w.-]+\/video\/\d+)|streamable\.com\/e\/[a-z0-9]+|player\.bilibili\.com\/player\.html\?[^"'\s<>\\]+)/gi,
  )) {
    if (embeds++ > 40) break;
    addEmbed(m[0]);
  }

  // --- 7. CSS の背景画像（style="background-image:url(...)" や <style> 内） ---
  for (const m of html.matchAll(/url\(\s*(?:&quot;|["'])?([^"')]+?)(?:&quot;|["'])?\s*\)/gi)) {
    const url = resolveUrl(decodeEntities(m[1]), base);
    if (url && kindFromUrl(url) === "image" && !/\.svg$/i.test(new URL(url).pathname)) {
      add({ kind: "image", src: url, format: formatOf(url, "image") });
    }
  }

  // --- 8. 遅延読み込み用の data-* 属性（data-bg, data-thumb, data-lazy など。どのタグでも） ---
  for (const m of markup.matchAll(
    /\sdata-(?:src|bg|background|background-image|image|img|thumb|thumbnail|original|lazy|lazy-src|lazy-bg|url|full|large)\s*=\s*(?:"([^"]+)"|'([^']+)')/gi,
  )) {
    const raw = decodeEntities(m[1] ?? m[2]).replace(/^url\((["']?)(.*)\1\)$/, "$2");
    const url = resolveUrl(raw, base);
    if (!url) continue;
    const kind = kindFromUrl(url);
    if (kind) add({ kind, src: url, format: formatOf(url, kind), unverified: kind === "video" });
  }

  // --- 9. JavaScript のデータ（Next.js / Nuxt などが埋め込む JSON）の中の画像 URL ---
  // 画面を JavaScript で後から描くサイトは、HTML に <img> がなく、ここにだけ URL がある
  for (const m of unescaped.matchAll(
    /https?:\/\/[^\s"'<>\\()]+?\.(?:jpe?g|png|webp|gif|avif)(?:\?[^\s"'<>\\()]*)?(?=["'\s<>\\),])/gi,
  )) {
    const url = resolveUrl(m[0], base);
    if (url && !found.has(url)) add({ kind: "image", src: url, format: formatOf(url, "image") });
  }
  // 拡張子のない画像 URL も、"thumbnail": "https://..." のようなキー名なら拾う
  for (const m of unescaped.matchAll(
    /"(?:thumb|thumbnail|thumbnailUrl|thumbnail_url|thumbUrl|thumb_url|image|imageUrl|image_url|img|poster|cover|coverUrl|cover_url|ogImage|og_image)"\s*:\s*"(https?:\/\/[^"\s]+)"/gi,
  )) {
    const url = resolveUrl(m[1], base);
    if (url && !found.has(url) && kindFromUrl(url) !== "video") {
      add({ kind: "image", src: url, format: formatOf(url, "image") });
    }
  }

  // ページの代表動画（og:video）にポスターがない場合だけ、OGP 画像を代わりに使う。
  // 他の動画に使うと、全部同じサイトのロゴ画像になってしまうため
  if (ogImage && ogVideo) {
    const main = found.get(ogVideo);
    if (main && !main.thumb) main.thumb = ogImage;
  }
  // ページの代表動画の長さは、代表動画（なければ、ページにただ 1 本ある動画）に付ける
  if (metaDuration) {
    const vids = [...found.values()].filter((m) => m.kind !== "image");
    const main = (ogVideo && found.get(ogVideo)) || (vids.length === 1 ? vids[0] : undefined);
    if (main) main.duration ??= metaDuration;
  }

  // スクリプトで別のページへ飛ばすだけのページ（location.href = "…"）
  if (!redirect) {
    const js =
      /(?:^|[;{}\s])(?:window\.|top\.|self\.|document\.|parent\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/.exec(html) ??
      /location\.(?:replace|assign)\(\s*["']([^"']+)["']\s*\)/.exec(html);
    const url = js ? resolveUrl(js[1], base) : null;
    if (url && url !== pageUrl && isPageLikeUrl(url)) redirect = url;
  }
  const gate = GATE_RE.test(stripTags(markup).slice(0, 20000));

  // カードのプレビュー動画も、いったん候補に入れる（詳細ページを読まないときは、これが唯一の動画になるため）。
  // 詳細ページを読むかどうかで、出すか出さないかは辿る側が決める
  for (const link of links.values()) {
    if (link.preview && !found.has(link.preview)) {
      add({ kind: "video", src: link.preview, thumb: link.thumb, format: formatOf(link.preview, "video"), unverified: true });
    }
  }

  // スクリプト・data 属性の中の投稿の番号（JavaScript で一覧を描くサイト・埋め込み投稿）
  for (const id of findTweetIds(html, 150)) addTweet(id);
  for (const m of html.replace(/\\\//g, "/").matchAll(/gofile\.io\/d\/([\w-]{4,40})/g)) if (gofile.size < 30) gofile.add(m[1]);
  // X の動画のサムネイルは画像としては出さない（動画の表紙なので）。GIF アニメは表紙の名前から動画がわかる
  for (const m of [...found.values()]) {
    if (m.kind !== "image" || !isTwitterVideoThumb(m.src)) continue;
    found.delete(m.id);
    const gif = gifVideoFromThumb(m.src);
    if (gif && !found.has(gif)) add({ kind: "video", src: gif, thumb: m.src, format: "GIF→MP4", title: m.title });
  }

  const pagination = findPagination(markup, tags, base, pageUrl);
  const clientRendered =
    /__NEXT_DATA__|self\.__next_f|window\.__NUXT__|id=["']__nuxt["']|data-reactroot|id=["'](?:root|app)["']\s*>\s*<\/div>|ng-version=/i.test(html) ||
    (tags.filter((t) => t.name === "img").length < 3 && (html.match(/<script\b/gi)?.length ?? 0) > 10);
  const playerHint =
    /video-js|videojs|jwplayer|jw-player|plyr|flowplayer|mediaelement|dplayer|artplayer|clappr|fluidplayer|shaka-player|<video\b|hls(?:\.min)?\.js|dash(?:\.all)?(?:\.min)?\.js|\.m3u8/i.test(
      html,
    ) || [...frames].some((f) => VIDEO_URL_RE.test(f));
  // プレーヤーらしい iframe（URL に embed / player / video などを含む）を先に読む
  const frameList = [...frames].sort((a, b) => Number(VIDEO_URL_RE.test(b)) - Number(VIDEO_URL_RE.test(a)));
  return {
    clientRendered,
    playerHint,
    // 広告の配信元の画像・動画（バナー・広告動画）と、広告へのリンクは除く
    media: [...found.values()].filter((m) => !isAdUrl(m.src)),
    links: [...links.values()].filter((l) => !isAdUrl(l.url)),
    pagination,
    frames: frameList.slice(0, 6),
    ogImage,
    title: pageTitle,
    redirect,
    gate,
    tweets: [...tweets.values()],
    gofile: [...gofile],
    playLinks: [...playLinks].map(([url, ref]) => ({ url, ...ref })),
  };
}

type AddFn = (item: Omit<MediaItem, "id" | "pageUrl">) => MediaItem;

function walkJsonLd(
  node: unknown,
  base: string,
  add: AddFn,
  addEmbed: (url: string, title?: string) => MediaItem | null,
  depth = 0,
): void {
  if (depth > 8 || node == null) return;
  if (Array.isArray(node)) {
    for (const n of node) walkJsonLd(n, base, add, addEmbed, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  const type = String(obj["@type"] ?? "");
  const str = (v: unknown): string | undefined => {
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return str(v[0]);
    if (v && typeof v === "object" && "url" in v) return str((v as { url: unknown }).url);
    return undefined;
  };
  const name = str(obj.name);
  if (/VideoObject/i.test(type)) {
    const thumb = resolveUrl(str(obj.thumbnailUrl) ?? str(obj.thumbnail), base) ?? undefined;
    const content = resolveUrl(str(obj.contentUrl), base);
    const embed = resolveUrl(str(obj.embedUrl), base);
    const duration = parseIsoDuration(str(obj.duration));
    if (content) add({ kind: "video", src: content, thumb, format: formatOf(content, "video") ?? "動画", title: name, duration });
    else if (embed) {
      const added = addEmbed(embed, name) ?? add({ kind: "embed", src: embed, thumb, format: "埋め込み", title: name });
      added.duration ??= duration;
      added.thumb ??= thumb;
    }
  } else if (/ImageObject/i.test(type)) {
    const content = resolveUrl(str(obj.contentUrl) ?? str(obj.url), base);
    if (content) add({ kind: "image", src: content, format: formatOf(content, "image"), title: name });
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") walkJsonLd(v, base, add, addEmbed, depth + 1);
  }
}
