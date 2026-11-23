/**
 * サイトが機械向けに出している一覧（サイトマップ・RSS / Atom の新着一覧）。
 *
 * リンクを 1 つずつ辿るより速く、漏れなくページを集められる。サイト側が「読んでよい」と出しているものなので断られにくい。
 * 動画サイトのサイトマップ・配信用の RSS には、動画ファイル・サムネイル・題名がそのまま書いてあることもある。
 */

export interface FeedPage {
  url: string;
  title?: string;
  thumb?: string;
}

export interface FeedVideo {
  src: string;
  pageUrl: string;
  title?: string;
  thumb?: string;
  duration?: number;
}

export interface FeedResult {
  /** ページの URL（新しい順・書かれていた順） */
  pages: FeedPage[];
  /** 一覧にそのまま書いてあった動画ファイル */
  videos: FeedVideo[];
  /** 中に入っている別のサイトマップ（サイトマップの目次） */
  more: string[];
}

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();

const abs = (raw: string | undefined, base: string): string | null => {
  if (!raw) return null;
  try {
    const u = new URL(decode(raw), base);
    return /^https?:$/.test(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
};

const tag = (block: string, name: string): string | undefined => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block);
  return m ? decode(m[1]) : undefined;
};
const attr = (block: string, name: string, key: string): string | undefined => {
  const m = new RegExp(`<${name}\\s[^>]*?\\b${key}\\s*=\\s*["']([^"']+)["']`, "i").exec(block);
  return m ? decode(m[1]) : undefined;
};
const isVideoUrl = (u: string) => /\.(?:mp4|m4v|mov|webm|m3u8)(?:$|[?#])/i.test(u);

/** HTML の <head> に書かれた新着一覧（RSS / Atom）の URL */
export function feedLinksInHtml(html: string, pageUrl: string): string[] {
  const out = new Set<string>();
  for (const m of html.slice(0, 300000).matchAll(/<link\b[^>]*>/gi)) {
    const t = m[0];
    if (!/rel\s*=\s*["']?alternate/i.test(t) || !/type\s*=\s*["']?application\/(?:rss|atom)\+xml/i.test(t)) continue;
    const u = abs(/href\s*=\s*["']([^"']+)["']/i.exec(t)?.[1], pageUrl);
    if (u) out.add(u);
  }
  return [...out].slice(0, 3);
}

/** サイトマップ・RSS・Atom の中身から、ページ・動画・中のサイトマップを取り出す（どれでもなければ null） */
export function parseFeed(xml: string, feedUrl: string): FeedResult | null {
  const head = xml.slice(0, 3000);
  if (!/<(?:urlset|sitemapindex|rss|feed|rdf:RDF)\b/i.test(head)) return null;
  const pages: FeedPage[] = [];
  const videos: FeedVideo[] = [];
  const more: string[] = [];

  // サイトマップの目次
  for (const m of xml.matchAll(/<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi)) {
    const u = abs(tag(m[1], "loc"), feedUrl);
    if (u && more.length < 20) more.push(u);
  }
  // サイトマップ（動画サイトマップ・画像サイトマップの情報も）
  for (const m of xml.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)) {
    if (pages.length >= 2000) break;
    const b = m[1];
    const u = abs(tag(b, "loc"), feedUrl);
    if (!u) continue;
    const thumb = abs(tag(b, "video:thumbnail_loc") ?? tag(b, "image:loc"), feedUrl) ?? undefined;
    const title = tag(b, "video:title")?.slice(0, 120);
    pages.push({ url: u, title, thumb });
    const content = abs(tag(b, "video:content_loc"), feedUrl);
    const dur = Number(tag(b, "video:duration"));
    if (content && isVideoUrl(content)) videos.push({ src: content, pageUrl: u, title, thumb, duration: dur > 0 ? dur : undefined });
  }
  // RSS / RDF の記事、Atom の記事
  for (const m of xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    if (pages.length >= 2000) break;
    const b = m[2];
    const link = abs(tag(b, "link") || attr(b, "link", "href"), feedUrl);
    const title = tag(b, "title")?.replace(/<[^>]+>/g, "").slice(0, 120);
    const thumb = abs(attr(b, "media:thumbnail", "url") ?? /<img\b[^>]*\ssrc\s*=\s*(?:&quot;|["'])([^"'&]+)/i.exec(decode(b))?.[1], feedUrl) ?? undefined;
    if (link) pages.push({ url: link, title, thumb });
    for (const e of b.matchAll(/<(?:enclosure|media:content)\b[^>]*>/gi)) {
      const src = abs(/\burl\s*=\s*["']([^"']+)["']/i.exec(e[0])?.[1], feedUrl);
      const type = /\btype\s*=\s*["']([^"']+)["']/i.exec(e[0])?.[1] ?? "";
      if (src && (type.startsWith("video/") || isVideoUrl(src)) && link) videos.push({ src, pageUrl: link, title, thumb });
    }
  }
  return { pages, videos: videos.slice(0, 500), more };
}
