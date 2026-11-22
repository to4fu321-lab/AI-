import "server-only";
import { createHash } from "node:crypto";
import { renderPage } from "./render";
import { assertPublicUrl, safeFetch } from "./safeFetch";

/**
 * Gofile（gofile.io/d/ID）の共有フォルダから、ファイルの一覧と直リンクをもらう。
 *
 * Gofile のページは JavaScript で一覧を描き、ファイルのダウンロードには
 * 「ゲスト用の合言葉」（accountToken という Cookie）が必要。
 *
 * フォルダの中身を聞く窓口（api.gofile.io/contents）は、Gofile のサイトからの問い合わせだと示す
 * 「サイト用の合言葉」（X-Website-Token）がないと、だれにでも「有料会員でないと読めません（error-notPremium）」と答える。
 * この合言葉は固定の値から「ブラウザの名前・言語・ゲストの合言葉・時刻（4 時間ごと）から毎回計算する値」に変わった。
 *
 * そこで、次の順に試す：
 *   1. 新しい計算方式の合言葉で聞く（計算に使う秘密の言葉は、Gofile のスクリプトから読む）
 *   2. 昔の固定の合言葉で聞く
 *   3. それでも駄目なら、本物のブラウザで Gofile のページを開き、Gofile 自身のスクリプトが受け取った一覧と
 *      ゲストの合言葉をそのまま使う（Gofile が仕組みをまた変えても、ページが開ける限り動く）
 * もらったゲストの合言葉は MediaItem.cookie で、確認・再生・保存まで持ち回る。
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

export type GofileResult = {
  files: GofileFile[];
  error?: string;
  /** 何が起きたかの記録（API の返事・ブラウザで見えたもの）。読めなかったときに画面へ出し、原因をつきとめる手がかりにする */
  detail?: string;
};

/** 合言葉の計算に使う「ブラウザの名前」と「言語」。問い合わせのときも同じものを名乗る */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const LANG = "en-US";
const FALLBACK_SECRET = "5d4f7g8sd45fd";
const FALLBACK_WT = "4fd6sg89d7s6";

interface Session {
  token: string;
  /** 新しい計算方式の秘密の言葉 */
  secret: string;
  /** 昔の固定の合言葉 */
  wt: string;
  /** うまくいった方式（次からはそれを先に試す） */
  mode?: "hash" | "static";
}

let session: Promise<Session | null> | null = null;
let sessionAt = 0;

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const data = await res.json();
    return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Gofile のスクリプトから、合言葉の作り方（秘密の言葉・昔の固定の合言葉）を読む */
