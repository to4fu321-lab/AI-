import "server-only";
import { assertPublicUrl, safeFetch } from "./safeFetch";

/**
 * Gofile（gofile.io/d/ID）の共有フォルダから、ファイルの一覧と直リンクをもらう。
 *
 * Gofile のページは JavaScript で一覧を描き、ファイルのダウンロードには
 * 「ゲスト用の合言葉」（accountToken という Cookie）が必要。Gofile のページ自身がやっているのと同じ手順を踏む：
 *   1. ゲスト用のアカウントを作って合言葉をもらう（POST api.gofile.io/accounts）
 *   2. 合言葉を付けて、フォルダの中身を聞く（GET api.gofile.io/contents/ID）
 *   3. ファイルを読むときも、その合言葉を Cookie として送る（→ MediaItem.cookie で、確認・再生・保存まで持ち回る）
 * 「サイト用の合言葉」（wt）は Gofile のスクリプトに書いてあるので、そこから読む（読めなければ知られている値）。
 */

export function gofileId(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (!/(?:^|\.)gofile\.io$/i.test(u.hostname)) return null;
    return /^\/d\/([\w-]{4,})/.exec(u.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

export interface GofileFile {
  src: string;
  name: string;
  kind: "image" | "video";
  thumb?: string;
  /** ファイルを読むときに送る Cookie（"gofile.io|accountToken=…"） */
  cookie: string;
  pageUrl: string;
}

export type GofileResult = { files: GofileFile[]; error?: string };

const FALLBACK_WT = "4fd6sg89d7s6";
let session: Promise<{ token: string; wt: string } | null> | null = null;
let sessionAt = 0;

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const data = await res.json();
    return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Gofile のスクリプトから「サイト用の合言葉」を読む */
async function websiteToken(signal: AbortSignal): Promise<string> {
  for (const path of ["/dist/js/global.js", "/dist/js/config.js", "/dist/js/alljs.js"]) {
    try {
      const { res } = await safeFetch(`https://gofile.io${path}`, { signal, timeoutMs: 6000 });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        continue;
      }
      const js = (await res.text()).slice(0, 3_000_000);
      const m = /\bwt\s*[:=]\s*["']([A-Za-z0-9]{6,40})["']/.exec(js) ?? /websiteToken["']?\s*[:=]\s*["']([A-Za-z0-9]{6,40})["']/.exec(js);
      if (m) return m[1];
    } catch {
      /* 次の場所を試す */
    }
  }
  return FALLBACK_WT;
}

/** ゲスト用の合言葉（同じサーバーが動いている間、1 時間使い回す） */
function getSession(signal: AbortSignal): Promise<{ token: string; wt: string } | null> {
  if (!session || Date.now() - sessionAt > 60 * 60 * 1000) {
    sessionAt = Date.now();
    session = (async () => {
      const [wt, account] = await Promise.all([
        websiteToken(signal),
        (async () => {
          const { res } = await fetchPost("https://api.gofile.io/accounts", signal);
          return res.ok ? readJson(res) : null;
        })().catch(() => null),
      ]);
      const token = (account?.data as { token?: unknown } | undefined)?.token;
      return typeof token === "string" && token ? { token, wt } : null;
    })();
    void session.then((s) => !s && (session = null));
  }
  return session;
}

/** safeFetch は GET だけなので、アカウント作成の POST は接続先を確かめたうえで直接送る */
async function fetchPost(url: string, signal: AbortSignal): Promise<{ res: Response }> {
  await assertPublicUrl(url);
  const res = await fetch(url, {
    method: "POST",
    signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
    headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0", origin: "https://gofile.io", referer: "https://gofile.io/" },
    body: "{}",
    redirect: "error",
  });
  return { res };
}

const VIDEO_NAME_RE = /\.(?:mp4|m4v|mov|webm|mkv|avi|wmv|flv|ts|3gp|mpg|mpeg|ogv)$/i;
const IMAGE_NAME_RE = /\.(?:jpe?g|png|gif|webp|avif|heic|bmp)$/i;

/** フォルダの中身を聞く（中のフォルダも 2 段まで。ファイルは 300 個まで） */
export async function gofileFiles(id: string, signal: AbortSignal): Promise<GofileResult> {
  const s = await getSession(signal);
  if (!s) return { files: [], error: "Gofile のゲスト用の合言葉をもらえませんでした" };
  const cookie = `gofile.io|accountToken=${s.token}`;
  const files: GofileFile[] = [];
  let error: string | undefined;
  const visit = async (folder: string, level: number) => {
    if (level > 2 || files.length >= 300 || signal.aborted) return;
    const { res } = await safeFetch(`https://api.gofile.io/contents/${encodeURIComponent(folder)}?wt=${s.wt}&cache=true`, {
      signal,
      timeoutMs: 10000,
      headers: { authorization: `Bearer ${s.token}`, "x-website-token": s.wt, accept: "application/json", origin: "https://gofile.io", referer: "https://gofile.io/" },
    });
    const json = await readJson(res);
    if (!json || json.status !== "ok") {
      const status = typeof json?.status === "string" ? json.status : `HTTP ${res.status}`;
      error ??=
        status === "error-passwordRequired"
          ? "パスワード付きの Gofile フォルダは読めません"
          : status === "error-notFound"
            ? "Gofile のフォルダが見つかりません（削除された可能性があります）"
            : status === "error-notPremium"
              ? "この Gofile のファイルは有料会員でないと読めません"
              : `Gofile が答えませんでした（${status}）`;
      return;
    }
    const data = json.data as Record<string, unknown>;
    const children = (data.children ?? data.contents ?? {}) as Record<string, Record<string, unknown>>;
    const nested: string[] = [];
    // フォルダではなくファイル 1 つの共有リンクのときは、data 自体がファイル
    const entries = data.type === "file" ? [data] : Object.values(children);
    for (const c of entries) {
      if (c.type === "folder" && typeof c.id === "string") {
        nested.push(c.id);
        continue;
      }
      const link = typeof c.link === "string" ? c.link : typeof c.directLink === "string" ? c.directLink : undefined;
      const name = typeof c.name === "string" ? c.name : "";
      const mime = typeof c.mimetype === "string" ? c.mimetype : "";
      if (!link || !/^https:\/\//.test(link)) continue;
      const kind = mime.startsWith("video/") || VIDEO_NAME_RE.test(name) ? "video" : mime.startsWith("image/") || IMAGE_NAME_RE.test(name) ? "image" : null;
      if (!kind) continue;
      files.push({
        src: link,
        name,
        kind,
        thumb: typeof c.thumbnail === "string" && /^https:\/\//.test(c.thumbnail) ? c.thumbnail : undefined,
        cookie,
        pageUrl: `https://gofile.io/d/${id}`,
      });
      if (files.length >= 300) return;
    }
    for (const n of nested) await visit(n, level + 1);
  };
  try {
    await visit(id, 0);
  } catch {
    error ??= "Gofile に接続できませんでした";
  }
  return { files, error: files.length ? undefined : error };
}
