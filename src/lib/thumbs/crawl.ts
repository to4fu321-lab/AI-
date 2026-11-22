import "server-only";
import { AD_FRAME_RE, VIDEO_URL_RE, extensionOf, extractFromHtml, formatOf, type LinkCandidate, isPageLikeUrl, kindFromContentType, kindFromUrl } from "./extract";
import { mediaKey, SeenMedia, variantKey } from "./dedupe";
import { isExcluded, isItemExcluded } from "./exclude";
import { fetchInBrowser } from "./browserSession";
import { checkInBrowser, RenderDeferred, renderPage, type Rendered } from "./render";
import { checkMedia } from "./probe";
import { folderListPage, hostedFile } from "./filehost";
import { isAdUrl } from "./adblock";
import { gifVideoFromThumb, tweetGofileIds, tweetIdInUrl, tweetIdOf, tweetShareUrls, tweetVideos } from "./twitter";
import { pixeldrainList, pixeldrainListId } from "./pixeldrain";
import { isTwihubList, isTwihubListApi, twihubFromJson, twihubNextFromHtml } from "./sites";
import { gofileDougaApi, gofileDougaList } from "./gofileDouga";
import { linkexFiles, linkexList, linkexPlan } from "./linkex";
import { gofileFiles, gofileId, type GofileResult } from "./gofile";
import type { TweetRef } from "./extract";
import { CookieJar, FetchBlockedError, safeFetch, thumbsLog } from "./safeFetch";
import { isVagueType, mediaMime, readHead } from "./sniff";
import type { CrawlEvent, CrawlHome, CrawlOptions, CrawlState, MediaItem, QueueItem } from "./types";

/**
 * 入力 URL から「同じサイトの、同じ階層より下」のページを幅優先で辿り、メディアを集める。
 * 結果はページを読むたびに少しずつ yield する（画面に順次出すため）。
 *
 * 動画を探しているのに見つからないときは、範囲を自動で広げる：
 *   同じサイトの別の場所 → もっと深い階層 → リンク先の別サイト
 * （範囲の外のページからは動画だけを集め、画像は集めない）
 */

const MAX_HTML_BYTES = 3 * 1024 * 1024;
const CONCURRENCY = 6;

/** 入力 URL の「階層」。/gallery/page.html → /gallery/ 、/gallery → /gallery/ */
export function scopeOf(url: URL): string {
  let path = url.pathname;
  const last = path.split("/").pop() ?? "";
  if (last.includes(".")) path = path.slice(0, path.length - last.length);
  return path.endsWith("/") ? path : `${path}/`;
}

/** 2 段目が種類を表すドメイン（example.co.jp、example.com.au など）の 2 段目 */
const SECOND_LEVEL = new Set(["co", "ne", "or", "ac", "go", "gr", "ed", "lg", "ad", "com", "net", "org", "edu", "gov"]);

/**
 * 「同じサイト」を見分けるための名前。www.example.com・m.example.com・example.com はどれも example.com。
 * （入力した URL が www. 付きやスマホ用のアドレスへ転送されても、同じサイトとして辿れるように）
 */
export function siteOf(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (/^[\d.]+$/.test(host) || host.includes(":")) return host;
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const tld = labels[labels.length - 1];
  const keep = tld.length === 2 && SECOND_LEVEL.has(labels[labels.length - 2]) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

function homeOf(urls: string[]): CrawlHome {
  const last = new URL(urls[urls.length - 1]);
  return { sites: [...new Set(urls.map((u) => siteOf(new URL(u).hostname)))], scope: scopeOf(last), path: last.pathname };
}

/** 入力した場所から見た範囲。0: 入力した階層の中 / 1: 同じサイトの別の場所 / 2: 別のサイト */
function zoneOf(candidate: string, home: CrawlHome): number {
  try {
    const u = new URL(candidate);
    if (!home.sites.includes(siteOf(u.hostname))) return 2;
    return u.pathname === home.path || u.pathname.startsWith(home.scope) || `${u.pathname}/` === home.scope ? 0 : 1;
  } catch {
    return 2;
  }
}

/** 同じページを別 URL で二重に読まないための正規化 */
function normalizePageUrl(url: string): string {
  const u = new URL(url);
  u.hash = "";
  for (const key of [...u.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|ref$|ref_src)/.test(key)) u.searchParams.delete(key);
  }
  if (u.pathname !== "/" && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

async function readLimited(res: Response, limit: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  const buf = new Uint8Array(Math.min(size, limit));
  let offset = 0;
  for (const c of chunks) {
    const part = c.subarray(0, Math.min(c.byteLength, buf.byteLength - offset));
    buf.set(part, offset);
    offset += part.byteLength;
    if (offset >= buf.byteLength) break;
  }
  const charset = /charset=([\w-]+)/i.exec(res.headers.get("content-type") ?? "")?.[1];
  const sniff = new TextDecoder("latin1").decode(buf.subarray(0, 2048));
  const metaCharset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(sniff)?.[1];
  try {
    return new TextDecoder(charset || metaCharset || "utf-8").decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

/** robots.txt の「User-agent: *」の Disallow を守る（行儀のよいクローラーにするため） */
async function loadRobots(origin: string, signal: AbortSignal): Promise<(path: string) => boolean> {
  try {
    const { res } = await safeFetch(`${origin}/robots.txt`, { timeoutMs: 5000, signal });
    if (!res.ok) return () => true;
    const text = await readLimited(res, 256 * 1024);
    const disallow: string[] = [];
    const allow: string[] = [];
    let applies = false;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.replace(/#.*/, "").trim();
      const m = /^([\w-]+)\s*:\s*(.*)$/.exec(line);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const value = m[2].trim();
      if (key === "user-agent") applies = value === "*";
      else if (applies && key === "disallow" && value) disallow.push(value);
      else if (applies && key === "allow" && value) allow.push(value);
    }
    const matches = (path: string, rule: string) => {
      const re = new RegExp(
        "^" + rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"),
      );
      return re.test(path);
    };
    return (path) => {
      const a = Math.max(-1, ...allow.filter((r) => matches(path, r)).map((r) => r.length));
      const d = Math.max(-1, ...disallow.filter((r) => matches(path, r)).map((r) => r.length));
      return d < 0 || a >= d;
    };
  } catch {
    return () => true;
  }
}

/** 一度に確かめる数 */
const VERIFY_CONCURRENCY = 24;
/** 確認待ちとして次の回へ持ち越せる数の上限 */
export const MAX_PENDING = 3000;
/** 次の回へ持ち越す指紋の数の上限 */
export const MAX_PRINTS = 5000;
/** 動画のページらしいのに動画が見つからないとき、念のためブラウザで開いてみる回数（サイトごと。見つかったサイトは上限なし） */
const MAX_GUESS_RENDERS = 3;
/** 動画プレーヤーを置く部品らしい名前（id・class） */
const PLAYERISH_RE = /\b(?:id|class)\s*=\s*["'][^"']*(?:player|video|movie|douga|vjs|stream)[^"']*["']/i;
/** 同じ種類のページが何回続けて確認を求められたら、読みに行かずに「サイトで開く」に並べるか */
const GATED_STREAK = 3;
/** ファイル置き場（Gofile・pixeldrain・Google ドライブなど）に置かれたものか（「ファイル置き場を探す」で集めるもの） */
function isFileHostItem(m: MediaItem): boolean {
  return /^(?:Gofile|pixeldrain|Google ドライブ|Dropbox|OneDrive|Box)$/.test(m.format ?? "") || /^https:\/\/files\.catbox\.moe\//.test(m.src);
}
/** Gofile 探しで、1 つのサイトから辿るページ数の上限 */
const HUNT_PAGES_PER_SITE = 12;
/** Gofile 探しで辿らないサイト（道具・解析・辞書・検索など。Gofile の動画を紹介する場所ではない） */
const HUNT_SKIP_RE =
  /(?:^|\.)(?:github\.com|gitlab\.com|pypi\.org|npmjs\.com|stackoverflow\.com|virustotal\.com|pulsedive\.com|criminalip\.io|urlscan\.io|hybrid-analysis\.com|scribd\.com|wikipedia\.org|facebook\.com|google\.com|microsoft\.com|bing\.com|yahoo\.co\.jp|yahoo\.com|naver\.com|seznam\.cz|sogou\.com|qq\.com|tencent\.com|csdn\.net|alternativeto\.net|any\.run|docsbot\.ai|yarnpkg\.com|gopeed\.com|chromewebstore\.google\.com|apple\.com|trustpilot\.com|scamadviser\.com|similarweb\.com)$/i;
/** Linkex のサイト（入力したのがこれらのときだけ、Linkex の一覧を読む） */
const LINKEX_SITE_RE = /(?:^|\.)(?:linkex-douga\.com|l2e\.click|linkex\.io)$/i;
/**
 * 「同じ種類のページ」の見分け方：サイト＋最後の部分を除いたパス
 * （/posts/abc → /posts。一覧の /posts?type=… や /gated/?page=2 とは別の種類として扱う）
 */
function gateKey(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    return `${u.origin}/${parts.slice(0, -1).join("/")}|${parts.length}`;
  } catch {
    return url;
  }
}
/** 断られた動画をブラウザで確かめ直す数の上限（1 回の実行あたり） */
const MAX_BROWSER_CHECKS = 10;
/** 時間切れ・通信の失敗で確かめられなかったものを、何回まで確かめ直すか */
const MAX_VERIFY_TRIES = 3;

/**
 * 画像・動画のリンク切れを確かめる。stopAt までに確かめきれなかったものは rest で返す（次に持ち越す）。
 * - 見られると確かめられたもの（yes）だけを ok で返す。リンク切れ（no）は捨てる
 * - 時間切れ・通信の失敗（unknown）は、MAX_VERIFY_TRIES 回まで rest に戻して確かめ直す
 */
async function verifyMedia(
  items: MediaItem[],
  signal: AbortSignal,
  stopAt: number,
  jar: CookieJar,
): Promise<{ ok: MediaItem[]; rest: MediaItem[]; refused: MediaItem[]; gone: number }> {
  const ok: MediaItem[] = [];
  const rest: MediaItem[] = [];
  /** こちらのサーバーが断られた動画（ブラウザでなら見られるかもしれない） */
  const refused: MediaItem[] = [];
  let gone = 0;
  const prints = new Map<MediaItem, string | undefined>();
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      if (Date.now() > stopAt || signal.aborted) return;
      const item = items[next++];
      // Gofile のファイルは、Gofile の窓口が「ある」と答えたもの。1 つずつ確かめに行くと、
      // Gofile の配信サーバーに「聞きすぎ」（429）で止められるので、確かめずに出す
      if (item.format === "Gofile" && item.cookie) {
        ok.push(item);
        continue;
      }
      const { result, fp, refused: wasRefused, duration, thumb } = await checkMedia(item, signal, jar);
      if (result === "yes") {
        // ファイルの中に書いてある長さのほうが、ページの表示より確か
        if (duration) item.duration = Math.round(duration * 10) / 10;
        if (thumb) item.thumb ??= thumb;
        ok.push(item);
        prints.set(item, fp);
      } else if (result === "no" && item.kind !== "image") {
        if (wasRefused && item.kind === "video") refused.push(item);
        else gone++;
      }
      else if (result === "unknown" && (item.tries ?? 0) + 1 < MAX_VERIFY_TRIES) rest.push({ ...item, tries: (item.tries ?? 0) + 1 });
    }
  };
  await Promise.all(Array.from({ length: Math.min(VERIFY_CONCURRENCY, items.length) }, worker));
  rest.push(...items.slice(next));
  // 見つけた順に並べ直す
  const order = new Map(items.map((m, i) => [m, i]));
  ok.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  return {
    ok: ok.map((m) => ({ ...m, unverified: undefined, guess: undefined, tries: undefined, checked: true, fp: prints.get(m) })),
    rest,
    refused,
    gone,
  };
}

/**
 * サムネイルのない動画に、代わりのサムネイルを付ける。
 * 1. このページへのリンクに付いていたサムネイル（一覧ページの画像）… 動画が 3 本以下のとき
 * 2. ページの代表画像（og:image）… 動画が 2 本以下のとき（多いと全部同じ画像になるため）
 *    ただしサイト共通のロゴらしい画像は渡さない（呼ぶ側で判定）。
 * どちらもなければ、画面側で動画から 1 コマ取り出してサムネイルを作る。
 */
function fillThumbs(
  media: MediaItem[],
  linkThumb: string | undefined,
  ogImage: string | undefined,
  linkDuration?: number,
  linkTitle?: string,
) {
  const videos = media.filter((m) => m.kind !== "image");
  if (videos.length === 0) return;
  // 一覧のカードに書かれていた題名（サイトが付けた動画のタイトル）を、詳細ページの動画に付ける
  if (linkTitle && videos.length <= 3) for (const v of videos) v.title = linkTitle;
  // 一覧のカードに出ていた再生時間は、詳細ページの動画が 1 本だけのときに付ける（何本もあると、どれの長さかわからない）
  if (linkDuration && videos.length === 1) videos[0].duration ??= linkDuration;
  for (const v of videos) {
    if (v.thumb) continue;
    if (linkThumb && videos.length <= 3) v.thumb = linkThumb;
    else if (ogImage && videos.length <= 2) v.thumb = ogImage;
  }
}

/**
 * 同じページにある「同じ動画の画質・形式違い」（a_720p.mp4・a_480p.mp4・a/master.m3u8、合言葉だけ違う URL）を 1 つにまとめる。
 * 残すのは、どの端末でも再生・保存しやすい MP4 → 画質の高いもの → 先に見つけたもの、の順
 */
function pickVariants(items: MediaItem[]): MediaItem[] {
  const score = (m: MediaItem) => {
    const mp4 = /\.(?:mp4|m4v|mov)$/i.test(new URL(m.src).pathname) ? 100000 : 0;
    const res = /(?:^|[_\-./])(240|360|480|540|720|1080|1440|2160)p?(?=$|[_\-./])/i.exec(new URL(m.src).pathname);
    return mp4 + (res ? Number(res[1]) : 0);
  };
  const best = new Map<string, MediaItem>();
  const out: MediaItem[] = [];
  for (const m of items) {
    const keys = [`file:${mediaKey(m)}`, variantKey(m)].filter((k): k is string => !!k);
    const prev = keys.map((k) => best.get(k)).find(Boolean);
    if (!prev) {
      out.push(m);
      for (const k of keys) best.set(k, m);
      continue;
    }
    // 同じ動画。よいほうを残し、サムネイル・題名は補い合う
    const [keep, drop] = score(m) > score(prev) ? [m, prev] : [prev, m];
    keep.thumb ??= drop.thumb;
    keep.title ??= drop.title;
    if (keep !== prev) out[out.indexOf(prev)] = keep;
    for (const k of [...keys, ...[...best].filter(([, v]) => v === prev).map(([k]) => k)]) best.set(k, keep);
  }
  return out;
}

/** iframe の中を読みに行く数・深さ・大きさの上限 */
const MAX_FRAMES_PER_PAGE = 3;
const MAX_FRAME_LEVEL = 2;
const MAX_FRAME_BYTES = 1.5 * 1024 * 1024;

/** 途中経過の記録を送る間隔 */
const CHECKPOINT_MS = 8000;

/** 途中経過を送り返してもらうときの大きさの上限（巨大なデータを送りつけられないように） */
export const MAX_QUEUE = 5000;
export const MAX_SEEN = 20000;
export const MAX_RESERVE = 1500;

/**
 * 範囲を広げるときの上限。
 * - 「下の階層」の設定より、最大で何階層ぶん先まで進むか
 * - 1 回に足すページ数
 * - 動画が 1 本も見つからないまま読むページ数（動画のないサイトで延々と探し続けないように）
 */
const WIDEN_EXTRA_DEPTH = 2;
const WIDEN_STEP = 40;
const WIDEN_BLIND_PAGES = 60;

/** サイトが自動アクセスを断るときの返事（ブラウザで開き直すと通ることがある） */
const BLOCKED_STATUS = new Set([401, 403, 406, 409, 429]);
/** ブラウザで開き直しても断られたとき、何ページであきらめるか */
const MAX_BLOCKED_TRIES = 3;

/** ページを開くときに名乗る内容（ブラウザでリンクを開いたときと同じ） */
const PAGE_HEADERS = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/*,video/*;q=0.8,*/*;q=0.5",
  "upgrade-insecure-requests": "1",
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
};

/**
 * URL の「形」：ドメイン＋最初の部分（数字は # にする）＋部分の数。
 * /user/123・/user/456 は同じ形、/video/1 とは違う形。動画のないページが続く形を覚えて、読まないようにする
 */
function shapeOf(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    const first = (parts[0] ?? "").toLowerCase().replace(/\d+/g, "#").slice(0, 40);
    return `${u.host}/${first}:${parts.length}`;
  } catch {
    return url;
  }
}
/** 同じ形のページで、動画が何回見つからなかったら、その形のページを読まなくなるか */
const BARREN_LIMIT = 3;
/** 動画らしいリンクが何本あれば「動画の一覧ページ」とみなし、ふつうのリンク（メニューなど）を後回しにするか */
const LISTING_MIN_LINKS = 4;

