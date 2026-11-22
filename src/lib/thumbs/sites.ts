/**
 * サイトごとの小さな対応（一覧の「もっと見る」など、ページの HTML だけではわからないもの）。
 *
 * twihub.link：一覧ページは最初の 20〜40 件だけを HTML に入れ、続きはサイト自身が
 * /api/v1/posts?type=…&limit=…&cursor=… から読み込む（スクロールで「もっと見る」）。
 * その続きの URL を「ページ送り」として辿れるようにし、返ってくる JSON から投稿ページへのリンクを作る。
 */

const TWIHUB = /^https:\/\/(?:www\.)?twihub\.link$/i;

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/** twihub の一覧の続きを返す窓口か */
export function isTwihubListApi(url: string): boolean {
  try {
    const u = new URL(url);
    return TWIHUB.test(u.origin) && u.pathname === "/api/v1/posts";
  } catch {
    return false;
  }
}

/** twihub のランキングの種類（最新・24 時間・週間・月間）。どれも一覧ページは 20 件ずつ */
const TWIHUB_TYPES = ["realtime", "1d", "7d", "30d"];

/**
 * twihub の一覧ページ（HTML）から、続きとして読むページを作る（twihub でなければ空）。
 * - 続きの窓口（/api/v1/posts?cursor=…）。ただし、このアプリのサーバーからは「人間かどうかの確認」で断られることが多い
 * - ほかの種類のランキングの一覧ページ（こちらは読める）。合わせて 80 件ほど並ぶ
 */
export function twihubNextFromHtml(html: string, pageUrl: string): string[] {
  if (!TWIHUB.test(originOf(pageUrl))) return [];
  const u = new URL(pageUrl);
  if (u.pathname !== "/posts" && u.pathname !== "/") return [];
  const type = u.searchParams.get("type") ?? "realtime";
  const out = TWIHUB_TYPES.filter((t) => t !== type || u.pathname === "/").map((t) => `${u.origin}/posts?type=${t}`);
  const m = /hasMore:true,nextCursor:"([^"]{4,120})"/.exec(html);
  if (m) out.push(`${u.origin}/api/v1/posts?${new URLSearchParams({ type, limit: "40", cursor: m[1] })}`);
  return out;
}

export interface ListItem {
  url: string;
  thumb?: string;
  duration?: number;
}

/** twihub の一覧の続き（JSON）から、投稿ページへのリンクと、さらに続きの URL を取り出す */
export function twihubFromJson(text: string, apiUrl: string): { items: ListItem[]; next: string | null } | null {
  let json: { posts?: unknown; hasMore?: unknown; nextCursor?: unknown };
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!json || !Array.isArray(json.posts)) return null;
  const origin = originOf(apiUrl);
  const items: ListItem[] = [];
  for (const p of json.posts.slice(0, 200)) {
    if (!p || typeof p !== "object") continue;
    const v = p as { postId?: unknown; thumbnailUrl?: unknown; firstVideoDuration?: unknown };
    if (typeof v.postId !== "string" || !/^[0-9a-f-]{8,64}$/i.test(v.postId)) continue;
    items.push({
      url: `${origin}/posts/${v.postId}`,
      thumb: typeof v.thumbnailUrl === "string" && /^https:\/\//.test(v.thumbnailUrl) ? v.thumbnailUrl : undefined,
      duration: typeof v.firstVideoDuration === "number" && v.firstVideoDuration > 0 ? v.firstVideoDuration : undefined,
    });
  }
  let next: string | null = null;
  if (json.hasMore === true && typeof json.nextCursor === "string" && json.nextCursor.length < 200) {
    const u = new URL(apiUrl);
    u.searchParams.set("cursor", json.nextCursor);
    next = u.toString();
  }
  return { items, next };
}
