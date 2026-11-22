/**
 * X（旧 Twitter）の投稿の動画を、投稿の番号から取り出す。
 *
 * 「X の動画保存ランキング」のようなサイトは、動画ファイルそのものではなく、
 * X の投稿へのリンク（x.com/ユーザー/status/番号）やサムネイルだけを並べていることが多い。
 * X の投稿ページはログインと JavaScript が必要で、ページを読んでも動画は出てこない。
 *
 * そこで、ページを開かずに「投稿の番号 → 動画ファイルの URL」を直接もらう：
 *   1. X 自身がサイトへの埋め込み用に公開している窓口（cdn.syndication.twimg.com）。ログイン不要
 *   2. 駄目なら、埋め込み表示を手伝う公開サービス（api.fxtwitter.com）
 * 動画は video.twimg.com の MP4（いちばん画質の高いもの）。サムネイル・長さ・投稿の文も一緒にもらえる。
 */

/** 投稿の URL から番号を取り出す（投稿の URL でなければ null） */
export function tweetIdOf(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^(?:www|mobile|m)\./, "");
  if (!/^(?:x|twitter|fxtwitter|vxtwitter|fixupx|fixvx|twittpr|nitter\.net)\.com$|^nitter\.net$/.test(host)) return null;
  const m = /\/(?:status|statuses)\/(\d{8,20})/.exec(u.pathname);
  return m ? m[1] : null;
}