async function readScripts(signal: AbortSignal): Promise<{ secret: string; wt: string }> {
  let secret = FALLBACK_SECRET;
  let wt = FALLBACK_WT;
  const paths = new Set(["/dist/js/global.js", "/dist/js/config.js", "/dist/js/alljs.js", "/dist/js/wt.obf.js"]);
  try {
    const { res } = await safeFetch("https://gofile.io/", { signal, timeoutMs: 6000, headers: { "user-agent": UA } });
    if (res.ok) {
      const html = (await res.text()).slice(0, 500_000);
      for (const m of html.matchAll(/<script[^>]+src=["']([^"']+\.js)[^"']*["']/gi)) {
        if (paths.size >= 10) break;
        try {
          const u = new URL(m[1], "https://gofile.io/");
          if (u.hostname === "gofile.io") paths.add(u.pathname);
        } catch {
          /* ignore */
        }
      }
    } else await res.body?.cancel().catch(() => {});
  } catch {
    /* 決まった場所だけ試す */
  }
  let foundSecret = false;
  let foundWt = false;
  for (const path of paths) {
    if (foundSecret && foundWt) break;
    try {
      const { res } = await safeFetch(`https://gofile.io${path}`, { signal, timeoutMs: 6000, headers: { "user-agent": UA } });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        continue;
      }
      const js = (await res.text()).slice(0, 3_000_000);
      // `${ブラウザ}::${言語}::${合言葉}::${時刻}::秘密の言葉` の最後の部分
      const s = /::\$\{[^}]{1,80}\}::([A-Za-z0-9]{6,40})[`"']/.exec(js) ?? /["'`]::([A-Za-z0-9]{6,40})["'`]/.exec(js);
      if (s && !foundSecret) {
        secret = s[1];
        foundSecret = true;
      }
      const w = /\bwt\s*[:=]\s*["']([A-Za-z0-9]{6,40})["']/.exec(js) ?? /websiteToken["']?\s*[:=]\s*["']([A-Za-z0-9]{6,40})["']/.exec(js);
      if (w && !foundWt) {
        wt = w[1];
        foundWt = true;
      }
    } catch {
      /* 次の場所を試す */
    }
  }
  return { secret, wt };
}

/** アカウント作成の POST は、接続先を確かめたうえで直接送る（safeFetch は GET だけ） */
async function createGuest(signal: AbortSignal): Promise<string | null> {
  const url = "https://api.gofile.io/accounts";
  await assertPublicUrl(url);
  const res = await fetch(url, {
    method: "POST",
    signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
    headers: { "content-type": "application/json", "user-agent": UA, origin: "https://gofile.io", referer: "https://gofile.io/" },
    body: "{}",
    redirect: "error",
  });
  const json = res.ok ? await readJson(res) : null;
  const token = (json?.data as { token?: unknown } | undefined)?.token;
  return typeof token === "string" && token ? token : null;
}

/** ゲスト用の合言葉と、サイト用の合言葉の作り方（同じサーバーが動いている間、1 時間使い回す） */
function getSession(signal: AbortSignal): Promise<Session | null> {
  if (!session || Date.now() - sessionAt > 60 * 60 * 1000) {
    sessionAt = Date.now();
    session = (async () => {
      const [scripts, token] = await Promise.all([readScripts(signal), createGuest(signal).catch(() => null)]);
      return token ? { token, ...scripts } : null;
    })();
    void session.then((s) => !s && (session = null));
  }
  return session;
}

/** 新しい計算方式のサイト用の合言葉（4 時間ごとに変わる） */
export function hashedWebsiteToken(token: string, secret: string, now = Date.now()): string {
  const slot = Math.floor(now / 1000 / 14400);
  return createHash("sha256").update(`${UA}::${LANG}::${token}::${slot}::${secret}`).digest("hex");
}

const VIDEO_NAME_RE = /\.(?:mp4|m4v|mov|webm|mkv|avi|wmv|flv|ts|3gp|mpg|mpeg|ogv)$/i;
const IMAGE_NAME_RE = /\.(?:jpe?g|png|gif|webp|avif|heic|bmp)$/i;

/** 断られた理由を、わかる日本語にする。browser: ブラウザで開いたときに Gofile 自身のページが受け取った状態 */
function describe(status: string, browser?: string): string {
  if (status === "error-passwordRequired") return "パスワード付きの Gofile フォルダは読めません";
  if (status === "error-notFound") return "Gofile のフォルダが見つかりません（削除された可能性があります）";
  if (status === "error-notPremium") {
    if (browser === "error-notPremium") {
      return "Gofile のページ自身の問い合わせも「有料会員のみ」と断られました。このアプリのサーバー（接続元の IP・自動アクセスの判定）がGofile に断られている可能性が高く、合言葉の作り方の問題ではなさそうです";
    }
    if (browser === "error-browser") {
      return "Gofile がこのアプリのサーバーからの問い合わせを断り、ブラウザで開いても一覧を受け取れませんでした（Gofile のページが開けない・仕組みが変わった可能性があります）";
    }
    return "Gofile がこのアプリからの読み込みを断りました";
  }
  return `Gofile が答えませんでした（${status}）`;
}

/** フォルダの中身の返事から、画像・動画のファイルと、中のフォルダを取り出す */
function parseContents(json: Record<string, unknown>, rootId: string, cookie: string): { files: GofileFile[]; nested: string[] } {
  const data = (json.data ?? {}) as Record<string, unknown>;
  const children = (data.children ?? data.contents ?? {}) as Record<string, Record<string, unknown>>;
  const files: GofileFile[] = [];
  const nested: string[] = [];
  // フォルダではなくファイル 1 つの共有リンクのときは、data 自体がファイル
  const entries = data.type === "file" ? [data] : Object.values(children);
  for (const c of entries) {
    if (!c || typeof c !== "object") continue;
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
      pageUrl: `https://gofile.io/d/${rootId}`,
    });
  }
  return { files, nested };
}

/** API に聞く（合言葉の方式を順に試す）。返事の status が ok でなければ、その status を返す */
async function askApi(folder: string, s: Session, signal: AbortSignal): Promise<{ json?: Record<string, unknown>; status: string }> {
  const modes: ("hash" | "static")[] = s.mode === "static" ? ["static", "hash"] : ["hash", "static"];
  let last = "error";
  for (const mode of modes) {
    const wt = mode === "hash" ? hashedWebsiteToken(s.token, s.secret) : s.wt;
    const query = mode === "static" ? `?wt=${encodeURIComponent(s.wt)}&cache=true` : "?cache=true";
    const { res } = await safeFetch(`https://api.gofile.io/contents/${encodeURIComponent(folder)}${query}`, {
      signal,
      timeoutMs: 10000,
      headers: {
        "user-agent": UA,
        authorization: `Bearer ${s.token}`,
        "x-website-token": wt,
        "x-bl": LANG,
        accept: "application/json",
        origin: "https://gofile.io",
        referer: "https://gofile.io/",
      },
    });
    const json = await readJson(res);
    const status = typeof json?.status === "string" ? json.status : `HTTP ${res.status}`;
    if (json && status === "ok") {
      s.mode = mode;
      return { json, status };
    }
    last = status;
    // パスワード付き・見つからないは、方式を変えても同じ
    if (status === "error-passwordRequired" || status === "error-notFound") break;
  }
  return { status: last };
}