/** 読む順番：段（rank）の小さい順、同じ段なら優先度（prio）の大きい順 */
function byOrder(a: QueueItem, b: QueueItem) {
  return (a.rank ?? a.depth) - (b.rank ?? b.depth) || (b.prio ?? 0) - (a.prio ?? 0);
}

function describeFailure(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.name === "TimeoutError") return "時間切れ（サイトの応答が遅すぎます）";
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  return cause?.code ? `接続できませんでした（${cause.code}）` : err.message;
}

/**
 * 実行中の様子（呼ぶ側が見る）。サーバーの実行時間の上限が迫っても読み終わらないとき、
 * 呼ぶ側はここにある「いま読んでいる組を始める前の途中経過」を続きとして画面に返す
 */
export interface CrawlProgress {
  /** いま読んでいる組を始める前の途中経過 */
  safe?: CrawlState;
  /** いま読んでいるページ → 読み始めた時刻 */
  inFlight: Map<string, number>;
}

/** 途中経過に、読み終わらなかったページを書き足す（呼ぶ側が、時間切れのときに使う） */
export function markStuck(state: CrawlState, urls: string[]): CrawlState {
  const stuck = new Map(state.stuck ?? []);
  for (const u of urls) {
    const key = normalizePageUrl(u);
    stuck.set(key, (stuck.get(key) ?? 0) + 1);
  }
  return { ...state, stuck: [...stuck].slice(-200) };
}

