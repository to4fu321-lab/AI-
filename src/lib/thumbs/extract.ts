import type { MediaItem } from "./types";

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

function parseTags(html: string, names: Set<string>): Tag[] {
  const tags: Tag[] = [];
  for (const m of html.matchAll(TAG_RE)) {
    const name = m[1].toLowerCase();
    if (!names.has(name)) continue;
    const attrs: Record<string, string> = {};
    if (m[2]) {
      for (const a of m[2].matchAll(ATTR_RE)) {
        attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? "");
      }
    }
    tags.push({ name, attrs, index: m.index ?? 0 });
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

function formatOf(url: string, kind: MediaItem["kind"]): string | undefined {
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

export interface Extracted {
  media: MediaItem[];
  links: string[];
  title?: string;
}

export function extractFromHtml(html: string, pageUrl: string): Extracted {
  // <base href> があれば相対 URL の基準を変える
  const baseTag = /<base\s[^>]*href\s*=\s*["']?([^"'\s>]+)/i.exec(html);
  const base = resolveUrl(baseTag?.[1], pageUrl) ?? pageUrl;

  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const pageTitle = titleMatch ? decodeEntities(titleMatch[1]).trim().slice(0, 200) : undefined;

  const found = new Map<string, MediaItem>();
  const add = (item: Omit<MediaItem, "id" | "pageUrl">) => {
    const id = item.src;
    const existing = found.get(id);
    if (existing) {
      // 既にあるなら、足りない情報（サムネ・タイトル）だけ補う
      existing.thumb ??= item.thumb;
      existing.title ??= item.title;
      return;
    }
    found.set(id, { ...item, id, pageUrl });
  };

  const addEmbed = (url: string, title?: string) => {
    const yt = youtubeId(url);
    if (yt) {
      add({
        kind: "embed",
        src: `https://www.youtube-nocookie.com/embed/${yt}`,
        thumb: `https://i.ytimg.com/vi/${yt}/hqdefault.jpg`,
        format: "YouTube",
        title,
      });
      return true;
    }
    const vm = vimeoId(url);
    if (vm) {
      add({ kind: "embed", src: `https://player.vimeo.com/video/${vm}`, format: "Vimeo", title });
      return true;
    }
    return false;
  };

  // script / style / コメントの中身はタグとして読まない（誤検出を防ぐ）。ただし後で URL 探しには使う
  const markup = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, (m, name: string) =>
      name.toLowerCase() === "noscript" ? m.replace(/<\/?noscript[^>]*>/gi, "") : "",
    );

  const tags = parseTags(
    markup,
    new Set(["meta", "img", "source", "video", "a", "iframe", "link", "image"]),
  );

  // --- 1. OGP / Twitter カード（ページの代表サムネイル） ---
  let ogImage: string | undefined;
  let ogVideo: string | undefined;
  for (const t of tags) {
    if (t.name !== "meta") continue;
    const key = (t.attrs.property || t.attrs.name || "").toLowerCase();
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
    } else if (t.name === "iframe") {
      const url = resolveUrl(t.attrs.src || t.attrs["data-src"], base);
      if (url) addEmbed(url, t.attrs.title);
    } else if (t.name === "link") {
      const rel = (t.attrs.rel || "").toLowerCase();
      if (rel === "image_src") {
        const url = resolveUrl(t.attrs.href, base);
        if (url) add({ kind: "image", src: url, format: formatOf(url, "image") });
      }
    }
  }

  // --- 4. <a href> : メディアへの直リンク、YouTube へのリンク、辿る候補のページ ---
  const links: string[] = [];
  for (const t of tags) {
    if (t.name !== "a") continue;
    const url = resolveUrl(t.attrs.href, base);
    if (!url) continue;
    if (addEmbed(url, t.attrs.title)) continue;
    const kind = kindFromUrl(url);
    if (kind) {
      add({ kind, src: url, format: formatOf(url, kind), title: t.attrs.title });
    } else {
      links.push(url);
    }
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
  const unescaped = html.replace(/\\\//g, "/").replace(/\\u002[fF]/g, "/");
  for (const m of unescaped.matchAll(/https?:\/\/[^\s"'<>\\()]+?\.(?:mp4|m4v|webm|mov|m3u8)(?:\?[^\s"'<>\\()]*)?(?=["'\s<>\\),])/gi)) {
    const url = resolveUrl(m[0], base);
    if (url) add({ kind: "video", src: url, format: formatOf(url, "video") });
  }

  // 動画にポスターがない場合、ページの OGP 画像を代わりに使う
  if (ogImage) {
    for (const item of found.values()) {
      if (item.kind !== "image" && !item.thumb) item.thumb = ogImage;
    }
  }

  return { media: [...found.values()], links: [...new Set(links)], title: pageTitle };
}

type AddFn = (item: Omit<MediaItem, "id" | "pageUrl">) => void;

function walkJsonLd(
  node: unknown,
  base: string,
  add: AddFn,
  addEmbed: (url: string, title?: string) => boolean,
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
    if (content) add({ kind: "video", src: content, thumb, format: formatOf(content, "video") ?? "動画", title: name });
    else if (embed && !addEmbed(embed, name)) add({ kind: "embed", src: embed, thumb, format: "埋め込み", title: name });
  } else if (/ImageObject/i.test(type)) {
    const content = resolveUrl(str(obj.contentUrl) ?? str(obj.url), base);
    if (content) add({ kind: "image", src: content, format: formatOf(content, "image"), title: name });
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") walkJsonLd(v, base, add, addEmbed, depth + 1);
  }
}