/**
 * 本物のブラウザで Gofile のページを開き、Gofile 自身のスクリプトが受け取ったフォルダの中身と、
 * ゲストの合言葉（accountToken の Cookie）をそのまま使う
 */
async function viaBrowser(
  folder: string,
  rootId: string,
  signal: AbortSignal,
): Promise<{ files: GofileFile[]; nested: string[]; status: string; detail: string }> {
  const r = await renderPage(`https://gofile.io/d/${folder}`, signal, Number.POSITIVE_INFINITY, { captureJson: /^https:\/\/api\.gofile\.io\/contents\// }, 20000);
  const cookieToken = r.cookies.find((c) => c.name === "accountToken" && /(?:^|\.)gofile\.io$/.test(c.domain))?.value;
  const hitIndex = r.json.findIndex((j) => (j.data as { status?: unknown } | null)?.status === "ok");
  const hit = hitIndex >= 0 ? (r.json[hitIndex].data as Record<string, unknown>) : undefined;
  // 合言葉は Cookie になければ、ページ自身が一覧を聞いたときに付けた認証ヘッダーから取る
  const token = cookieToken ?? /^Bearer\s+(\S+)/i.exec(hitIndex >= 0 ? (r.json[hitIndex].auth ?? "") : "")?.[1];
  const statuses = r.json.map((j) => (j.data as { status?: unknown } | null)?.status).filter((x): x is string => typeof x === "string");
  // 画面に何が見えたか（読めなかった原因をつきとめる手がかり）
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(r.html)?.[1]?.replace(/\s+/g, " ").trim().slice(0, 50) ?? "";
  const text = r.html
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
  const detail =
    `ブラウザ：ページ HTTP ${r.status}・題名「${title}」・Gofile への問い合わせ ${r.json.length} 件（${statuses.join(",") || "返事なし"}）・` +
    `合言葉 ${cookieToken ? "Cookie" : token ? "認証ヘッダー" : "なし"}・画面の文字「${text}」`;
  if (!hit || !token) return { files: [], nested: [], status: statuses.find((x) => x !== "ok") ?? "error-browser", detail };
  return { ...parseContents(hit, rootId, `gofile.io|accountToken=${token}`), status: "ok", detail };
}

/** フォルダの中身を聞く（中のフォルダも 2 段まで。ファイルは 300 個まで） */
export async function gofileFiles(id: string, signal: AbortSignal): Promise<GofileResult> {
  const s = await getSession(signal).catch(() => null);
  const files: GofileFile[] = [];
  let error: string | undefined;
  /** API が断るので、ブラウザで開く（一度断られたら、中のフォルダもブラウザで開く。3 回まで） */
  let useBrowser = !s;
  let browserOpens = 0;
  /** ブラウザで開いたとき Gofile 自身のページが受け取った状態（"ok" 以外の status・何も届かなかったときは "error-browser"） */
  let browserStatus: string | undefined;
  const notes: string[] = [];
  const visit = async (folder: string, level: number) => {
    if (level > 2 || files.length >= 300 || signal.aborted) return;
    let found: { files: GofileFile[]; nested: string[] } | null = null;
    let status = "error";
    if (!useBrowser && s) {
      const api = await askApi(folder, s, signal).catch(() => ({ status: "error-network" }) as { json?: Record<string, unknown>; status: string });
      status = api.status;
      notes.push(`API：${api.status}（${s.mode ?? "方式不明"}）`);
      if (api.json) found = parseContents(api.json, id, `gofile.io|accountToken=${s.token}`);
      else if (status !== "error-passwordRequired" && status !== "error-notFound") useBrowser = true;
    }
    if (!found && useBrowser && browserOpens < 3) {
      browserOpens++;
      const b = await viaBrowser(folder, id, signal).catch((err) => ({
        files: [] as GofileFile[],
        nested: [] as string[],
        status: "error-browser",
        detail: `ブラウザで開けませんでした（${err instanceof Error ? err.message.slice(0, 80) : String(err)}）`,
      }));
      notes.push(b.detail);
      browserStatus = b.status;
      status = b.status === "error-browser" ? status : b.status;
      if (b.status === "ok") found = b;
    }
    if (!found) {
      error ??= describe(status, browserStatus);
      return;
    }
    files.push(...found.files.slice(0, 300 - files.length));
    for (const n of found.nested) await visit(n, level + 1);
  };
  try {
    await visit(id, 0);
  } catch {
    error ??= "Gofile に接続できませんでした";
  }
  return { files, error: files.length ? undefined : error, detail: files.length ? undefined : notes.join(" ／ ").slice(0, 600) };
}
