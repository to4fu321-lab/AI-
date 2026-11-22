import "server-only";
import { extractFromHtml, isPageLikeUrl, kindFromContentType, kindFromUrl } from "./extract";
import { safeFetch } from "./safeFetch";
import type { CrawlEvent, CrawlOptions, MediaItem } from "./types";

/**
 * 入力 URL から「同じサイトの、同じ階層より下」のページを幅優先で辿り、メディアを集める。
 * 結果はページを読むたびに少しずつ yield する（画面に順次出すため）。
 */

const MAX_HTML_BYTES = 3 * 1024 * 1024;
const CONCURRENCY = 4;

/** 入力 URL の「階層」。/gallery/page.html → /gallery/ 、/gallery → /gallery/ */
export function scopeOf(url: URL): string {
  let path = url.pathname;
  const last = path.split("/").pop() ?? "";
  if (last.includes(".")) path = path.slice(0, path.length - last.length);
  return path.endsWith("/") ? path : `${path}/`;
}

function inScope(candidate: string, origin: string, scope: string, startPath: string): boolean {
  try {
    const u = new URL(candidate);
    if (u.origin !== origin) return false;
    return u.pathname === startPath || u.pathname.startsWith(scope) || `${u.pathname}/` === scope;
  } catch {
    return false;
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

export async function* crawl(
  startUrl: string,
  options: CrawlOptions,
  signal: AbortSignal,
  deadline: number,
): AsyncGenerator<CrawlEvent> {
  const start = new URL(startUrl);
  const origin = start.origin;
  const scope = scopeOf(start);
  const startPath = start.pathname;
  const allowed = await loadRobots(origin, signal);

  const seenPages = new Set<string>([normalizePageUrl(startUrl)]);
  const seenMedia = new Set<string>();
  let queue: { url: string; depth: number }[] = [{ url: startUrl, depth: 0 }];
  let pages = 0;
  let mediaCount = 0;
  let truncated = false;

  const visit = async (url: string, depth: number): Promise<CrawlEvent[]> => {
    const events: CrawlEvent[] = [];
    if (!allowed(new URL(url).pathname)) {
      events.push({ type: "skip", url, reason: "robots.txt で禁止されています" });
      return events;
    }
    try {
      const { res, url: finalUrl } = await safeFetch(url, {
        signal,
        headers: { accept: "text/html,application/xhtml+xml,image/*,video/*;q=0.8,*/*;q=0.5" },
      });
      if (!res.ok) {
        await res.body?.cancel();
        events.push({ type: "error", url, message: `HTTP ${res.status}` });
        return events;
      }
      const type = res.headers.get("content-type");
      // 入力がメディアの直 URL だった場合は、それ自体を 1 件として返す
      const directKind = kindFromContentType(type) ?? (type?.includes("html") ? null : kindFromUrl(finalUrl));
      if (directKind) {
        await res.body?.cancel();
        const item: MediaItem = {
          id: finalUrl,
          kind: directKind,
          src: finalUrl,
          pageUrl: finalUrl,
          format: (type?.split("/")[1]?.split(";")[0] ?? "").toUpperCase().replace("JPEG", "JPG") || undefined,
        };
        events.push({ type: "page", url: finalUrl, depth, found: 1 }, { type: "media", items: [item] });
        return events;
      }
      if (type && !/html|xml|text\/plain/i.test(type)) {
        await res.body?.cancel();
        events.push({ type: "skip", url, reason: `ページではありません（${type.split(";")[0]}）` });
        return events;
      }
      const html = await readLimited(res, MAX_HTML_BYTES);
      const { media, links } = extractFromHtml(html, finalUrl);
      const fresh = media.filter((m) => !seenMedia.has(m.id));
      for (const m of fresh) seenMedia.add(m.id);
      events.push({ type: "page", url: finalUrl, depth, found: fresh.length });
      if (fresh.length) events.push({ type: "media", items: fresh });

      if (depth < options.depth) {
        for (const link of links) {
          if (!isPageLikeUrl(link) || !inScope(link, origin, scope, startPath)) continue;
          const key = normalizePageUrl(link);
          if (seenPages.has(key)) continue;
          seenPages.add(key);
          queue.push({ url: link, depth: depth + 1 });
        }
      }
    } catch (err) {
      if (signal.aborted) return events;
      const message =
        err instanceof Error
          ? err.name === "TimeoutError"
            ? "時間切れ（サイトの応答が遅すぎます）"
            : err.message
          : String(err);
      events.push({ type: "error", url, message });
    }
    return events;
  };

  // 幅優先：同じ深さのページを最大 CONCURRENCY 件ずつ並列に読む
  while (queue.length && !signal.aborted) {
    if (pages >= options.maxPages || Date.now() > deadline) {
      truncated = true;
      break;
    }
    const batch = queue.splice(0, Math.min(CONCURRENCY, options.maxPages - pages));
    pages += batch.length;
    const results = await Promise.all(batch.map((p) => visit(p.url, p.depth)));
    for (const events of results) {
      for (const e of events) {
        if (e.type === "media") mediaCount += e.items.length;
        yield e;
      }
    }
    queue = queue.sort((a, b) => a.depth - b.depth);
  }
  if (queue.length) truncated = true;
  yield { type: "done", pages, media: mediaCount, truncated };
}