export async function* crawl(
  startUrl: string,
  options: CrawlOptions,
  signal: AbortSignal,
  deadline: number,
  resume?: CrawlState,
  progress?: CrawlProgress,
): AsyncGenerator<CrawlEvent> {
  /** 時間切れまでに読み終わらなかったページ（1 回目は軽く読み直し、2 回目は飛ばす） */
  const stuck = new Map<string, number>(resume?.stuck ?? []);
  const wantsVideo = options.kinds !== "image";
  /** 動画が見つからないときに、範囲を自動で広げるか（「辿らない」や「別のサイトも辿る」のときは不要） */
  const autoWiden = wantsVideo && !options.crossSite && options.depth > 0;
  /** 「同じサイト・同じ階層」の基準。入力したページが転送されたら、転送先に合わせ直す */
  let home: CrawlHome = resume?.home ?? homeOf([startUrl]);
  const jar = new CookieJar(resume?.cookies);

  // robots.txt はサイトごとに 1 回だけ読む
  const robots = new Map<string, Promise<(path: string) => boolean>>();
  const allowed = async (url: string) => {
    if (!options.robots) return true;
    const u = new URL(url);
    let rule = robots.get(u.origin);
    if (!rule) {
      rule = loadRobots(u.origin, signal);
      robots.set(u.origin, rule);
    }
    return (await rule)(u.pathname);
  };

  const seenPages = new Set<string>(resume?.seen ?? [normalizePageUrl(startUrl)]);
  const seenMedia = new SeenMedia();
  const queue: QueueItem[] = resume?.queue ?? [{ url: startUrl, depth: 0, rank: 0, root: true }];
  /** 範囲や階層の外だったので後回しにしたリンク */
  const reserve: QueueItem[] = resume?.reserve ?? [];
  const reservedByKey = new Map<string, QueueItem>(reserve.map((q) => [normalizePageUrl(q.url), q]));
  let pages = resume?.pages ?? 0;
  let paginationUsed = resume?.paginationUsed ?? 0;
  let videos = resume?.videos ?? 0;
  let found = resume?.found ?? 0;
  let widened = resume?.widened ?? 0;
  let mediaCount = 0;
  /**
   * 見つけたが、まだリンク切れかどうか確かめていない画像・動画。
   * 確かめて見られたものだけを画面へ送る（リンク切れは最初から出さない）
   */
  const pending: MediaItem[] = resume?.pending ?? [];
  /** 見つけたが出さなかった動画の数（ファイルがない / サイトに断られた）。何も取れなかったときの説明に使う */
  let goneVideos = resume?.dropped?.[0] ?? 0;
  let refusedVideos = resume?.dropped?.[1] ?? 0;
  /** ブラウザで確かめ直した数（1 回の実行で多くなりすぎないように） */
  let browserChecks = 0;
  /**
   * 確認の結果を受け取り、こちらのサーバーが断られた動画は本物のブラウザで確かめ直す
   * （ブラウザなら通すサイトがあるため。通れば一覧に出す）
   */
  const settle = async (v: { ok: MediaItem[]; refused: MediaItem[]; gone: number }): Promise<MediaItem[]> => {
    goneVideos += v.gone;
    const ok = [...v.ok];
    for (const m of v.refused) {
      if (options.render === "off" || browserChecks >= MAX_BROWSER_CHECKS || Date.now() > deadline || signal.aborted) {
        refusedVideos++;
        continue;
      }
      browserChecks++;
      if (await checkInBrowser(m.src, m.referer ?? m.pageUrl, signal)) {
        ok.push({ ...m, unverified: undefined, guess: undefined, tries: undefined, checked: true });
      } else refusedVideos++;
    }
    return ok;
  };
  /** 送った画像・動画の中身の指紋（URL が違っても同じファイルなら 2 個目は出さない） */
  const seenPrints = new Set<string>(resume?.prints ?? []);
  /** 中身が同じなので出さなかった数（「このページの動画は、もう出した動画だった」とわかるように） */
  let samePrint = 0;
  const dropSamePrint = (items: MediaItem[]) =>
    items.filter((m) => {
      if (!m.fp) return true;
      if (seenPrints.has(m.fp)) {
        samePrint++;
        return false;
      }
      seenPrints.add(m.fp);
      return true;
    });
  let lastRank = 0;

  /** 動画（「画像のみ」なら画像）が見つからなかったページの形と回数・見つかったページの形 */
  const barren = new Map<string, number>(resume?.barren ?? []);
  const fruitful = new Set<string>(resume?.fruitful ?? []);
  /**
   * 読まずに飛ばしてよいページか：入力したページでも、動画らしいリンクでもなく、
   * 同じ形のページを何度読んでも何も見つからず、その形で見つかったことが一度もない
   */
  const isBarren = (q: QueueItem) => {
    if (q.root || (q.prio ?? 0) >= 2) return false;
    const shape = shapeOf(q.url);
    return !fruitful.has(shape) && (barren.get(shape) ?? 0) >= BARREN_LIMIT;
  };

  /** メニュー・カテゴリなどとして後回しにしたリンク（ほかのページに同じリンクがあっても辿らない） */
  const navLinks = new Set<string>();

  const snapshot = (): CrawlState => ({
    queue: [...queue],
    seen: [...seenPages],
    pages,
    paginationUsed,
    reserve: [...reserve],
    videos,
    found,
    widened,
    home,
    cookies: jar.toJSON(),
    stuck: stuck.size ? [...stuck] : undefined,
    pending: pending.slice(0, MAX_PENDING),
    prints: [...seenPrints].slice(-MAX_PRINTS),
    dropped: [goneVideos, refusedVideos],
    barren: [...barren].slice(-500),
    fruitful: [...fruitful].slice(-500),
  });

  /** 列に入っているページを URL から引くための索引（サムネイル・優先度を後から補うとき用） */
  const queuedByUrl = new Map<string, QueueItem>(queue.map((q) => [q.url, q]));

  const enqueue = (
    url: string,
    depth: number,
    rank: number,
    prio: number,
    thumb?: string,
    zone = 0,
    root = false,
    from?: string,
    preview?: string,
  ) => {
    if (!isPageLikeUrl(url) || isExcluded(url, options.exclude)) return false;
    const key = normalizePageUrl(url);
    if (seenPages.has(key)) {
      // すでに列にあるページなら、サムネイルと優先度だけ補う
      if (thumb || prio > 0) {
        const queued = queuedByUrl.get(url);
        if (queued) {
          queued.thumb ??= thumb;
          queued.preview ??= preview;
          queued.prio = Math.max(queued.prio ?? 0, prio);
        }
      }
      return false;
    }
    if (seenPages.size >= MAX_SEEN || queue.length >= MAX_QUEUE) return false;
    seenPages.add(key);
    const entry: QueueItem = { url, depth, rank, prio, thumb };
    if (zone) entry.zone = zone;
    if (root) entry.root = true;
    if (from) entry.from = from;
    if (preview) entry.preview = preview;
    queue.push(entry);
    queuedByUrl.set(url, entry);
    return true;
  };

  /** 今は辿らないリンクを取っておく（動画が見つからないときに、ここから範囲を広げる） */
  const hold = (url: string, depth: number, prio: number, thumb: string | undefined, zone: number, from?: string) => {
    if (!isPageLikeUrl(url) || isExcluded(url, options.exclude)) return;
    const key = normalizePageUrl(url);
    if (seenPages.has(key)) return;
    const prev = reservedByKey.get(key);
    if (prev) {
      prev.thumb ??= thumb;
      prev.prio = Math.max(prev.prio ?? 0, prio);
      prev.depth = Math.min(prev.depth, depth);
      return;
    }
    if (reserve.length >= MAX_RESERVE) return;
    const entry: QueueItem = { url, depth, prio, thumb, zone, from };
    reserve.push(entry);
    reservedByKey.set(key, entry);
  };

  /**
   * 読むページがなくなったとき、取っておいたリンクから範囲を広げる。
   * - 動画がまだ 1 本もない間：優先度の高い順に何でも（WIDEN_BLIND_PAGES ページまで）
   * - 広げた先で動画が見つかり始めたら：サムネイル付き・動画らしいリンクだけを続ける
   */
  const widen = (): number => {
    if (!autoWiden || !reserve.length) return 0;
    if (videos === 0 ? widened >= WIDEN_BLIND_PAGES : widened === 0) return 0;
    reserve.sort((a, b) => (b.prio ?? 0) - (a.prio ?? 0) || (a.zone ?? 0) - (b.zone ?? 0) || a.depth - b.depth);
    const limit = videos === 0 ? Math.min(WIDEN_STEP, WIDEN_BLIND_PAGES - widened) : WIDEN_STEP;
    // サムネイル付き・動画らしいリンクがあるうちは、それだけを足す（普通のリンクは、それでも見つからないときに）
    const promising = (reserve[0].prio ?? 0) >= 2;
    let added = 0;
    while (reserve.length && added < limit) {
      if ((videos > 0 || promising) && (reserve[0].prio ?? 0) < 2) break;
      const c = reserve.shift()!;
      reservedByKey.delete(normalizePageUrl(c.url));
      if (enqueue(c.url, c.depth, lastRank + 1, c.prio ?? 0, c.thumb, c.zone ?? 0, false, c.from)) {
        added++;
        const q = c.duration ? queuedByUrl.get(c.url) : undefined;
        if (q) q.duration = c.duration;
      }
    }
    widened += added;
    return added;
  };

  /** og:image ごとの、それを使っていたページ数（サイト共通のロゴを見分ける） */
  const ogPages = new Map<string, number>();
  /** 時間切れで次の回に回すページ */
  const deferred: QueueItem[] = [];
  /** 普通の読み込みを断るので、最初からブラウザで開くサイト */
  const browserOnly = new Set<string>();
  /** ブラウザで一度通れたサイト（もらった Cookie で普通の読み込みが通るか、次のページで試す） */
  const browserPassed = new Set<string>();
  let blockedTries = 0;
  let renderStarts = 0;
  /**
   * 「動画があるはずなのに 1 本も見つからない」ページを、念のためブラウザで開いた回数（サイトごと）と、それで見つかった回数。
   * 何度開いても見つからないサイトでは、それ以上は開かない（時間がかかるため）
   */
  const guessRenders = new Map<string, { tries: number; hits: number }>();
  let lastCheckpoint = Date.now();
  let robotsSkipped = 0;
  /** 確認を求められた・断られたので読めなかったページの数 */
  /** Gofile 探し：サイトごとに、辿ることにしたページの数 */
  const huntPerSite = new Map<string, number>();
  let gatedPages = 0;
  /** 動画は取り出せなかったが、サムネイルだけ並べたページの数 */
  let thumbOnlyPages = 0;
  /** リンクはあったが、Gofile では消されていた・空だったフォルダの数 */
  let goneGofile = 0;
  /** アプリでしか再生できない動画（Linkex）として並べた数 */
  let appOnly = 0;
  /** 中身を読んだ Linkex の共有リンク */
  const seenLinkex = new Set<string>();
  /** サイト・ページの種類ごとの、続けて確認を求められた回数 */
  const gatedStreak = new Map<string, number>();
  let lastError: string | null = null;
  let noted = false;

  const openInBrowser = async (target: string): Promise<Rendered> => {
    // 1 回の実行で最初のブラウザ表示は必ず行う（次の回へ回し続けて進まなくなるのを防ぐ）
    const startBy = renderStarts++ === 0 ? Number.POSITIVE_INFINITY : deadline;
    const began = Date.now();
    let r: Rendered;
    try {
      r = await renderPage(target, signal, startBy, { play: wantsVideo });
    } catch (err) {
      thumbsLog(`browser 失敗 ${Date.now() - began}ms ${err instanceof Error ? `${err.name} ${err.message.slice(0, 120)}` : String(err)} ${target.slice(0, 100)}`);
      throw err;
    }
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(r.html)?.[1]?.replace(/\s+/g, " ").trim().slice(0, 40) ?? "";
    thumbsLog(`browser ${r.status} ${Date.now() - began}ms html=${r.html.length} 通信=${r.network.length} 題名「${title}」 ${r.finalUrl.slice(0, 100)}`);
    // 年齢確認の結果などの Cookie は、以降の普通の読み込みでも使う
    try {
      const site = siteOf(new URL(r.finalUrl).hostname);
      for (const c of r.cookies) if (siteOf(c.domain) === site) jar.put(c.domain, c.name, c.value);
    } catch {
      /* ignore */
    }
    return r;
  };

  /**
   * iframe で埋め込まれたページ（外部の動画プレーヤーなど）を読み、中の動画を集める。
   * 動画が見つからなければ、その中の iframe をもう 1 段だけ読む。
   * 見つけた動画の「元ページ」は外側のページ、Referer はそのプレーヤーのページにする。
   */
  /**
   * 「動画を再生」のリンクの行き先を見る（1 ページ 40 件まで、同時に 8 件）。
   * 動画ファイルへ転送されれば、それを 1 件にする。そうでなければ、投稿の番号で X の窓口に聞く
   */
  const playLinkMedia = async (refs: (TweetRef & { url: string })[], pageUrl: string): Promise<MediaItem[]> => {
    const out: MediaItem[] = [];
    const fallback: TweetRef[] = [];
    let next = 0;
    const worker = async () => {
      while (next < refs.length && Date.now() < deadline && !signal.aborted) {
        const ref = refs[next++];
        try {
          const { res, url: target } = await safeFetch(ref.url, {
            signal,
            jar,
            timeoutMs: 8000,
            // 行き先の動画サーバー（X など）は、ほかのサイトを Referer に名乗ると断る。サイトのリンクも
            // 「Referer を送らない」指定なので、名乗らずに開く
            headers: { ...PAGE_HEADERS, range: "bytes=0-0" },
          });
          await res.body?.cancel().catch(() => {});
          const type = res.headers.get("content-type");
          if ((res.ok || res.status === 206) && (kindFromContentType(type) === "video" || (isVagueType(type) && kindFromUrl(target) === "video"))) {
            seenTweets.add(ref.id);
            out.push({
              id: target,
              kind: "video",
              src: target,
              pageUrl,
              referer: /twimg\.com/.test(target) ? "https://x.com/" : undefined,
              thumb: ref.thumb,
              duration: ref.duration,
              format: /twimg\.com/.test(target) ? "X" : formatOf(target, "video"),
              unverified: true,
            });
            continue;
          }
        } catch {
          /* 行き先を見られなければ、X に聞く */
        }
        fallback.push(ref);
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, refs.length) }, worker));
    if (fallback.length) out.push(...(await tweetMedia(fallback)));
    return out;
  };
  /** X の投稿の動画を問い合わせた投稿（同じ投稿を何度も聞かない） */
  const seenTweets = new Set<string>();
  /**
   * X の窓口の返事の数え。答えが 1 度も返らないまま失敗が続いたら（このアプリのサーバーが断られている）、
   * この実行ではもう聞かない（1 件ごとに時間切れを待つと、それだけで実行時間を使い切るため）
   */
  let xOk = 0;
  let xFail = 0;
  const xBroken = () => xOk === 0 && xFail >= 8;
  const getJson = async (target: string, sig: AbortSignal): Promise<Record<string, unknown> | null> => {
    if (xBroken()) return null;
    try {
      const { res } = await safeFetch(target, { signal: sig, timeoutMs: 6000, headers: { accept: "application/json" } });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        // 404 は「その投稿がない」だけ。断られた・不調のときだけ数える
        if (res.status !== 404) xFail++;
        return null;
      }
      const data = JSON.parse(await readLimited(res, 2 * 1024 * 1024));
      xOk++;
      return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
    } catch (err) {
      xFail++;
      throw err;
    }
  };
  /**
   * X の投稿の番号から動画を取り出す（1 ページあたり 80 件まで、同時に 8 件ずつ）。
   * 元ページは X の投稿（「元ページ」で投稿を開ける）。一覧のカードのサムネイル・再生時間は、もらえなかったときの代わり
   */
  /** 見つけた Gofile の共有フォルダを、読む列に入れる（1 ページに何十個あっても、全部読めるように） */
  const queueGofile = (ids: string[], from?: string) => {
    for (const id of ids) {
      if (seenGofile.has(id)) continue;
      enqueue(`https://gofile.io/d/${id}`, 0, lastRank + 1, 5, undefined, 0, false, from);
    }
  };
  const tweetMedia = async (refs: TweetRef[]): Promise<MediaItem[]> => {
    if (xBroken()) return [];
    const todo = refs.filter((t) => !seenTweets.has(t.id)).slice(0, 80);
    for (const t of todo) seenTweets.add(t.id);
    const out: MediaItem[] = [];
    let next = 0;
    const worker = async () => {
      while (next < todo.length && Date.now() < deadline && !signal.aborted) {
        const ref = todo[next++];
        const videos = await tweetVideos(ref.id, signal, getJson).catch(() => []);
        // 投稿の文に Gofile のリンクがあれば、そのフォルダも読む（Gofile を紹介している投稿）
        queueGofile(tweetGofileIds(ref.id), `https://x.com/i/status/${ref.id}`);
        for (const share of tweetShareUrls(ref.id)) enqueue(share, 0, lastRank + 1, 5, undefined, 0, false, `https://x.com/i/status/${ref.id}`);
        for (const v of videos) {
          out.push({
            id: v.src,
            kind: "video",
            src: v.src,
            pageUrl: v.tweetUrl,
            referer: "https://x.com/",
            thumb: v.thumb ?? ref.thumb,
            duration: v.duration ?? (videos.length === 1 ? ref.duration : undefined),
            title: v.title,
            format: "X",
          });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, todo.length) }, worker));
    return out;
  };

  /** 中身を聞いた Gofile のフォルダ */
  const seenGofile = new Set<string>();
  /** Gofile のフォルダの中身を、画像・動画の一覧にする（1 ページあたり 10 フォルダまで） */
  /** Gofile をブラウザで開いても読めなかった（この実行では、もうブラウザでは開かない。時間がかかるだけなので） */
  let gofileBrowserFailed = false;
  const gofileMedia = async (ids: string[], allowBrowser = true): Promise<{ media: MediaItem[]; error?: string; detail?: string }> => {
    const todo = ids.filter((id) => !seenGofile.has(id)).slice(0, 10);
    const media: MediaItem[] = [];
    let error: string | undefined;
    let detail: string | undefined;
    for (const id of todo) {
      if (Date.now() > deadline || signal.aborted) break;
      seenGofile.add(id);
      // ブラウザで開くのは時間がかかる（1 回 20〜40 秒）ので、区切りの時刻まで余裕があるときだけ
      const browserOk = allowBrowser && !gofileBrowserFailed && options.render !== "off" && Date.now() < deadline - 5000;
      const r: GofileResult = await gofileFiles(id, signal, options.gofileToken, browserOk).catch(() => ({ files: [], error: "Gofile に接続できませんでした" }));
      error ??= r.error;
      detail ??= r.detail;
      if (r.error && browserOk && /ブラウザ/.test(r.detail ?? "")) gofileBrowserFailed = true;
      for (const f of r.files) {
        media.push({
          id: f.src,
          kind: f.kind,
          src: f.src,
          pageUrl: f.pageUrl,
          referer: "https://gofile.io/",
          thumb: f.thumb,
          title: f.name,
          format: "Gofile",
          cookie: f.cookie,
        });
      }
    }
    return { media, error, detail };
  };

  const readFrames = async (frameUrls: string[], topPage: string, parent: string, level: number): Promise<{ media: MediaItem[]; playerHint: boolean }> => {
    const media: MediaItem[] = [];
    let playerHint = false;
    const targets = frameUrls.filter((u) => !isExcluded(u, options.exclude) && !AD_FRAME_RE.test(u) && !isAdUrl(u)).slice(0, MAX_FRAMES_PER_PAGE);
    await Promise.all(
      targets.map(async (frameUrl) => {
        if (Date.now() > deadline || signal.aborted) return;
        try {
          if (!(await allowed(frameUrl))) return;
          const { res, url: frameFinal } = await safeFetch(frameUrl, {
            signal,
            jar,
            timeoutMs: 10000,
            headers: { ...PAGE_HEADERS, "sec-fetch-dest": "iframe", "sec-fetch-site": "cross-site", referer: parent },
          });
          if (!res.ok || !/html/i.test(res.headers.get("content-type") ?? "")) {
            await res.body?.cancel().catch(() => {});
            // プレーヤーらしい iframe が読めなかったら、ブラウザで開いて確かめる目安にする
            if (!res.ok) playerHint = true;
            return;
          }
          const ex = extractFromHtml(await readLimited(res, MAX_FRAME_BYTES), frameFinal);
          playerHint ||= ex.playerHint;
          let found: MediaItem[] = ex.media
            .filter((m) => m.kind !== "image")
            .map((m) => ({ ...m, pageUrl: topPage, referer: m.referer ?? frameFinal }));
          fillThumbs(found, undefined, ex.ogImage);
          const inner = ex.redirect && !found.length ? [ex.redirect, ...ex.frames] : ex.frames;
          if (found.length === 0 && level < MAX_FRAME_LEVEL && inner.length) {
            const nested = await readFrames(inner, topPage, frameFinal, level + 1);
            found = nested.media;
            playerHint ||= nested.playerHint;
          }
          media.push(...found);
        } catch {
          /* 読めない iframe は飛ばす */
        }
      }),
    );
    return { media, playerHint };
  };

  const visit = async (item: QueueItem): Promise<CrawlEvent[]> => {
    const { url, depth } = item;
    const rank = item.rank ?? depth;
    const zone = options.crossSite ? 0 : (item.zone ?? 0);
    const events: CrawlEvent[] = [];
    /**
     * 読めなかった・動画を取り出せなかったページでも、一覧のカードにサムネイルがあったなら、サムネイルだけでも並べる
     * （タップでそのページを開く）。動画を探しているときだけ
     */
    const thumbOnly = (open: string = url, label?: string) => {
      if (!wantsVideo || !item.thumb || item.root || events.some((e) => e.type === "gated")) return;
      if (options.gofileOnly && !label) return;
      const video = gifVideoFromThumb(item.thumb) || item.preview;
      const title = label ? (item.title ? `${item.title}（${label}）` : label) : item.title;
      events.push({ type: "gated", url: open, thumb: item.thumb, title, duration: item.duration, video: video || undefined });
      thumbOnlyPages++;
    };
    const fail = (message: string) => {
      lastError = message;
      thumbOnly();
      events.push({ type: "error", url, message });
      return events;
    };
    /**
     * 確認を求められた・断られたページ。読めなかったことを伝え、画面に「サイトを開く」ボタンを出してもらう。
     * 動画のファイルがわかっているとき（GIF のサムネイル・一覧のプレビュー動画）は、その動画も渡す
     */
    const gated = (message: string) => {
      // 一覧の続きの窓口（twihub の /api/v1/posts）は、開いても見るものがないので「サイトで開く」に並べない
      if (options.gofileOnly || (options.hunt && !item.thumb)) return fail(message);
      if (isTwihubListApi(url) || isTwihubList(url)) return fail("一覧の続きは、サイトが「人間かどうかの確認」を求めたので読めませんでした");
      const video = (item.thumb && gifVideoFromThumb(item.thumb)) || item.preview;
      events.push({ type: "gated", url, thumb: item.thumb, title: item.title, duration: item.duration, video: video || undefined });
      gatedPages++;
      gatedStreak.set(gateKey(url), (gatedStreak.get(gateKey(url)) ?? 0) + 1);
      return fail(message);
    };
    /**
     * リンク先がそのまま画像・動画ファイルだったとき、それ自体を 1 件にする。
     * ほかのものと同じく、確かめて中身の指紋を取り、同じファイルをもう出していれば出さない
     */
    const emitDirect = async (direct: MediaItem): Promise<CrawlEvent[]> => {
      const finalUrl = direct.src;
      if (seenMedia.has(direct)) {
        events.push({ type: "page", url: finalUrl, depth, found: 0 });
        return events;
      }
      seenMedia.add(direct);
      const verified = await verifyMedia([direct], signal, Math.min(deadline, Date.now() + 12000), jar);
      pending.push(...verified.rest);
      const ok = dropSamePrint(await settle(verified));
      found += ok.length;
      videos += ok.filter((m) => m.kind !== "image").length;
      events.push({ type: "page", url: finalUrl, depth, found: ok.length });
      if (ok.length) events.push({ type: "media", items: ok });
      return events;
    };
    if (isExcluded(url, options.exclude)) {
      events.push({ type: "skip", url, reason: "除外リストのサイトです" });
      return events;
    }
    // 前の回で、時間切れまでに読み終わらなかったページ。2 回目は飛ばし、1 回目は時間のかかる処理をせずに読む
    const stuckCount = stuck.get(normalizePageUrl(url)) ?? 0;
    if (stuckCount >= 2) {
      lastError = "読むのに時間がかかりすぎるページがあり、飛ばしました";
      thumbOnly();
      events.push({ type: "error", url, message: "読むのに時間がかかりすぎるため飛ばしました" });
      return events;
    }
    const lite = stuckCount === 1;
    // 同じサイトの同じ種類のページ（/posts/… など）が続けて確認を求められている。読みに行っても同じなので、
    // 読まずに「サイトで開く」に並べる（サイトに何度も読みに行かないように）
    if (!item.root && (gatedStreak.get(gateKey(url)) ?? 0) >= GATED_STREAK) return gated("サイトが「人間かどうかの確認」を求めているため、このページは読めません");
    // 入力したページ自体は、人がブラウザで開くのと同じなので常に読む。リンクを辿る先は robots.txt を守る
    if (!item.root && !(await allowed(url))) {
      robotsSkipped++;
      thumbOnly();
      events.push({ type: "skip", url, reason: "robots.txt で禁止されています" });
      return events;
    }
    // Linkex（共有リンク・まとめサイト linkex-douga）：Linkex は Web では動画を再生させない仕組みなので、
    // 動画ファイルは取らずに、サムネイル・長さ・名前を「Linkex で開く」に並べる
    const lx = wantsVideo ? linkexPlan(url) : null;
    // 別のサイト（gofile-douga など）からのリンクで辿り着いた Linkex は読まない。
    // 姉妹サイトへのリンクを辿って、入力したサイトと関係のない Linkex の動画が並んでしまうため
    if (lx && !item.root && !home.sites.some((s) => LINKEX_SITE_RE.test(s))) {
      events.push({ type: "skip", url, reason: "入力したサイトとは別のサービス（Linkex）なので読みません" });
      return events;
    }
    if (lx) {
      try {
        const list = lx.kind === "list" ? await linkexList(lx.api, signal) : { tokens: [lx.token], next: null };
        let shown = 0;
        let next = 0;
        const worker = async () => {
          while (next < list.tokens.length && Date.now() < deadline && !signal.aborted) {
            const token = list.tokens[next++];
            if (seenLinkex.has(token)) continue;
            seenLinkex.add(token);
            for (const f of await linkexFiles(token, signal).catch(() => [])) {
              events.push({ type: "gated", url: f.url, thumb: f.thumb, duration: f.duration, title: f.name, app: "Linkex" });
              shown++;
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(4, list.tokens.length) }, worker));
        appOnly += shown;
        events.push({ type: "page", url, depth, found: 0 });
        if (list.next && paginationUsed < options.maxPagination && enqueue(list.next, depth, rank + 1, 1)) paginationUsed++;
        if (!shown && item.root) events.push({ type: "note", url, message: "Linkex の共有リンクに動画が見つかりませんでした（削除・期限切れの可能性があります）" });
      } catch (err) {
        return fail(`Linkex の一覧を読めませんでした（${err instanceof Error ? err.message.slice(0, 60) : String(err)}）`);
      }
      return events;
    }
    // ファイル保存サービスの共有リンクそのものなら、ページを開かずファイルの直リンクを 1 件にする
    // Gofile の共有フォルダそのものなら、ページを開かず API で中身をもらう
    // Gofile のまとめサイト gofile-douga：サイト自身の窓口から、Gofile の共有フォルダ・サムネイル・題名をもらう
    // （画面を後から描くサイトなので、ふつうに読むと 1 ページごとにブラウザで開くことになり、とても遅い）
    const gd = gofileDougaApi(url);
    if (gd) {
      try {
        const list = await gofileDougaList(gd, signal);
        for (const it of list.items) {
          if (!enqueue(it.share, depth, rank + 1, 4, it.thumb, 0, false, it.page)) continue;
          const q = queuedByUrl.get(it.share);
          if (q && it.title) q.title = it.title;
        }
        events.push({ type: "page", url, depth, found: 0 });
        if (list.next && paginationUsed < options.maxPagination && enqueue(list.next, depth, rank + 2, 1)) paginationUsed++;
        if (!list.items.length && item.root) events.push({ type: "note", url, message: "gofile-douga の一覧に Gofile のリンクが見つかりませんでした" });
      } catch (err) {
        return fail(`gofile-douga の一覧を読めませんでした（${err instanceof Error ? err.message.slice(0, 60) : String(err)}）`);
      }
      return events;
    }
    const share = gofileId(url);
    if (share) {
      // 区切りの時刻が近いときは、聞かずに次の回へ回す（聞けなかったのを「消されていた」と取り違えないように）
      if (Date.now() > deadline - 3000) {
        deferred.push(item);
        return events;
      }
      seenGofile.delete(share);
      const g = await gofileMedia([share]);
      const items = g.media
        .filter((m) => (options.kinds === "video" ? m.kind !== "image" : options.kinds === "image" ? m.kind === "image" : true))
        .filter((m) => !seenMedia.has(m));
      for (const m of items) seenMedia.add(m);
      const verified = await verifyMedia(items, signal, Math.min(deadline, Date.now() + 15000), jar);
      pending.push(...verified.rest);
      const ok = dropSamePrint(await settle(verified));
      found += ok.length;
      videos += ok.filter((m) => m.kind !== "image").length;
      events.push({ type: "page", url, depth, found: ok.length });
      if (ok.length) events.push({ type: "media", items: ok });
      // まとめサイトのカードから来た Gofile のフォルダが、消されていた・空だった：サムネイルだけ並べる（タップでまとめサイトのページ）
      if (!ok.length && !verified.rest.length && !g.media.length && /見つかりません|ありませんでした/.test(g.error ?? "")) {
        goneGofile++;
        thumbOnly(item.from ?? url, /見つかりません/.test(g.error ?? "") ? "Gofile で削除済み" : "Gofile に中身なし");
      }
      if (!ok.length && !verified.rest.length && item.root) {
        noted = true;
        events.push({
          type: "note",
          url,
          message:
            (g.error ?? "") && g.detail
              ? `${g.error}\n［診断］${g.detail}`
              : g.error ?? (g.media.length ? "Gofile のファイルは見つかりましたが、読めませんでした（有料会員限定・期限切れの可能性があります）" : "この Gofile フォルダに画像・動画はありませんでした"),
        });
      }
      return events;
    }
    // X の投稿そのものなら、ページを開かず投稿の動画を出す。
    // X 以外のサイトでも、URL に投稿の番号が入っていれば（動画保存・ランキング系サイトの /v/番号 など）、
    // サイトのページは開かず、番号から動画を直接もらう（サイトが自動アクセスを断っても影響を受けない）。
    // 番号が外れで動画が出なかったときは、そのまま普通にページを読む
    const tweet = wantsVideo ? tweetIdOf(url) : null;
    const embedded = wantsVideo && !tweet ? tweetIdInUrl(url) : null;
    const tweetId = tweet ?? embedded;
    if (tweetId) {
      seenTweets.delete(tweetId);
      // X 以外のサイトのリンクは、まず行き先を見る（動画ファイルへ転送されることが多い）。駄目なら X に聞く
      const ref = { id: tweetId, thumb: item.thumb, duration: item.duration };
      const got = embedded ? await playLinkMedia([{ ...ref, url }], item.from ?? url) : await tweetMedia([ref]);
      // Gofile 探しでは、投稿の動画は出さない（投稿の文にある Gofile のリンクだけを読む）
      const items = got.filter((m) => !seenMedia.has(m) && !options.gofileOnly);
      if (tweet || items.length) {
        for (const m of items) seenMedia.add(m);
        const verified = await verifyMedia(items, signal, Math.min(deadline, Date.now() + 12000), jar);
        pending.push(...verified.rest);
        const ok = dropSamePrint(await settle(verified));
        found += ok.length;
        videos += ok.length;
        events.push({ type: "page", url, depth, found: ok.length });
        if (ok.length) events.push({ type: "media", items: ok });
        else if (item.root && !tweetGofileIds(tweetId).length) {
          noted = true;
          events.push({ type: "note", url, message: "この投稿から動画を取り出せませんでした（動画のない投稿・削除・非公開・鍵アカウントの可能性があります）" });
        }
        return events;
      }
    }
    // pixeldrain のリスト（アルバム）：公開の窓口から中のファイルをもらう
    const pd = pixeldrainListId(url);
    if (pd) {
      const files = await pixeldrainList(pd, signal).catch(() => []);
      const items = files
        .map((f): MediaItem => ({ id: f.src, kind: f.kind, src: f.src, pageUrl: url, thumb: f.kind === "video" ? f.thumb : undefined, title: f.name || undefined, format: "pixeldrain" }))
        .filter((m) => (options.kinds === "video" ? m.kind !== "image" : options.kinds === "image" ? m.kind === "image" : true))
        .filter((m) => !seenMedia.has(m));
      for (const m of items) seenMedia.add(m);
      const verified = await verifyMedia(items, signal, Math.min(deadline, Date.now() + 15000), jar);
      pending.push(...verified.rest);
      const ok = dropSamePrint(await settle(verified));
      found += ok.length;
      videos += ok.filter((m) => m.kind !== "image").length;
      events.push({ type: "page", url, depth, found: ok.length });
      if (ok.length) events.push({ type: "media", items: ok });
      else if (item.root && !verified.rest.length) events.push({ type: "note", url, message: "この pixeldrain のリストに画像・動画はありませんでした（削除された可能性があります）" });
      return events;
    }
    const hosted = wantsVideo ? hostedFile(url) : null;
    if (hosted) {
      return emitDirect({
        id: hosted.src,
        kind: "video",
        src: hosted.src,
        pageUrl: url,
        referer: item.from,
        thumb: hosted.thumb ?? item.thumb,
        duration: item.duration,
        format: hosted.service,
      });
    }
    try {
      let html = "";
      // フォルダの共有リンクは、中のファイルの一覧が HTML で読めるページに読み替える
      const fetchUrl = folderListPage(url) ?? url;
      let finalUrl = fetchUrl;
      /** ブラウザで開いた結果（開いていなければ null） */
      let r: Rendered | null = null;
      let renderError: string | null = null;
      /** 普通の読み込みが断られた理由 */
      let blocked: string | null = null;
      /** 断られたのではなく、そもそもつながらなかった（アドレス違い・サイトが落ちているなど） */
      let unreachable = false;
      const pageOrigin = new URL(url).origin;

      if (browserOnly.has(pageOrigin)) blocked = "自動アクセスを断るサイト";
      else {
        try {
          const { res, url: fetched } = await safeFetch(fetchUrl, { signal, jar, headers: PAGE_HEADERS });
          finalUrl = fetched;
          // リダイレクトで除外リストのサイトに飛ばされた場合も読まない
          if (finalUrl !== url && isExcluded(finalUrl, options.exclude)) {
            await res.body?.cancel();
            events.push({ type: "skip", url, reason: "除外リストのサイトです" });
            return events;
          }
          if (!res.ok) {
            await res.body?.cancel();
            if (!BLOCKED_STATUS.has(res.status) && res.status < 500) return fail(`HTTP ${res.status}`);
            blocked = `HTTP ${res.status}`;
          } else {
            const type = res.headers.get("content-type");
            // 入力がメディアの直 URL だった場合は、それ自体を 1 件として返す
            const directKind = kindFromContentType(type) ?? (type?.includes("html") ? null : kindFromUrl(finalUrl));
            if (directKind) {
              await res.body?.cancel();
              if ((directKind === "image" && (zone > 0 || options.kinds === "video")) || (directKind === "video" && !wantsVideo)) {
                events.push({ type: "page", url: finalUrl, depth, found: 0 });
                return events;
              }
              const direct: MediaItem = {
                id: finalUrl,
                kind: directKind,
                src: finalUrl,
                pageUrl: item.from ?? finalUrl,
                referer: item.from,
                thumb: directKind === "video" ? item.thumb : undefined,
                format: (type?.split("/")[1]?.split(";")[0] ?? "").toUpperCase().replace("JPEG", "JPG") || undefined,
              };
              return emitDirect(direct);
            }
            if (type && !/html|xml|text\/plain/i.test(type) && !(isTwihubListApi(finalUrl) && /json/i.test(type))) {
              // ページでも、画像・動画と名乗ってもいない（「ダウンロード用」など）。先頭の中身が動画・画像なら、それ自体を 1 件にする
              const mime = mediaMime(await readHead(res, 512));
              const sniffed = mime?.startsWith("image/") ? "image" : mime ? "video" : null;
              if (!sniffed || (sniffed === "image" && (zone > 0 || options.kinds === "video")) || (sniffed === "video" && !wantsVideo)) {
                events.push({ type: "skip", url, reason: `ページではありません（${type.split(";")[0]}）` });
                return events;
              }
              const direct: MediaItem = {
                id: finalUrl,
                kind: sniffed,
                src: finalUrl,
                pageUrl: item.from ?? finalUrl,
                referer: item.from,
                thumb: sniffed === "video" ? item.thumb : undefined,
                format: mime!.split("/")[1].replace(/^x-/, "").replace("quicktime", "MOV").replace("jpeg", "JPG").toUpperCase(),
              };
              return emitDirect(direct);
            }
            html = await readLimited(res, MAX_HTML_BYTES);
          }
        } catch (err) {
          if (signal.aborted || err instanceof FetchBlockedError) throw err;
          // 接続を切られた・時間切れなど。入力したページなら、ブラウザで開き直してみる
          if (!item.root) throw err;
          blocked = describeFailure(err);
          unreachable = true;
        }
      }

      /** ブラウザで開いたままのページの中から読んだ（速い方法。ページの表示はしていない） */
      let sessionRead = false;
      if (blocked && !unreachable && options.render !== "off") {
        // 普通の読み込みを断られた（Cloudflare の「人間か確かめる」ページなど）。
        // まず、ブラウザで 1 ページ開いたままにして、その中から読む（1 枚ずつ表示し直すより、ずっと速い）
        const got = await fetchInBrowser(finalUrl, signal);
        if (got && got.status >= 400 && browserOnly.has(pageOrigin)) {
          // このサイトのほかのページは読めているのに、このページだけ確認がかかっている。
          // 1 枚ずつ表示し直しても通らない（20 秒以上かかる）ので、このページは飛ばす
          return gated("サイトが「人間かどうかの確認」を求めているため、このページは読めません");
        }
        if (got && got.status < 400 && got.html.length > 200) {
          html = got.html;
          finalUrl = got.finalUrl;
          sessionRead = true;
          blocked = null;
          // このサイトは、次からは普通の読み込みを試さずに、この方法で読む
          browserOnly.add(pageOrigin);
        }
      }
      if (blocked) {
        // 普通の読み込みを断られたので、本物のブラウザで開き直す（ブラウザなら通すサイトが多い）
        const known = browserOnly.has(pageOrigin) || browserPassed.has(pageOrigin);
        if (options.render === "off" || lite || (!item.root && !known && blockedTries >= MAX_BLOCKED_TRIES)) {
          return unreachable ? fail(`サイトを開けませんでした（${blocked}）`) : gated(`サイトが自動アクセスを断っています（${blocked}）`);
        }
        try {
          r = await openInBrowser(finalUrl);
        } catch (err) {
          if (signal.aborted) return events;
          if (err instanceof RenderDeferred) {
            deferred.push(item);
            return events;
          }
          if (!known) blockedTries++;
          return unreachable ? fail(`サイトを開けませんでした（${blocked}）`) : gated(`サイトが自動アクセスを断っています（${blocked}。ブラウザでも開けませんでした）`);
        }
        if (r.status >= 400) {
          if (!known) blockedTries++;
          return gated(`サイトが自動アクセスを断っています（HTTP ${r.status}。ブラウザで開いても同じでした）`);
        }
        // 一度通れたら、次のページはもらった Cookie で普通に読んでみる。それでも断られるサイトは、以降ずっとブラウザで開く
        if (browserPassed.has(pageOrigin)) browserOnly.add(pageOrigin);
        else browserPassed.add(pageOrigin);
        html = r.html;
        finalUrl = r.finalUrl;
      }

      // twihub の一覧の続き（JSON）は、投稿ページへのリンクとさらに続きの URL にする
      const listJson = isTwihubListApi(finalUrl) ? twihubFromJson(html, finalUrl) : null;
      const extracted = extractFromHtml(listJson ? "" : html, finalUrl);
      if (listJson) {
        for (const it of listJson.items) extracted.links.push({ url: it.url, thumb: it.thumb, duration: it.duration, prio: 4 });
        if (listJson.next) extracted.pagination.push(listJson.next);
      } else {
        extracted.pagination.push(...twihubNextFromHtml(html, finalUrl));
      }
      const media: MediaItem[] = [...extracted.media];
      const links: LinkCandidate[] = [...extracted.links];
      const pagination = new Set(extracted.pagination);
      let ogImage = extracted.ogImage;

      // iframe の中の動画プレーヤー（動画を探すときだけ。ブラウザで開いたときは、ブラウザが開いた中身を後で使う）
      // X の投稿へのリンク（保存・ランキング系のサイト）は、投稿の番号から動画を直接もらう
      if (wantsVideo && extracted.tweets.length) media.push(...(await tweetMedia(extracted.tweets)));
      // 「動画を再生」のリンク（twihub の /r/v/番号 など）：行き先が動画ファイルならそれを使い、駄目なら投稿の番号で X に聞く
      if (wantsVideo && extracted.playLinks.length) media.push(...(await playLinkMedia(extracted.playLinks, finalUrl)));
      // Gofile の共有フォルダへのリンクは、API で中身をもらう
      if (extracted.gofile.length) {
        media.push(...(await gofileMedia(extracted.gofile, !lite)).media);
        // 1 ページで聞くのは 10 フォルダまで。残りは列に入れて、順に読む
        queueGofile(extracted.gofile, finalUrl);
      }
      let frameHint = false;
      if (wantsVideo && extracted.frames.length && !r) {
        const fr = await readFrames(extracted.frames, finalUrl, finalUrl, 1);
        media.push(...fr.media);
        frameHint = fr.playerHint;
      }

      // ブラウザで開き直すか
      // - JavaScript で描くページで、画像やリンクがほとんど取れなかったとき
      // - 動画プレーヤーがありそうなのに、確かな動画が 1 本も見つからないとき（再生ボタンを押して探す）
      // - 入力したページから何も取れなかったとき・年齢確認などの入口ページのとき（「はい」を押して先へ進む）
      const trustedVideos = media.filter((m) => m.kind !== "image" && !m.unverified).length;
      const poor = extracted.media.length <= 2 || extracted.links.length < 3;
      const entrance =
        !!item.root && trustedVideos === 0 && (extracted.links.length < 3 || (extracted.gate && extracted.links.length < 15));
      // 動画が 1 本も見つからないが、動画のページらしい（入力したページ・動画らしいリンクから来た・URL や部品の名前に video / player）。
      // スクリプトで後から動画を出すプレーヤーかもしれないので、ブラウザで開いて再生ボタンを押してみる
      const anyVideo = media.some((m) => m.kind !== "image");
      const guess = guessRenders.get(pageOrigin) ?? { tries: 0, hits: 0 };
      const looksLikeVideoPage =
        !!item.root || (item.prio ?? 0) >= 2 || VIDEO_URL_RE.test(finalUrl) || PLAYERISH_RE.test(html.slice(0, 400000));
      // 動画の置き場所がわかっているページ（Gofile・X の投稿・再生リンク）は、開き直しても増えないので対象外。
      // ブラウザの中から読んだページも対象外（1 枚 30 秒かかるので、速く読める利点がなくなる）
      const elsewhere = extracted.gofile.length > 0 || extracted.tweets.length > 0 || extracted.playLinks.length > 0;
      const guessRender =
        wantsVideo && !options.gofileOnly && !anyVideo && !elsewhere && !sessionRead && looksLikeVideoPage && (guess.hits > 0 || guess.tries < MAX_GUESS_RENDERS);
      const wantRender =
        !r &&
        !lite &&
        (options.render === "always" ||
          (options.render === "auto" &&
            ((extracted.clientRendered && poor && !elsewhere) ||
              (wantsVideo && (extracted.playerHint || frameHint) && trustedVideos === 0 && !elsewhere && (!sessionRead || !!item.root)) ||
              (entrance && !extracted.redirect) ||
              guessRender)));
      if (wantRender && guessRender) {
        guess.tries++;
        guessRenders.set(pageOrigin, guess);
      }
      if (wantRender) {
        try {
          r = await openInBrowser(finalUrl);
          const again = extractFromHtml(r.html, r.finalUrl);
          media.push(...again.media);
          links.push(...again.links);
          for (const p of again.pagination) pagination.add(p);
          ogImage ??= again.ogImage;
          if (wantsVideo) media.push(...(await tweetMedia([...again.tweets, ...r.tweets.map((id) => ({ id }))])));
          if (again.gofile.length) {
            media.push(...(await gofileMedia(again.gofile)).media);
            queueGofile(again.gofile, r.finalUrl);
          }
        } catch (err) {
          if (signal.aborted) return events;
          if (err instanceof RenderDeferred) {
            // 区切りまでに始められなかった。数えずに、続きの回で開き直す
            deferred.push(item);
            return events;
          }
          renderError = err instanceof Error ? err.message : String(err);
        }
      }
      if (r) {
        // ブラウザの中で開いていた iframe の中身
        for (const f of r.frames) {
          if (AD_FRAME_RE.test(f.url) || isAdUrl(f.url)) continue;
          const fx = extractFromHtml(f.html, f.url);
          if (wantsVideo && fx.tweets.length) media.push(...(await tweetMedia(fx.tweets)));
          const inFrame = fx.media
            .filter((m) => m.kind !== "image")
            .map((m) => ({ ...m, pageUrl: finalUrl, referer: m.referer ?? f.url }));
          fillThumbs(inFrame, undefined, fx.ogImage);
          media.push(...inFrame);
        }
        // 表示・再生の間にブラウザが受け取った画像・動画。
        // 配信形式（HLS）は「全体の目次 → 画質ごとの目次」の順に読まれるので、同じ配信元からは最初の 1 つだけ使う
        const hlsHosts = new Set<string>();
        for (const n of r.network) {
          if (extensionOf(n.url) === "m3u8") {
            const host = new URL(n.url).host;
            if (hlsHosts.has(host)) continue;
            hlsHosts.add(host);
          }
          media.push({ id: n.url, kind: n.kind, src: n.url, pageUrl: finalUrl, referer: n.referer, format: n.format ?? formatOf(n.url, n.kind) });
        }
      }

      if (r && guessRenders.has(pageOrigin) && media.some((m) => m.kind !== "image")) {
        // ブラウザで開いたら（再生した通信も含めて）動画が見つかった。このサイトは、これからも動画のないページをブラウザで開く
        guessRenders.get(pageOrigin)!.hits++;
      }
      // 入力したページが転送されていたら（www. 付き・スマホ用アドレス・年齢確認の先など）、そこを「同じサイト」の基準にする
      if (item.root) {
        const sites = new Set(home.sites);
        for (const u of [finalUrl, r?.finalUrl]) if (u) sites.add(siteOf(new URL(u).hostname));
        const base = new URL(finalUrl);
        home = { sites: [...sites], scope: scopeOf(base), path: base.pathname };
      }

      // 同じページ内の重複をまとめる（サムネイルなどの情報は補い合う）
      const merged = new Map<string, MediaItem>();
      for (const m of media) {
        const prev = merged.get(m.id);
        if (!prev) merged.set(m.id, { ...m });
        else {
          prev.thumb ??= m.thumb;
          prev.title ??= m.title;
          prev.referer ??= m.referer;
          prev.cookie ??= m.cookie;
          if (!m.unverified) prev.unverified = undefined;
          if (!m.guess) prev.guess = undefined;
        }
      }
      const pageMedia = [...merged.values()];
      // og:image が複数のページで同じなら、サイト共通のロゴ。最初のページ（一覧ページのことが多い）の og:image も使わない
      // （ロゴを付けるより、画面側で動画から本物のコマを取り出すほうがよい）
      if (ogImage) ogPages.set(ogImage, (ogPages.get(ogImage) ?? 0) + 1);
      const usableOg = ogImage && depth > 0 && (ogPages.get(ogImage) ?? 0) < 2 ? ogImage : undefined;
      // 題名：一覧のカードの題名 → なければ、動画の詳細ページ（動画が少ないページ）のページ名
      const pageName = depth > 0 || !links.some((l) => l.prio >= 2) ? extracted.title : undefined;
      fillThumbs(pageMedia, item.thumb, usableOg, item.duration, item.title);
      const pageVideos = pageMedia.filter((m) => m.kind !== "image");
      if (pageName && pageVideos.length <= 3) for (const v of pageVideos) v.title ??= pageName;

      // すでに出した動画（URL の後ろの合言葉だけ違うもの・別のページで出したもの）は除く
      // 画質・形式違いのどれか 1 つでも出していたら、残りの違いも出さない
      const seenVariants = new Set(pageMedia.filter((m) => seenMedia.has(m)).map(variantKey));
      const candidates = pageMedia.filter((m) => !seenMedia.has(m) && !seenVariants.has(variantKey(m) ?? ""));
      // 取得する種類の指定（動画のみ・画像のみ）。埋め込み動画は動画に含める。
      // 入力した階層の外のページは動画を探すために読んでいるので、画像は集めない
      // 一覧ページのカードのプレビュー動画は、その詳細ページを読むなら出さない（本編と同じ動画の短い版なので、
      // 両方出すと同じ動画が続けて並ぶ）。詳細ページに本編がなかったときだけ、詳細ページを読んだときに出す
      const followed = (url: string, prio: number) => {
        if (seenPages.has(normalizePageUrl(url))) return true;
        const z = options.crossSite ? 0 : zoneOf(url, home);
        return depth < options.depth && (z === 0 || (z === 1 && wantsVideo && prio >= 2));
      };
      const previewOf = new Set(links.filter((l) => l.preview && !pagination.has(l.url) && followed(l.url, l.prio)).map((l) => l.preview!));
      for (let i = candidates.length - 1; i >= 0; i--) {
        if (candidates[i].kind === "video" && previewOf.has(candidates[i].src)) candidates.splice(i, 1);
      }
      const videoOnly = options.kinds === "video" || zone > 0;
      const wanted = candidates
        .filter((m) => !isItemExcluded(m, options.exclude))
        // Gofile 探しでは、Gofile の中身だけを集める
        .filter((m) => !options.gofileOnly || isFileHostItem(m))
        .filter((m) => (videoOnly ? m.kind !== "image" : options.kinds === "image" ? m.kind === "image" : true));
      for (const m of candidates) seenMedia.add(m);
      // リンク切れかどうかを確かめてから画面へ送る。同じ動画の画質違いは、見られるものの中から選ぶ
      const sameBefore = samePrint;
      const verified = await verifyMedia(wanted, signal, Math.min(deadline, Date.now() + 12000), jar);
      const rest = verified.rest;
      if (rest.length) pending.push(...rest);
      let fresh = pickVariants(dropSamePrint(await settle(verified)));
      // このページが一覧のカードから来ていて、本編の動画が見つからなかったら、カードのプレビュー動画を代わりに出す
      if (item.preview && wantsVideo && !fresh.some((m) => m.kind !== "image") && !rest.some((m) => m.kind !== "image")) {
        const stand: MediaItem = {
          id: item.preview,
          kind: "video",
          src: item.preview,
          pageUrl: finalUrl,
          referer: item.from,
          thumb: item.thumb,
          format: formatOf(item.preview, "video"),
          title: item.title ?? "プレビュー",
        };
        if (!seenMedia.has(stand)) {
          seenMedia.add(stand);
          const v = await verifyMedia([stand], signal, Math.min(deadline, Date.now() + 8000), jar);
          fresh = [...fresh, ...dropSamePrint(await settle(v))];
        }
      }
      found += fresh.length;
      videos += fresh.filter((m) => m.kind !== "image").length;
      events.push({ type: "page", url: finalUrl, depth, found: fresh.length });
      gatedStreak.delete(gateKey(url));
      if (fresh.length) events.push({ type: "media", items: fresh });
      if (item.root) {
        const message = renderError
          ? `ブラウザで開けませんでした（${renderError.slice(0, 80)}）`
          : r && pageMedia.length <= 2 && links.length < 3 && !pageMedia.some((m) => m.kind !== "image")
            ? "ブラウザで開いても画像・動画が見つかりませんでした（ログインが必要なページかもしれません）"
            : !r && pageMedia.length <= 2 && extracted.clientRendered
              ? "このページは画像を JavaScript で後から読み込むため、取れない画像があります（「ブラウザで開く」を試してください）"
              : null;
        if (message) {
          noted = true;
          events.push({ type: "note", url: finalUrl, message });
        }
      }

      // 自動で別のページへ飛ばすだけのページ（<meta refresh>・location.href = …）は、行き先を同じ階層として読む。
      // ブラウザで開いたときは、ブラウザがもう移動している
      if (extracted.redirect && !r && poor) {
        const z = item.root || options.crossSite ? 0 : zoneOf(extracted.redirect, home);
        enqueue(extracted.redirect, depth, rank, 9, item.thumb, z, item.root);
      }

      // ページ送り（2ページ目・次へ）は同じ階層として辿る。読む順番は 1 段後ろ
      // → 「このページの詳細ページ」と「次の一覧ページ」が同じ段に並び、詳細ページが先に読まれる
      if (zone < 2) {
        for (const link of pagination) {
          if (paginationUsed >= options.maxPagination) break;
          // twihub のほかのランキングの一覧は、投稿ページより先に読む（投稿ページで「人間かどうかの確認」を
          // 何度か求められると、その後は一覧ページまで断られるようになるため）
          const first = isTwihubList(link);
          if (enqueue(link, depth, first ? rank : rank + 1, first ? 9 : 1, undefined, zone)) paginationUsed++;
        }
      }
      // 普通のリンクは 1 階層下として辿る（サムネイル付き・動画らしいリンクが先）
      // - 入力した階層の中：そのまま辿る
      // - 同じサイトの別の場所：動画を探していて、サムネイル付き・動画らしいリンクなら辿る（一覧 → 詳細ページ）
      // - それ以外（別のサイト・階層の上限より先）：取っておき、動画が見つからないときに広げる
      // このページで何か見つかったか・動画らしいリンクがあったかを、ページの「形」ごとに覚える
      const promising = links.filter((l) => l.prio >= 2 && !pagination.has(l.url)).length;
      // 動画が 1 本も取り出せなかったページ（一覧ページ・もう出した動画のページは除く）：カードのサムネイルだけでも並べる
      if (
        promising < LISTING_MIN_LINKS &&
        samePrint === sameBefore &&
        !fresh.some((m) => m.kind !== "image") &&
        !rest.some((m) => m.kind !== "image") &&
        !pageMedia.some((m) => m.kind !== "image" && !candidates.includes(m)) &&
        (options.kinds === "video" || zone > 0 || fresh.length === 0)
      )
        thumbOnly();
      if (!item.root) {
        const got = options.kinds === "video" || zone > 0 ? fresh.some((m) => m.kind !== "image") : fresh.length > 0;
        const shape = shapeOf(url);
        if (got) fruitful.add(shape);
        else if (!promising && barren.size < 500) barren.set(shape, (barren.get(shape) ?? 0) + 1);
      }
      // 動画の一覧ページ（動画らしいリンクが何本もある）なら、ふつうのリンク（メニュー・カテゴリ・タグなど）は後回しにする。
      // 動画が 1 本も見つからなかったときだけ、範囲を広げるときに使う
      // 動画が見つかったページ（動画の詳細ページ）も同じ。関連動画のリンクはふつうサムネイル付きなので、それだけを辿る
      const pageHasVideo = fresh.some((m) => m.kind !== "image");
      const listing = wantsVideo && (promising >= LISTING_MIN_LINKS || pageHasVideo);
      for (const link of links) {
        if (pagination.has(link.url)) continue;
        // Gofile 探し：検索結果のページからは、結果のサイトへのリンクだけを辿る（検索サイト自身のメニューは辿らない）。
        // 結果のサイトの中では、Gofile と書かれたリンク・サムネイル付きのリンクだけを辿る
        if (options.hunt) {
          let own = false;
          try {
            // （5ちゃんねるのスレッド検索は、結果のスレッドも同じサイトにあるので、スレッドは辿る）
            own = home.sites.includes(siteOf(new URL(link.url).hostname)) && !/\/read\.cgi\//.test(link.url);
          } catch {
            continue;
          }
          // （結果のサイトの中では、動画・Gofile らしいリンクだけ。アイコン付きの利用者ページ・通報・削除依頼などは辿らない）
          if (item.root ? own : link.prio !== 2 && link.prio < 4) continue;
          if (/\/(?:abuse|delete|report|user|users|login|signup)(?:\/|$)/i.test(link.url)) continue;
          // 道具・解析・辞書などのサイトは、Gofile の動画を紹介する場所ではないので辿らない。1 つのサイトに深入りもしない
          let site = "";
          try {
            site = siteOf(new URL(link.url).hostname);
          } catch {
            continue;
          }
          if (HUNT_SKIP_RE.test(site)) continue;
          const used = huntPerSite.get(site) ?? 0;
          if (used >= HUNT_PAGES_PER_SITE && !gofileId(link.url)) continue;
          if (!seenPages.has(normalizePageUrl(link.url))) huntPerSite.set(site, used + 1);
        }
        const z = options.crossSite ? 0 : zoneOf(link.url, home);
        const key = normalizePageUrl(link.url);
        // ふつうのリンクで、一覧・詳細ページにあった（またはメニューとして一度後回しにした）ものはメニューとみなす
        const nav = wantsVideo && link.prio < 2 && (listing || navLinks.has(key));
        if (nav && navLinks.size < 5000) navLinks.add(key);
        const within = depth < options.depth && !nav;
        if (within && (z === 0 || (z === 1 && wantsVideo && link.prio >= 2))) {
          enqueue(link.url, depth + 1, rank + 1, link.prio, link.thumb, z, false, finalUrl, link.preview);
          const q = link.duration || link.title ? queuedByUrl.get(link.url) : undefined;
          if (q) {
            q.duration ??= link.duration;
            q.title ??= link.title;
          }
        } else if ((autoWiden || nav) && depth < options.depth + WIDEN_EXTRA_DEPTH && (zone < 2 || link.prio >= 2)) {
          hold(link.url, depth + 1, link.prio, link.thumb, z, finalUrl);
          const r = link.duration || link.title ? reservedByKey.get(normalizePageUrl(link.url)) : undefined;
          if (r) {
            r.duration ??= link.duration;
            r.title ??= link.title;
          }
        }
      }
    } catch (err) {
      if (signal.aborted) return events;
      return fail(describeFailure(err));
    }
    return events;
  };

  // 段の小さい順・優先度の高い順に、最大 CONCURRENCY 件ずつ並列に読む
  while (!signal.aborted && pages < options.maxPages) {
    if (!queue.length) {
      // 読むページがなくなった。動画が見つかっていなければ、取っておいたリンクから範囲を広げる
      const first = widened === 0;
      if (!widen()) break;
      if (first) {
        noted = true;
        yield {
          type: "note",
          url: startUrl,
          message: "入力した範囲には動画が見つからなかったので、リンク先（同じサイトの別の場所・別のサイト）まで広げて探しています",
        };
      }
    }
    if (Date.now() > deadline) {
      // 時間切れ。続きを画面に預けて、もう一度呼んでもらう
      yield { type: "continue", state: snapshot() };
      return;
    }
    queue.sort(byOrder);
    // 何度読んでも何も見つからない形のページは、読むページ数を使わずに飛ばす
    for (let i = queue.length - 1; i >= 0; i--) {
      if (!isBarren(queue[i])) continue;
      const [q] = queue.splice(i, 1);
      queuedByUrl.delete(q.url);
      yield { type: "skip", url: q.url, reason: "同じ形のページを何度読んでも見つからなかったので飛ばしました" };
    }
    // 同じサイトの同じ種類のページが続けて「人間かどうかの確認」を求められているなら、残りは読まずに「サイトで開く」に並べる。
    // 読んでいないので、読むページ数の上限には数えない（一覧に 100 件あれば 100 件とも並ぶ）
    for (let i = 0; i < queue.length; ) {
      const q = queue[i];
      if (q.root || (gatedStreak.get(gateKey(q.url)) ?? 0) < GATED_STREAK || isExcluded(q.url, options.exclude)) {
        i++;
        continue;
      }
      queue.splice(i, 1);
      queuedByUrl.delete(q.url);
      if (options.gofileOnly || (options.hunt && !q.thumb)) continue;
      const video = (q.thumb && gifVideoFromThumb(q.thumb)) || q.preview;
      gatedPages++;
      yield { type: "gated", url: q.url, thumb: q.thumb, title: q.title, duration: q.duration, video: video || undefined };
    }
    if (!queue.length) continue;
    if (progress) progress.safe = snapshot();
    const batch = queue.splice(0, Math.min(CONCURRENCY, options.maxPages - pages));
    for (const b of batch) {
      queuedByUrl.delete(b.url);
      lastRank = Math.max(lastRank, b.rank ?? b.depth);
    }
    pages += batch.length;
    const results = await Promise.all(
      batch.map(async (p) => {
        progress?.inFlight.set(p.url, Date.now());
        try {
          return await visit(p);
        } finally {
          progress?.inFlight.delete(p.url);
        }
      }),
    );
    for (const events of results) {
      for (const e of events) {
        if (e.type === "media") mediaCount += e.items.length;
        yield e;
      }
    }
    // 確かめきれずに残っていた画像・動画を、少しずつ確かめて送る
    if (pending.length && Date.now() < deadline) {
      const verified = await verifyMedia(pending.splice(0, pending.length), signal, Math.min(deadline, Date.now() + 5000), jar);
      const ok = dropSamePrint(await settle(verified));
      pending.push(...verified.rest);
      if (ok.length) {
        found += ok.length;
        videos += ok.filter((m) => m.kind !== "image").length;
        mediaCount += ok.length;
        yield { type: "media", items: ok };
      }
    }
    // 数秒おきに途中経過を記録として送る（画面を閉じたり止めたりしても、ここから再開できる）
    if (Date.now() - lastCheckpoint > CHECKPOINT_MS && (queue.length || reserve.length || pending.length)) {
      lastCheckpoint = Date.now();
      yield { type: "checkpoint", state: snapshot() };
    }
    if (deferred.length) {
      // 次の回に回したページは、読んだ数から引いて列の先頭に戻す
      pages -= deferred.length;
      for (const d of deferred) queuedByUrl.set(d.url, d);
      queue.unshift(...deferred.splice(0));
      yield { type: "continue", state: snapshot() };
      return;
    }
  }

  // 確かめきれずに残っている画像・動画を確かめる（区切りの時刻を過ぎたら、続きの回へ持ち越す）
  while (pending.length && !signal.aborted) {
    if (Date.now() > deadline) {
      yield { type: "continue", state: snapshot() };
      return;
    }
    const batch = pending.splice(0, pending.length);
    const verified = await verifyMedia(batch, signal, deadline, jar);
    const ok = dropSamePrint(await settle(verified));
    pending.push(...verified.rest);
    if (ok.length) {
      found += ok.length;
      videos += ok.filter((m) => m.kind !== "image").length;
      mediaCount += ok.length;
      yield { type: "media", items: ok };
    }
  }

  // 取れなかったときは、わかる範囲で理由を伝える
  if (!signal.aborted) {
    const noVideos = wantsVideo && videos === 0;
    const xNote = xBroken() ? "X の窓口がこのアプリのサーバーに答えなかったため、X の投稿の動画を取れませんでした" : null;
    const droppedNote =
      refusedVideos + goneVideos > 0
        ? `動画を ${refusedVideos + goneVideos} 本見つけましたが、見られなかったので出していません（` +
          [refusedVideos ? `サイトがこのアプリのサーバーからの読み込みを断った ${refusedVideos} 本` : "", goneVideos ? `ファイルがない・中身が動画でない ${goneVideos} 本` : ""]
            .filter(Boolean)
            .join("・") +
          "）" +
          (refusedVideos ? "。日本からしか見られないサイトの可能性があります" : "")
        : null;
    const message =
      noVideos && droppedNote
        ? droppedNote
        : robotsSkipped && (found === 0 || noVideos)
        ? `robots.txt（サイトが出している「自動で読まないで」という指定）で禁止されているページが ${robotsSkipped} 件あり、読みませんでした。「robots.txt を守る」を外すと読めます`
        : found === 0
          ? lastError
            ? `ページを読めませんでした：${lastError}`
            : noted
              ? null
              : "画像・動画が見つかりませんでした（ログインが必要なサイトか、このアプリでは読めない方式かもしれません）"
          : noVideos && widened > 0
            ? "リンク先まで広げて探しましたが、動画は見つかりませんでした"
            : refusedVideos > 0
              ? droppedNote
              : null;
    const gatedNote = gatedPages
      ? `「人間かどうかの確認」を求められた・自動アクセスを断られたページが ${gatedPages} 件ありました。下の「サイトで開く」から、サイトを直接開いて見てください`
      : null;
    const appNote = appOnly
      ? `Linkex の動画 ${appOnly} 本を並べました。Linkex は Web では再生できない仕組み（アプリでのみ再生）のため、タップで Linkex を開きます`
      : null;
    const thumbNote = goneGofile
      ? `Gofile のリンクのうち ${goneGofile} 件は、Gofile で削除済み・中身なしでした（サムネイルがわかるものは、サムネイルだけ並べています。Gofile は消されるのが早いため、新しいリンクでも見られないことがあります）`
      : thumbOnlyPages
      ? `動画を取り出せなかったページ ${thumbOnlyPages} 件は、サムネイルだけ並べました。タップするとそのページを開きます`
      : null;
    const finalNote =
      appNote ?? (goneGofile ? thumbNote : null) ?? ((found === 0 || noVideos) && gatedNote ? gatedNote : (message ?? (noVideos ? xNote : null) ?? gatedNote)) ?? thumbNote;
    if (finalNote) yield { type: "note", url: startUrl, message: finalNote };
  }
  const truncated = queue.length > 0;
  yield {
    type: "done",
    pages,
    media: mediaCount,
    truncated,
    state: truncated ? snapshot() : undefined,
  };
}
