import "server-only";
import { getSession, dropSession } from "./browserSession";
import { thumbsLog } from "./safeFetch";

/**
 * Gofile（gofile.io/d/ID）の共有フォルダから、ファイルの一覧と直リンクをもらう。
 *
 * Gofile のフォルダの中身を聞く窓口（api.gofile.io/contents）は、
 *   - アカウントの合言葉（ゲストでもよい）
 *   - Gofile のサイト自身のスクリプト（wt.obf.js）が毎回計算する「サイト用の合言葉」
 * の両方がないと答えない。サイト用の合言葉の作り方は定期的に入れ替えられ、
 * 古い作り方で聞くと、聞いた側の接続元がその場で止められる（しばらく何を聞いても 429・401 になる）。
 *
 * そのため、合言葉をこちらで計算することはしない。本物のブラウザで Gofile のページを 1 枚開いたままにして、
 * そのページの中で Gofile 自身のスクリプトに合言葉を作らせ、ページの中から窓口に聞く（Gofile のサイトと同じ動き）。
 * 聞く間隔は 1 秒以上あける。止められたとわかったら、しばらく聞くのをやめる。
 * もらった合言葉は MediaItem.cookie で、確認・再生・保存まで持ち回る。
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

const VIDEO_NAME_RE = /\.(?:mp4|m4v|mov|webm|mkv|avi|wmv|flv|ts|3gp|mpg|mpeg|ogv)$/i;
const IMAGE_NAME_RE = /\.(?:jpe?g|png|gif|webp|avif|heic|bmp)$/i;

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


/** Gofile に止められた（聞きすぎ・接続元の制限）ときに、次に聞いてよい時刻 */
let blockedUntil = 0;
let blockedWhy = "";
/** 前に聞いた時刻（間隔をあけるため） */
let lastAsk = 0;
/** 順番に 1 件ずつ聞くための列 */
let chain: Promise<unknown> = Promise.resolve();
/** ゲストの合言葉（同じサーバーが動いている間、1 時間使い回す） */
let guest: { token: string; at: number } | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ORIGIN = "https://gofile.io";

interface Answer {
  http: number;
  status: string;
  json: Record<string, unknown> | null;
  why?: string;
}

/** ページの中で実行する：Gofile 自身のスクリプトに合言葉を作らせて、フォルダの中身を聞く */
const ASK = async (folder: string, token: string): Promise<Answer> => {
  try {
    const generate = (globalThis as unknown as { generateWT?: (t: string) => Promise<string> | string }).generateWT;
    if (typeof generate !== "function") return { http: 0, status: "error-noGenerator", json: null };
    const wt = await generate(token);
    const query = new URLSearchParams({ page: "1", pageSize: "1000", sortField: "name", sortDirection: "1" });
    const res = await fetch(`https://api.gofile.io/contents/${encodeURIComponent(folder)}?${query}`, {
      headers: { Authorization: `Bearer ${token}`, "X-Website-Token": wt, "X-BL": navigator.language || "" },
    });
    const json = await res.json().catch(() => null);
    return { http: res.status, status: (json && typeof json.status === "string" && json.status) || `HTTP ${res.status}`, json };
  } catch (e) {
    return { http: 0, status: "error-network", json: null, why: String(e).slice(0, 120) };
  }
};

/** ページの中で実行する：ゲストのアカウントを作る（Gofile のサイトが初めて開かれたときにするのと同じ） */
const MAKE_GUEST = async (): Promise<{ http: number; status: string; token: string | null }> => {
  try {
    const res = await fetch("https://api.gofile.io/accounts", { method: "POST" });
    const json = await res.json().catch(() => null);
    const token = json?.data?.token;
    return { http: res.status, status: (json && typeof json.status === "string" && json.status) || `HTTP ${res.status}`, token: typeof token === "string" ? token : null };
  } catch {
    return { http: 0, status: "error-network", token: null };
  }
};

/** 断られた理由を、わかる日本語にする */
function describe(status: string): string {
  if (status === "error-passwordRequired") return "パスワード付きの Gofile フォルダは読めません";
  if (status === "error-notFound") return "Gofile のフォルダが見つかりません（削除された可能性があります）";
  if (status === "error-notPremium") return "この Gofile フォルダは、有料会員でないと読めない設定です";
  if (status === "error-rateLimit" || status === "HTTP 429" || status === "error-blocked") {
    return "Gofile が、このアプリのサーバーからの問い合わせを一時的に止めています（短い時間に聞きすぎたため）。10 分ほど待ってから、もう一度取得してください";
  }
  if (status === "error-token" || status === "error-wrongToken" || status === "HTTP 401") {
    return "Gofile が合言葉（アカウントトークン）を受け付けませんでした。「🔑 Gofile の設定」のトークンが正しいか確かめてください（空にするとゲストとして読みます）";
  }
  if (status === "error-guest") return "Gofile がゲスト登録を断りました。Gofile の無料アカウントの「Account Token」を「🔑 Gofile の設定」に入れると読めます";
  if (status === "error-browser" || status === "error-noGenerator") return "Gofile のページをブラウザで開けませんでした（少し待ってから、もう一度取得してください）";
  if (status === "error-empty") return "この Gofile フォルダに画像・動画はありませんでした";
  if (status === "error-time") return "時間が足りず、Gofile を読めませんでした（「続きから」でもう一度試してください）";
  return `Gofile が答えませんでした（${status}）`;
}

