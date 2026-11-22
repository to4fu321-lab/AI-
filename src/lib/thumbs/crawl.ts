import "server-only";
import { AD_FRAME_RE, VIDEO_URL_RE, extensionOf, extractFromHtml, formatOf, type LinkCandidate, isPageLikeUrl, kindFromContentType, kindFromUrl } from "./extract";
import { mediaKey, SeenMedia, variantKey } from "./dedupe";
import { isExcluded, isItemExcluded } from "./exclude";
import { checkInBrowser, RenderDeferred, renderPage, type Rendered } from "./render";
import { checkMedia } from "./probe";
import { folderListPage, hostedFile } from "./filehost";
import { isAdUrl } from "./adblock";
import { tweetIdOf, tweetVideos } from "./twitter";
import type { TweetRef } from "./extract";
import { CookieJar, FetchBlockedError, safeFetch } from "./safeFetch";
import { mediaMime, readHead } from "./sniff";
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
function fillThumbs(media: MediaItem[], linkThumb: string | undefined, ogImage: string | undefined, linkDuration?: number) {
  const videos = media.filter((m) => m.kind !== "image");
  if (videos.length === 0) return;
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

export async function* crawl(
  startUrl: string,
  options: CrawlOptions,
  signal: AbortSignal,
  deadline: number,
  resume?: CrawlState,
): AsyncGenerator<CrawlEvent> {
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
  const dropSamePrint = (items: MediaItem[]) =>
    items.filter((m) => {
      if (!m.fp) return true;
      if (seenPrints.has(m.fp)) return false;
      seenPrints.add(m.fp);
      return true;
    });
  let lastRank = 0;

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
    pending: pending.slice(0, MAX_PENDING),
    prints: [...seenPrints].slice(-MAX_PRINTS),
    dropped: [goneVideos, refusedVideos],
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
  let lastError: string | null = null;
  let noted = false;

  const openInBrowser = async (target: string): Promise<Rendered> => {
    // 1 回の実行で最初のブラウザ表示は必ず行う（次の回へ回し続けて進まなくなるのを防ぐ）
    const startBy = renderStarts++ === 0 ? Number.POSITIVE_INFINITY : deadline;
    const r = await renderPage(target, signal, startBy, { play: wantsVideo });
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
  /** X の投稿の動画を問い合わせた投稿（同じ投稿を何度も聞かない） */
  const seenTweets = new Set<string>();
  const getJson = async (target: string, sig: AbortSignal): Promise<Record<string, unknown> | null> => {
    const { res } = await safeFetch(target, { signal: sig, timeoutMs: 8000, headers: { accept: "application/json" } });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const data = JSON.parse(await readLimited(res, 2 * 1024 * 1024));
    return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  };
  /**
   * X の投稿の番号から動画を取り出す（1 ページあたり 80 件まで、同時に 8 件ずつ）。
   * 元ページは X の投稿（「元ページ」で投稿を開ける）。一覧のカードのサムネイル・再生時間は、もらえなかったときの代わり
   */
  const tweetMedia = async (refs: TweetRef[]): Promise<MediaItem[]> => {
    const todo = refs.filter((t) => !seenTweets.has(t.id)).slice(0, 80);
    for (const t of todo) seenTweets.add(t.id);
    const out: MediaItem[] = [];
    let next = 0;
    const worker = async () => {
      while (next < todo.length && Date.now() < deadline && !signal.aborted) {
        const ref = todo[next++];
        const videos = await tweetVideos(ref.id, signal, getJson).catch(() => []);
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
    const fail = (message: string) => {
      lastError = message;
      events.push({ type: "error", url, message });
      return events;
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
    // 入力したページ自体は、人がブラウザで開くのと同じなので常に読む。リンクを辿る先は robots.txt を守る
    if (!item.root && !(await allowed(url))) {
      robotsSkipped++;
      events.push({ type: "skip", url, reason: "robots.txt で禁止されています" });
      return events;
    }
    // ファイル保存サービスの共有リンクそのものなら、ページを開かずファイルの直リンクを 1 件にする
    // X の投稿そのものなら、ページを開かず投稿の動画を出す
    const tweet = wantsVideo ? tweetIdOf(url) : null;
    if (tweet) {
      seenTweets.delete(tweet);
      const items = (await tweetMedia([{ id: tweet, thumb: item.thumb, duration: item.duration }])).filter((m) => !seenMedia.has(m));
      for (const m of items) seenMedia.add(m);
      const verified = await verifyMedia(items, signal, Math.min(deadline, Date.now() + 12000), jar);
      pending.push(...verified.rest);
      const ok = dropSamePrint(await settle(verified));
      found += ok.length;
      videos += ok.length;
      events.push({ type: "page", url, depth, found: ok.length });
      if (ok.length) events.push({ type: "media", items: ok });
      else if (item.root) {
        noted = true;
        events.push({ type: "note", url, message: "この投稿から動画を取り出せませんでした（動画のない投稿・削除・非公開・鍵アカウントの可能性があります）" });
      }
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
            if (type && !/html|xml|text\/plain/i.test(type)) {
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

      if (blocked) {
        // 普通の読み込みを断られたので、本物のブラウザで開き直す（ブラウザなら通すサイトが多い）
        const known = browserOnly.has(pageOrigin) || browserPassed.has(pageOrigin);
        if (options.render === "off" || (!item.root && !known && blockedTries >= MAX_BLOCKED_TRIES)) {
          return fail(`サイトが自動アクセスを断っています（${blocked}）`);
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
          return fail(unreachable ? `サイトを開けませんでした（${blocked}）` : `サイトが自動アクセスを断っています（${blocked}。ブラウザでも開けませんでした）`);
        }
        if (r.status >= 400) {
          if (!known) blockedTries++;
          return fail(`サイトが自動アクセスを断っています（HTTP ${r.status}。ブラウザで開いても同じでした）`);
        }
        // 一度通れたら、次のページはもらった Cookie で普通に読んでみる。それでも断られるサイトは、以降ずっとブラウザで開く
        if (browserPassed.has(pageOrigin)) browserOnly.add(pageOrigin);
        else browserPassed.add(pageOrigin);
        html = r.html;
        finalUrl = r.finalUrl;
      }

      const extracted = extractFromHtml(html, finalUrl);
      const media: MediaItem[] = [...extracted.media];
      const links: LinkCandidate[] = [...extracted.links];
      const pagination = new Set(extracted.pagination);
      let ogImage = extracted.ogImage;

      // iframe の中の動画プレーヤー（動画を探すときだけ。ブラウザで開いたときは、ブラウザが開いた中身を後で使う）
      // X の投稿へのリンク（保存・ランキング系のサイト）は、投稿の番号から動画を直接もらう
      if (wantsVideo && extracted.tweets.length) media.push(...(await tweetMedia(extracted.tweets)));
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
      const guessRender =
        wantsVideo && !anyVideo && looksLikeVideoPage && (guess.hits > 0 || guess.tries < MAX_GUESS_RENDERS);
      const wantRender =
        !r &&
        (options.render === "always" ||
          (options.render === "auto" &&
            ((extracted.clientRendered && poor) ||
              (wantsVideo && (extracted.playerHint || frameHint) && trustedVideos === 0) ||
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
          if (!m.unverified) prev.unverified = undefined;
          if (!m.guess) prev.guess = undefined;
        }
      }
      const pageMedia = [...merged.values()];
      // og:image が複数のページで同じなら、サイト共通のロゴ。最初のページ（一覧ページのことが多い）の og:image も使わない
      // （ロゴを付けるより、画面側で動画から本物のコマを取り出すほうがよい）
      if (ogImage) ogPages.set(ogImage, (ogPages.get(ogImage) ?? 0) + 1);
      const usableOg = ogImage && depth > 0 && (ogPages.get(ogImage) ?? 0) < 2 ? ogImage : undefined;
      fillThumbs(pageMedia, item.thumb, usableOg, item.duration);

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
        .filter((m) => (videoOnly ? m.kind !== "image" : options.kinds === "image" ? m.kind === "image" : true));
      for (const m of candidates) seenMedia.add(m);
      // リンク切れかどうかを確かめてから画面へ送る。同じ動画の画質違いは、見られるものの中から選ぶ
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
          title: "プレビュー",
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
          if (enqueue(link, depth, rank + 1, 1, undefined, zone)) paginationUsed++;
        }
      }
      // 普通のリンクは 1 階層下として辿る（サムネイル付き・動画らしいリンクが先）
      // - 入力した階層の中：そのまま辿る
      // - 同じサイトの別の場所：動画を探していて、サムネイル付き・動画らしいリンクなら辿る（一覧 → 詳細ページ）
      // - それ以外（別のサイト・階層の上限より先）：取っておき、動画が見つからないときに広げる
      for (const link of links) {
        if (pagination.has(link.url)) continue;
        const z = options.crossSite ? 0 : zoneOf(link.url, home);
        const within = depth < options.depth;
        if (within && (z === 0 || (z === 1 && wantsVideo && link.prio >= 2))) {
          enqueue(link.url, depth + 1, rank + 1, link.prio, link.thumb, z, false, finalUrl, link.preview);
          const q = link.duration ? queuedByUrl.get(link.url) : undefined;
          if (q) q.duration ??= link.duration;
        } else if (autoWiden && depth < options.depth + WIDEN_EXTRA_DEPTH && (zone < 2 || link.prio >= 2)) {
          hold(link.url, depth + 1, link.prio, link.thumb, z, finalUrl);
          const r = link.duration ? reservedByKey.get(normalizePageUrl(link.url)) : undefined;
          if (r) r.duration ??= link.duration;
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
    const batch = queue.splice(0, Math.min(CONCURRENCY, options.maxPages - pages));
    for (const b of batch) {
      queuedByUrl.delete(b.url);
      lastRank = Math.max(lastRank, b.rank ?? b.depth);
    }
    pages += batch.length;
    const results = await Promise.all(batch.map((p) => visit(p)));
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
    if (message) yield { type: "note", url: startUrl, message };
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
