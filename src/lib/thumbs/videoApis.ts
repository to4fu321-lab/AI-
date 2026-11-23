/**
 * 動画サービスが公式に出している検索の窓口（キーなしで使えるもの）。
 * 「動画を探す」の検索先として使う。返事（JSON）から、動画（埋め込み・ファイル）と、読みに行くページを取り出す。
 */

export interface ApiVideo {
  kind: "video" | "embed";
  src: string;
  pageUrl: string;
  title?: string;
  thumb?: string;
  duration?: number;
  format: string;
}

export interface ApiPage {
  url: string;
  title?: string;
  thumb?: string;
}

export interface ApiResult {
  videos: ApiVideo[];
  pages: ApiPage[];
  /** 続きの窓口の URL */
  next: string | null;
}

/** 公式の検索の窓口の URL か */
export function isVideoApi(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (
      (u.hostname === "api.dailymotion.com" && u.pathname === "/videos") ||
      (u.hostname === "snapshot.search.nicovideo.jp" && u.pathname.endsWith("/contents/search")) ||
      (u.hostname === "archive.org" && u.pathname === "/advancedsearch.php") ||
      /^\/api\/v1\/timelines\/tag\/[^/]+$/.test(u.pathname)
    );
  } catch {
    return false;
  }
}

/** 検索のワードから、公式の検索の窓口の URL を作る */
export function videoApiUrls(word: string): Record<"dailymotion" | "nico" | "archive" | "mastodon", string> {
  const q = encodeURIComponent(word.trim());
  // Mastodon はタグで探す（空白・記号を除いた 1 語）
  const tag = encodeURIComponent(word.trim().replace(/[\s#＃、。・]+/g, ""));
  return {
    dailymotion: `https://api.dailymotion.com/videos?search=${q}&limit=50&page=1&fields=id,title,thumbnail_480_url,duration,url`,
    nico: `https://snapshot.search.nicovideo.jp/api/v2/snapshot/video/contents/search?q=${q}&targets=title,description,tags&fields=contentId,title,thumbnailUrl,lengthSeconds&_sort=-viewCounter&_limit=50&_offset=0&_context=thumbs`,
    archive: `https://archive.org/advancedsearch.php?q=${q}%20AND%20mediatype%3Amovies&fl%5B%5D=identifier&fl%5B%5D=title&rows=50&page=1&output=json`,
    mastodon: `https://mstdn.jp/api/v1/timelines/tag/${tag}?limit=40&only_media=true`,
  };
}

const str = (v: unknown, max = 300): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const http = (v: unknown): string | undefined => (typeof v === "string" && /^https:\/\//.test(v) && v.length < 2000 ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && v > 0 && v < 400000 ? v : undefined);

/** 窓口の返事（JSON の文字）を読む。形が違えば null */
export function parseVideoApi(text: string, apiUrl: string): ApiResult | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const u = new URL(apiUrl);
  const videos: ApiVideo[] = [];
  const pages: ApiPage[] = [];
  let next: string | null = null;

  if (u.hostname === "api.dailymotion.com") {
    const d = json as { list?: Record<string, unknown>[]; has_more?: unknown };
    for (const v of d.list ?? []) {
      const id = str(v.id, 20);
      if (!id || !/^[a-z0-9]+$/i.test(id)) continue;
      videos.push({
        kind: "embed",
        src: `https://www.dailymotion.com/embed/video/${id}`,
        pageUrl: `https://www.dailymotion.com/video/${id}`,
        title: str(v.title, 120),
        thumb: http(v.thumbnail_480_url),
        duration: num(v.duration),
        format: "Dailymotion",
      });
    }
    const page = Number(u.searchParams.get("page") ?? 1);
    if (d.has_more === true && page < 10) {
      u.searchParams.set("page", String(page + 1));
      next = u.toString();
    }
  } else if (u.hostname === "snapshot.search.nicovideo.jp") {
    const d = json as { data?: Record<string, unknown>[]; meta?: { totalCount?: unknown } };
    for (const v of d.data ?? []) {
      const id = str(v.contentId, 20);
      if (!id || !/^[a-z]{2}\d+$/.test(id)) continue;
      videos.push({
        kind: "embed",
        src: `https://embed.nicovideo.jp/watch/${id}`,
        pageUrl: `https://www.nicovideo.jp/watch/${id}`,
        title: str(v.title, 120),
        thumb: http(v.thumbnailUrl),
        duration: num(v.lengthSeconds),
        format: "ニコニコ",
      });
    }
    const offset = Number(u.searchParams.get("_offset") ?? 0);
    const total = typeof d.meta?.totalCount === "number" ? d.meta.totalCount : 0;
    if ((d.data ?? []).length >= 50 && offset + 50 < Math.min(total, 500)) {
      u.searchParams.set("_offset", String(offset + 50));
      next = u.toString();
    }
  } else if (u.hostname === "archive.org") {
    const d = json as { response?: { docs?: Record<string, unknown>[]; numFound?: unknown } };
    for (const v of d.response?.docs ?? []) {
      const id = str(v.identifier, 200);
      if (!id || !/^[\w.-]+$/.test(id)) continue;
      // 作品のページを読みに行く（中の動画ファイルは、ページに書いてある）
      pages.push({ url: `https://archive.org/details/${id}`, title: str(v.title, 120), thumb: `https://archive.org/services/img/${id}` });
    }
    const page = Number(u.searchParams.get("page") ?? 1);
    const total = typeof d.response?.numFound === "number" ? d.response.numFound : 0;
    if (page * 50 < Math.min(total, 300)) {
      u.searchParams.set("page", String(page + 1));
      next = u.toString();
    }
  } else if (Array.isArray(json)) {
    // Mastodon のタグの投稿（公開の投稿のうち、動画が付いたもの）
    let last = "";
    for (const s of json as Record<string, unknown>[]) {
      const id = str(s.id, 30);
      if (id) last = id;
      const pageUrl = http(s.url) ?? http(s.uri);
      if (!pageUrl) continue;
      const text = str(typeof s.content === "string" ? s.content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ") : undefined, 120);
      for (const m of (Array.isArray(s.media_attachments) ? s.media_attachments : []) as Record<string, unknown>[]) {
        if (m.type !== "video" && m.type !== "gifv") continue;
        const src = http(m.url) ?? http(m.remote_url);
        if (!src) continue;
        const meta = (m.meta as { original?: { duration?: unknown } } | undefined)?.original;
        videos.push({ kind: "video", src, pageUrl, title: text, thumb: http(m.preview_url), duration: num(meta?.duration), format: "Mastodon" });
      }
    }
    if ((json as unknown[]).length >= 40 && last && /^\d+$/.test(last)) {
      u.searchParams.set("max_id", last);
      next = u.toString();
    }
  } else return null;
  return { videos, pages, next };
}
