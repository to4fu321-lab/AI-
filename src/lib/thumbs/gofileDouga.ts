import "server-only";
import { safeFetch } from "./safeFetch";

/**
 * Gofile のまとめサイト gofile-douga.com。
 *
 * 画面を JavaScript で後から描くサイトなので、ふつうに読むと 1 ページごとにブラウザで開くことになり、とても遅い。
 * サイト自身が一覧を読み込むのに使っている窓口（/api/new・/api/rankings・/api/x/…/items・/api/gofile/…）から、
 * Gofile の共有フォルダの番号・サムネイル・題名を直接もらう。
 * Gofile のフォルダは消されるのが早いので、消されていたものはサムネイルだけ並べる。
 */

const SITE = /^https:\/\/(?:www\.)?gofile-douga\.com$/i;

/** その URL を gofile-douga の一覧として読むなら、窓口の URL を返す（そうでなければ null） */
export function gofileDougaApi(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!SITE.test(u.origin)) return null;
  const p = u.pathname.replace(/\/+$/, "") || "/";
  if (p === "/api/new" || p === "/api/rankings" || /^\/api\/x\/[^/]+\/items$/.test(p) || /^\/api\/gofile\/[^/]+$/.test(p)) return u.toString();
  if (p === "/new") return `${u.origin}/api/new?limit=25&offset=0`;
  if (p === "/" || p === "/ranking" || p === "/rankings") {
    const tab = u.searchParams.get("tab") ?? "12h";
    return `${u.origin}/api/rankings?tab=${encodeURIComponent(tab)}&limit=30&offset=0`;
  }
  const x = /^\/x\/([^/]+)$/.exec(p)?.[1];
  if (x) return `${u.origin}/api/x/${x}/items`;
  const g = /^\/g\/([A-Za-z0-9_-]{4,40})$/.exec(p)?.[1];
  if (g) return `${u.origin}/api/gofile/${g}`;
  return null;
}

export interface GofileDougaItem {
  /** Gofile の共有フォルダ（https://gofile.io/d/番号） */
  share: string;
  /** まとめサイトの詳細ページ（消されていたとき、タップで開く先） */
  page: string;
  thumb?: string;
  title?: string;
}

/** 窓口の返事（JSON）から、Gofile の共有フォルダと、続きの一覧の URL を取り出す */
export async function gofileDougaList(api: string, signal: AbortSignal): Promise<{ items: GofileDougaItem[]; next: string | null }> {
  const { res } = await safeFetch(api, { signal, timeoutMs: 10000, headers: { accept: "application/json" } });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${res.status}`);
  }
  const json = (await res.json()) as { items?: unknown; item?: unknown; hasMore?: unknown };
  const raw = Array.isArray(json.items) ? json.items : json.item ? [json.item] : [];
  const origin = new URL(api).origin;
  const items: GofileDougaItem[] = [];
  for (const r of raw.slice(0, 100)) {
    if (!r || typeof r !== "object") continue;
    const v = r as { gofileCode?: unknown; representativeThumbnailUrl?: unknown; contentTitle?: unknown; sourcePostText?: unknown };
    if (typeof v.gofileCode !== "string" || !/^[A-Za-z0-9_-]{4,40}$/.test(v.gofileCode)) continue;
    // 題名：フォルダの名前（番号そのままのときは使わない）
    const name = typeof v.contentTitle === "string" && v.contentTitle !== v.gofileCode ? v.contentTitle.trim().slice(0, 120) : "";
    items.push({
      share: `https://gofile.io/d/${v.gofileCode}`,
      page: `${origin}/g/${v.gofileCode}`,
      thumb: typeof v.representativeThumbnailUrl === "string" && /^https:\/\//.test(v.representativeThumbnailUrl) ? v.representativeThumbnailUrl : undefined,
      title: name || undefined,
    });
  }
  let next: string | null = null;
  const u = new URL(api);
  if (json.hasMore === true && u.searchParams.has("offset") && items.length) {
    u.searchParams.set("offset", String(Number(u.searchParams.get("offset") ?? 0) + items.length));
    next = u.toString();
  }
  return { items, next };
}
