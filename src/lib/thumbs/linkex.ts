import "server-only";
import { safeFetch } from "./safeFetch";

/**
 * Linkex（l2e.click/d/… の共有リンク）と、そのまとめサイト linkex-douga.com。
 *
 * Linkex の Web ページは、ファイルの一覧（名前・大きさ・長さ・サムネイル）は見せるが、
 * 動画の再生は「アプリでのみ」としている（Web では再生させない仕組み）。
 * そのため動画ファイルそのものは取らず、サムネイル・長さ・名前を並べて、タップで Linkex を開いてもらう。
 * 一覧は、まとめサイト linkex-douga が公開している窓口（/api/new・/api/ranking・/api/links/…/files）から読む。
 */

const DOUGA = /^https:\/\/(?:www\.)?linkex-douga\.com$/i;

export type LinkexPlan = { kind: "list"; api: string } | { kind: "share"; token: string };

/** その URL を Linkex として扱うか（扱わなければ null） */
export function linkexPlan(raw: string): LinkexPlan | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  // 共有リンクそのもの（l2e.click/d/トークン、linkex.io/d/トークン）
  if (host === "l2e.click" || host === "linkex.io") {
    const t = /^\/d\/([A-Za-z0-9_-]{4,40})/.exec(u.pathname)?.[1];
    return t ? { kind: "share", token: t } : null;
  }
  if (!DOUGA.test(u.origin)) return null;
  const p = u.pathname.replace(/\/+$/, "") || "/";
  const offset = u.searchParams.get("offset") ?? "0";
  const limit = "40";
  // まとめサイト自身の一覧の窓口（新着・ランキング・投稿者）
  if (p === "/api/new" || p === "/api/ranking" || p.startsWith("/api/x/")) return { kind: "list", api: u.toString() };
  if (p === "/new") return { kind: "list", api: `${u.origin}/api/new?offset=${offset}&limit=${limit}` };
  if (p === "/" || p === "/ranking") {
    const period = u.searchParams.get("sort") ?? u.searchParams.get("period") ?? "24h";
    return { kind: "list", api: `${u.origin}/api/ranking?period=${encodeURIComponent(period)}&offset=${offset}&limit=${limit}` };
  }
  const x = /^\/x\/([^/]+)$/.exec(p)?.[1];
  if (x) return { kind: "list", api: `${u.origin}/api/x/${x}` };
  const l = /^\/l\/([A-Za-z0-9_-]{4,40})$/.exec(p)?.[1];
  if (l) return { kind: "share", token: l };
  return null;
}

/** まとめサイトの一覧（JSON）から、共有リンクのトークンと、続きの一覧の URL を取り出す */
export async function linkexList(api: string, signal: AbortSignal): Promise<{ tokens: string[]; next: string | null }> {
  const { res } = await safeFetch(api, { signal, timeoutMs: 10000, headers: { accept: "application/json" } });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${res.status}`);
  }
  const json = (await res.json()) as { items?: { shareToken?: unknown }[] };
  const tokens = (json.items ?? []).map((i) => i?.shareToken).filter((t): t is string => typeof t === "string" && /^[A-Za-z0-9_-]{4,40}$/.test(t));
  let next: string | null = null;
  const u = new URL(api);
  if (u.searchParams.has("offset") && tokens.length >= Number(u.searchParams.get("limit") ?? 40)) {
    u.searchParams.set("offset", String(Number(u.searchParams.get("offset") ?? 0) + tokens.length));
    next = u.toString();
  }
  return { tokens: tokens.slice(0, 60), next };
}

export interface LinkexFile {
  /** タップで開く先（Linkex の共有ページ。ファイルごとに分けるため # にファイルの番号を付ける） */
  url: string;
  name: string;
  thumb?: string;
  duration?: number;
}

type DougaFile = { fileName?: unknown; isVideo?: unknown; thumbnailUrl?: unknown };

/**
 * 共有リンクの中の動画。まとめサイト linkex-douga が公開している一覧（/api/links/トークン/files）から読む
 * （Linkex 自身の窓口は、Linkex の Web ページの署名が必要なので使わない）。
 * まとめサイトに載っていない共有リンクは、共有ページそのものを 1 件として返す
 */
export async function linkexFiles(token: string, signal: AbortSignal): Promise<LinkexFile[]> {
  const share = `https://l2e.click/d/${token}`;
  const out: LinkexFile[] = [];
  for (let offset = 0; offset < 200 && !signal.aborted; offset += 100) {
    const { res } = await safeFetch(`https://linkex-douga.com/api/links/${encodeURIComponent(token)}/files?offset=${offset}&limit=100`, {
      signal,
      timeoutMs: 10000,
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      break;
    }
    const json = (await res.json().catch(() => null)) as { files?: DougaFile[] } | null;
    const files = json?.files ?? [];
    files.forEach((f, i) => {
      if (f?.isVideo !== true) return;
      out.push({
        url: `${share}#${offset + i}`,
        name: typeof f.fileName === "string" ? f.fileName.slice(0, 120) : "動画",
        thumb: typeof f.thumbnailUrl === "string" && /^https:\/\//.test(f.thumbnailUrl) ? f.thumbnailUrl : undefined,
      });
    });
    if (files.length < 100) break;
  }
  return out.length ? out : [{ url: share, name: "Linkex の共有リンク" }];
}