/** 文章（HTML・スクリプト）の中から、投稿の番号を探す */
export function findTweetIds(text: string, limit = 100): string[] {
  const out = new Set<string>();
  const unescaped = text.replace(/\\\//g, "/");
  for (const m of unescaped.matchAll(/(?:twitter|x)\.com\/(?:[A-Za-z0-9_]{1,20}|i(?:\/web)?)\/status(?:es)?\/(\d{8,20})/g)) {
    out.add(m[1]);
    if (out.size >= limit) return [...out];
  }
  for (const m of unescaped.matchAll(/data-(?:tweet-?id|tweet|status-?id)\s*=\s*["'](\d{8,20})["']|platform\.twitter\.com\/embed\/Tweet\.html\?[^"'\s]*?\bid=(\d{8,20})/gi)) {
    out.add(m[1] ?? m[2]);
    if (out.size >= limit) break;
  }
  return [...out];
}

/**
 * X の動画のサムネイル（pbs.twimg.com/…_video_thumb/…）か。
 * これは動画の表紙なので、画像として一覧に出さない（同じものが画像と動画で 2 つ並ぶため）
 */
export function isTwitterVideoThumb(url: string): boolean {
  return /^https?:\/\/pbs\.twimg\.com\/(?:ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\//i.test(url);
}

/**
 * GIF アニメのサムネイル（pbs.twimg.com/tweet_video_thumb/ID.jpg）なら、その動画（video.twimg.com/tweet_video/ID.mp4）を返す。
 * GIF アニメだけは、サムネイルの名前と動画の名前が同じ決まりになっている
 */
export function gifVideoFromThumb(url: string): string | null {
  const m = /^https?:\/\/pbs\.twimg\.com\/tweet_video_thumb\/([\w-]+)\.\w+/i.exec(url);
  return m ? `https://video.twimg.com/tweet_video/${m[1]}.mp4` : null;
}

export interface TweetVideo {
  src: string;
  thumb?: string;
  /** 秒 */
  duration?: number;
  /** 投稿の文（短くしたもの） */
  title?: string;
  /** 投稿の URL */
  tweetUrl: string;
}

/** X の埋め込み用の窓口に渡す合言葉（埋め込み表示の公式部品と同じ計算） */
function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

type Variant = { bitrate?: number; content_type?: string; url?: string; src?: string; type?: string };

/** MP4 の中から、いちばん画質の高いものを選ぶ */
function bestMp4(variants: Variant[] | undefined): string | undefined {
  const mp4 = (variants ?? [])
    .map((v) => ({ url: v.url ?? v.src, type: v.content_type ?? v.type, bitrate: v.bitrate ?? 0 }))
    .filter((v) => v.url && (/mp4/i.test(v.type ?? "") || /\.mp4(?:\?|$)/i.test(v.url!)));
  mp4.sort((a, b) => b.bitrate - a.bitrate);
  return mp4[0]?.url;
}

const shorten = (text: unknown) =>
  typeof text === "string" && text.trim() ? text.replace(/https?:\/\/t\.co\/\w+/g, "").replace(/\s+/g, " ").trim().slice(0, 140) || undefined : undefined;

/** 埋め込み用の窓口の返事から、動画を取り出す（引用された投稿の動画も） */
function fromSyndication(json: Record<string, unknown>, id: string): TweetVideo[] {
  const out: TweetVideo[] = [];
  const visit = (tweet: Record<string, unknown> | undefined, tweetId: string, depth: number) => {
    if (!tweet || depth > 1) return;
    const user = (tweet.user as { screen_name?: string } | undefined)?.screen_name ?? "i";
    const tweetUrl = `https://x.com/${user}/status/${tweetId}`;
    const title = shorten(tweet.text);
    const media = (tweet.mediaDetails as Record<string, unknown>[] | undefined) ?? [];
    for (const m of media) {
      if (m.type !== "video" && m.type !== "animated_gif") continue;
      const info = m.video_info as { variants?: Variant[]; duration_millis?: number } | undefined;
      const src = bestMp4(info?.variants);
      if (!src) continue;
      out.push({
        src,
        thumb: typeof m.media_url_https === "string" ? m.media_url_https : undefined,
        duration: info?.duration_millis ? info.duration_millis / 1000 : undefined,
        title,
        tweetUrl,
      });
    }
    const quoted = tweet.quoted_tweet as Record<string, unknown> | undefined;
    if (quoted && typeof quoted.id_str === "string") visit(quoted, quoted.id_str, depth + 1);
  };
  visit(json, id, 0);
  return out;
}

/** fxtwitter の返事から、動画を取り出す */
function fromFx(json: Record<string, unknown>, id: string): TweetVideo[] {
  const tweet = json.tweet as Record<string, unknown> | undefined;
  if (!tweet) return [];
  const user = (tweet.author as { screen_name?: string } | undefined)?.screen_name ?? "i";
  const videos = ((tweet.media as { videos?: Record<string, unknown>[] } | undefined)?.videos ?? []) as Record<string, unknown>[];
  return videos
    .map((v): TweetVideo | null => {
      const src = bestMp4(v.formats as Variant[] | undefined) ?? (typeof v.url === "string" ? v.url : undefined);
      if (!src) return null;
      return {
        src,
        thumb: typeof v.thumbnail_url === "string" ? v.thumbnail_url : undefined,
        duration: typeof v.duration === "number" && v.duration > 0 ? v.duration : undefined,
        title: shorten(tweet.text),
        tweetUrl: `https://x.com/${user}/status/${id}`,
      };
    })
    .filter((v): v is TweetVideo => !!v);
}

type Fetcher = (url: string, signal: AbortSignal) => Promise<Record<string, unknown> | null>;

/** 結果を覚えておく（同じサーバーが動いている間。見つからなかったものも覚える） */
const cache = new Map<string, Promise<TweetVideo[]>>();

/**
 * 投稿の番号から動画を得る（動画のない投稿・消された投稿は空）。
 * getJson は「URL を読んで JSON を返す（失敗なら null）」関数（サーバーの安全な読み込みを使うため外から渡す）
 */
export function tweetVideos(id: string, signal: AbortSignal, getJson: Fetcher): Promise<TweetVideo[]> {
  let job = cache.get(id);
  if (!job) {
    job = (async () => {
      const syn = await getJson(
        `https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=ja&token=${syndicationToken(id)}`,
        signal,
      ).catch(() => null);
      if (syn && syn.__typename !== "TweetTombstone") {
        const found = fromSyndication(syn, id);
        if (found.length) return found;
        // 投稿は読めたが動画がない（画像だけの投稿など）
        if (Array.isArray(syn.mediaDetails)) return [];
      }
      // 年齢制限などで埋め込み用の窓口が答えないときは、もう 1 つの公開サービスに聞く
      const fx = await getJson(`https://api.fxtwitter.com/i/status/${id}`, signal).catch(() => null);
      return fx ? fromFx(fx, id) : [];
    })();
    cache.set(id, job);
    // 通信の失敗で空だったものは、次にもう一度聞けるよう覚えない
    void job.then((v) => !v.length && signal.aborted && cache.delete(id));
    if (cache.size > 5000) cache.delete(cache.keys().next().value!);
  }
  return job;
}