/** 1 件ずつ、1.2 秒以上あけて聞く */
function paced<T>(run: () => Promise<T>): Promise<T> {
  const job = chain.then(async () => {
    const wait = lastAsk + 1200 - Date.now();
    if (wait > 0) await sleep(wait);
    lastAsk = Date.now();
    return run();
  });
  chain = job.catch(() => {});
  return job;
}

/** フォルダの中身を聞く（中のフォルダも 2 段まで。ファイルは 300 個まで） */
export async function gofileFiles(id: string, signal: AbortSignal, givenToken?: string, allowBrowser = true): Promise<GofileResult> {
  const fixed = givenToken || process.env.GOFILE_TOKEN?.trim() || undefined;
  const notes: string[] = [];
  const fail = (status: string): GofileResult => {
    const error = describe(status);
    thumbsLog(`gofile ${id} files=0 ${status} ${notes.join(" ／ ").slice(0, 300)}`);
    return { files: [], error, detail: notes.join(" ／ ").slice(0, 600) || undefined };
  };
  if (Date.now() < blockedUntil) {
    notes.push(`止められています（あと ${Math.ceil((blockedUntil - Date.now()) / 60000)} 分・${blockedWhy}）`);
    return fail("error-blocked");
  }
  if (!allowBrowser) return fail("error-time");

  // Gofile のページを開いたままにしたもの（Gofile 自身のスクリプトが読み込まれている）
  const page = await getSession(ORIGIN, `${ORIGIN}/`, signal, true);
  if (!page) return fail("error-browser");
  const ready = await page
    .waitForFunction(() => typeof (globalThis as unknown as { generateWT?: unknown }).generateWT === "function", { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  if (!ready) {
    dropSession(ORIGIN);
    return fail("error-noGenerator");
  }

  let token = fixed;
  if (!token) {
    if (!guest || Date.now() - guest.at > 60 * 60 * 1000) {
      const made = await paced(() => page.evaluate(MAKE_GUEST)).catch(() => ({ http: 0, status: "error-network", token: null }));
      notes.push(`ゲスト登録：${made.status}`);
      if (!made.token) {
        if (made.http === 429) {
          blockedUntil = Date.now() + 10 * 60 * 1000;
          blockedWhy = "ゲスト登録で 429";
        }
        return fail(made.http === 429 ? "error-rateLimit" : "error-guest");
      }
      guest = { token: made.token, at: Date.now() };
    }
    token = guest.token;
  } else notes.push("設定したトークンを使用");

  const files: GofileFile[] = [];
  let firstError: string | undefined;
  const cookie = `gofile.io|accountToken=${token}`;
  const visit = async (folder: string, level: number) => {
    if (level > 2 || files.length >= 300 || signal.aborted || Date.now() < blockedUntil) return;
    const answer = await paced(() => page.evaluate(ASK, folder, token!)).catch(
      (err): Answer => ({ http: 0, status: "error-browser", json: null, why: err instanceof Error ? err.message.slice(0, 100) : String(err) }),
    );
    notes.push(`${folder}：HTTP ${answer.http}・${answer.status}${answer.why ? `（${answer.why}）` : ""}`);
    if (answer.status !== "ok" || !answer.json) {
      // 聞きすぎ・接続元を止められた。続けて聞くと長引くので、10 分は聞かない
      if (answer.http === 429 || answer.status === "error-rateLimit") {
        blockedUntil = Date.now() + 10 * 60 * 1000;
        blockedWhy = `${answer.status}`;
      }
      // ゲストの合言葉が使えなくなっていたら、次は作り直す
      if (!fixed && (answer.http === 401 || /token/i.test(answer.status))) guest = null;
      firstError ??= answer.status;
      return;
    }
    const data = (answer.json.data ?? {}) as Record<string, unknown>;
    if (data.canAccess === false) {
      firstError ??= data.password || data.passwordStatus ? "error-passwordRequired" : "error-notPremium";
      return;
    }
    const found = parseContents(answer.json, id, cookie);
    files.push(...found.files.slice(0, 300 - files.length));
    for (const n of found.nested) await visit(n, level + 1);
  };
  try {
    await visit(id, 0);
  } catch {
    firstError ??= "error-browser";
  }
  if (!files.length) return fail(firstError ?? "error-empty");
  thumbsLog(`gofile ${id} files=${files.length} ${notes.join(" ／ ").slice(0, 300)}`);
  return { files };
}
