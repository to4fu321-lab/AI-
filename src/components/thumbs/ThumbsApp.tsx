"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CrawlEvent, CrawlState, MediaItem } from "@/lib/thumbs/types";
import { getVideoDuration, getVideoThumb, peekVideoDuration, peekVideoThumb } from "./videoThumb";
import { formatDuration } from "@/lib/thumbs/duration";
import { dedupeMedia, mediaKey, SeenMedia } from "@/lib/thumbs/dedupe";
import { isItemExcluded, MAX_EXCLUDES, normalizeRule } from "@/lib/thumbs/exclude";
import { videoApiUrls } from "@/lib/thumbs/videoApis";
import { reviveKeyOf } from "@/lib/thumbs/reviveKey";
import { Library, MAX_HISTORY, MAX_SITES, type CrawlSettings, type HistoryEntry, type SavedSite } from "./Library";

/** 一覧の 1 件。どの入力 URL（ジョブ）から見つかったかを覚えておく */
/** addedAt：この一覧に加わった時刻（今回の取得で増えたものに NEW の印を付ける） */
type Item = MediaItem & {
  jobId: string;
  addedAt?: number;
  /** リンク切れと確かめた時刻。一覧には残し（⚠ の印）、消すのは手動 */
  dead?: number;
  /** リンク切れから、同じ動画が見つかって生き返った時刻 */
  revivedAt?: number;
  /** 「復活したら保存」の見張りの鍵（付けたときのもの。URL が変わっても同じ見張りを指すように覚えておく） */
  rk?: string;
};

/** 見張りの鍵（付けたときの鍵があればそれ。なければ指紋、指紋もなければファイルの URL から） */
const rkOf = (item: Item): string | undefined => item.rk ?? reviveKeyOf(item);

/** 「復活したら保存」の見張り（サーバーが覚えているもの） */
type ReviveRow = {
  fp: string;
  status: "watch" | "found" | "saving" | "saved" | "failed";
  title: string | null;
  thumb: string | null;
  size: number | null;
  note: string | null;
  savedAt: number | null;
  foundAt: number | null;
  /** Google ドライブに保存したときの、ドライブのファイルの番号 */
  driveId?: string | null;
};

/** 保存先の Google ドライブの状態 */
type DriveInfo = { configured: boolean; connected: boolean; email?: string; database?: boolean; redirectUri?: string };

/** 保存した動画の窓口 */
const savedUrl = (fp: string, download = false) => `/api/thumbs/revive/file?${new URLSearchParams({ fp, ...(download ? { dl: "1" } : {}) })}`;

/**
 * 届いた画像・動画のうち、リンク切れの印の付いたものと同じもの（同じ指紋＝同じファイル・同じファイルの URL）は、
 * 新しく足さずに、その印の付いたものを生き返らせる（場所・見張りの設定はそのまま、URL だけ新しいものにする）
 */
function reviveArrivals(prev: Item[], incoming: MediaItem[], stamp: number): { list: Item[]; rest: MediaItem[] } {
  const deadAt = new Map<string, number>();
  prev.forEach((it, idx) => {
    if (!it.dead) return;
    deadAt.set(`k:${mediaKey(it)}`, idx);
    if (it.fp) deadAt.set(`f:${it.fp}`, idx);
  });
  if (!deadAt.size) return { list: prev, rest: incoming };
  let list = prev;
  const rest: MediaItem[] = [];
  for (const m of incoming) {
    let idx = m.fp ? deadAt.get(`f:${m.fp}`) : undefined;
    if (idx === undefined) idx = deadAt.get(`k:${mediaKey(m)}`);
    if (idx === undefined || !m.checked) {
      rest.push(m);
      continue;
    }
    if (list === prev) list = [...prev];
    const old = list[idx];
    list[idx] = {
      ...old,
      src: m.src,
      thumb: m.thumb ?? old.thumb,
      pageUrl: m.pageUrl,
      referer: m.referer,
      cookie: m.cookie,
      format: m.format ?? old.format,
      duration: m.duration ?? old.duration,
      fp: m.fp ?? old.fp,
      checked: stamp,
      dead: undefined,
      revivedAt: stamp,
      addedAt: stamp,
    };
    deadAt.delete(`k:${mediaKey(old)}`);
    if (old.fp) deadAt.delete(`f:${old.fp}`);
  }
  return { list, rest };
}

interface Job {
  id: string;
  url: string;
  status: "running" | "done" | "error" | "stopped";
  pages: number;
  errors: number;
  /** 読まずに飛ばしたページ数（robots.txt・除外リストなど） */
  skips?: number;
  message?: string;
  truncated?: boolean;
  /** 取れなかった理由などの補足 */
  note?: string;
  /** 確認を求められて読めなかったページ（サイトを本人のブラウザで開いてもらう） */
  gated?: Gated[];
  /** この取得の「サイトで開く」のタイルを畳んでいるか */
  folded?: boolean;
  settings?: CrawlSettings;
  /** 最後に受け取った途中経過。止まったときは「続きから」でここから再開する */
  resume?: CrawlState;
}

type Filter = "all" | "image" | "video" | "new" | "dead";

/** X の投稿の番号（投稿の URL・番号の入った保存サイトの URL から。なければ null） */
const tweetIdIn = (url: string): string | null =>
  /(?:twitter|x)\.com\/[^/?#]+\/status(?:es)?\/(\d{8,20})/.exec(url)?.[1] ?? /\/(\d{18,19})(?:[/?#]|$)/.exec(url)?.[1] ?? null;
/** ページの URL を比べやすい形にする（# より後ろと、最後の / を外す） */
const pageKey = (url: string) => url.replace(/#.*$/, "").replace(/\/+$/, "");

/**
 * 前に動画が見つかったページと X の投稿の番号。
 * 取得のとき「読み直さなくてよいもの」としてサーバーに渡し、新しく増えたページだけを読んでもらう。
 * 新しいものから、それぞれ 3000 件まで
 */
function knownOf(items: Item[]): { pages: string[]; tweets: string[] } {
  const pages = new Set<string>();
  const tweets = new Set<string>();
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "image") continue;
    const t = /(?:twitter|x)\.com\/[^/?#]+\/status(?:es)?\/(\d{8,20})/.exec(it.pageUrl)?.[1];
    if (t) {
      if (tweets.size < 3000) tweets.add(t);
    } else if (pages.size < 3000) pages.add(it.pageUrl);
    if (pages.size >= 3000 && tweets.size >= 3000) break;
  }
  return { pages: [...pages], tweets: [...tweets] };
}

const STORAGE_KEY = "thumbs:v1";
/** 履歴と登録サイトは「すべて消す」をしても残すので、別の場所に保存する */
const LIBRARY_KEY = "thumbs:library:v1";
const MAX_ITEMS = 5000;
/** 「サイトで開く」に並べるページの数の上限（1 つの取得あたり） */
const MAX_GATED = 2000;

/** 確認を求められて読めなかったページ。video があれば、タップでその動画ファイルを開く */
type Gated = { url: string; thumb?: string; duration?: number; video?: string; title?: string; app?: string; at?: number };

const clock = (sec: number) => {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
};
/** 一覧の見た目（サムネイルの大きさ・形）の保存場所 */
const VIEW_KEY = "thumbs:view:v1";
/** 「さらに深く探す」を自動で続ける回数の保存場所 */
const ROUNDS_KEY = "thumbs:rounds:v1";
/** 読んだ Gofile のフォルダ（番号 → 読んだ時刻）の保存場所。3 日たったら忘れる */
const GOFILE_KNOWN_KEY = "thumbs:gofile-known:v1";
const GOFILE_KNOWN_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_GOFILE_KNOWN = 5000;
/** 登録サイトの自動巡回（間隔の分・最後に巡回した時刻）の保存場所 */
const PATROL_KEY = "thumbs:patrol:v1";
/** サーバーの自動巡回の結果を、どの時刻の分まで受け取ったかの保存場所 */
const PATROL_SEEN_KEY = "thumbs:patrol-seen:v1";
/** メニュー・取得の一覧を畳んでいるかの保存場所 */
const FOLD_KEY = "thumbs:fold:v1";
/** 「探す」で使わない置き場・検索先の保存場所 */
const HUNT_OFF_KEY = "thumbs:huntoff:v1";
/** 「ファイル置き場を探す」で探す置き場 */
const HUNT_HOSTS = ["Gofile", "pixeldrain", "Google ドライブ", "Dropbox", "catbox"];
/** 「探す」で使う検索先（id と画面に出す名前） */
const HUNT_ENGINES: [string, string][] = [
  ["x", "X の投稿（Yahoo! リアルタイム）"],
  ["yahoo", "Yahoo!"],
  ["yvideo", "Yahoo! 動画検索"],
  ["bing", "Bing"],
  ["5ch", "5ちゃんねる"],
  ["hatena", "はてなブックマーク"],
  ["naver", "Naver"],
  ["seznam", "Seznam"],
  ["sogou", "Sogou"],
  ["dailymotion", "Dailymotion（公式の検索）"],
  ["nico", "ニコニコ動画（公式の検索）"],
  ["archive", "Internet Archive（公式の検索）"],
  ["mastodon", "Mastodon（mstdn.jp のタグ）"],
];
/** 検索の URL が、どの検索先のものか */
function engineOf(url: string): string {
  try {
    const u = new URL(url);
    const h = u.hostname;
    if (h.includes("yahoo")) return u.pathname.startsWith("/realtime") ? "x" : u.pathname.startsWith("/video") ? "yvideo" : "yahoo";
    for (const id of ["bing", "5ch", "hatena", "naver", "seznam", "sogou", "dailymotion"]) if (h.includes(id)) return id;
    if (h.includes("nicovideo")) return "nico";
    if (h === "archive.org") return "archive";
    if (u.pathname.includes("/api/v1/timelines/tag/")) return "mastodon";
  } catch {
    /* 下へ */
  }
  return "";
}
/** サムネイルの大きさ（1 枚の最小の幅 px）。画面の幅に合わせて、入るだけ並べる */
const TILE_SIZES = [56, 76, 100, 130, 170, 220, 300, 420, 640];
const DEFAULT_TILE = 2;
type Shape = "square" | "wide";

class ServerError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
  }
}

/** ブラウザの英語のエラーを、何が起きたかわかる日本語にする */
function describeError(err: unknown): string {
  if (err instanceof ServerError) {
    return err.status === 504
      ? "サーバーの処理が時間切れになりました。もう一度お試しください"
      : `サーバーでエラーが起きました（HTTP ${err.status}）`;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/load failed|failed to fetch|networkerror|network|stream cut|terminated|aborted/i.test(message)) {
    return "通信が切れました（アプリの切り替え・画面オフ・電波・サーバーの時間切れなど）。再接続も失敗しました";
  }
  return message;
}

export function proxyUrl(
  item: Pick<MediaItem, "src" | "pageUrl" | "referer" | "cookie">,
  opts: { download?: boolean; name?: string } = {},
) {
  // iframe の中のプレーヤーで見つけた動画は、そのプレーヤーのページを Referer にしないと断られることがある
  const p = new URLSearchParams({ url: item.src, ref: item.referer ?? item.pageUrl });
  // Gofile などの合言葉（Cookie）が要るファイルは、それも中継に渡す
  if (item.cookie) p.set("ck", item.cookie);
  if (opts.download) p.set("dl", "1");
  if (opts.name) p.set("name", opts.name);
  return `/api/thumbs/media?${p}`;
}

/** 確かめてからこの時間がたったものは、確かめ直してから表示する（期限付きの URL が切れることがあるため） */
const CHECK_FRESH_MS = 24 * 60 * 60 * 1000;

/** リンク切れでないと、最近確かめてあるか */
const isFresh = (item: MediaItem, now: number) => typeof item.checked === "number" && now - item.checked < CHECK_FRESH_MS;

type LinkState = "yes" | "no" | "unknown";

/**
 * リンク切れの確認（サーバーに聞く）。同時に 4 件まで。結果はこの画面を開いている間だけ覚えておく。
 * 以前に取得して保存してあった画像・動画を、表示する前に確かめ直すのに使う
 */
const linkChecks = new Map<string, Promise<LinkState>>();
let checking = 0;
const checkWaiters: (() => void)[] = [];
function checkLink(item: MediaItem): Promise<LinkState> {
  let job = linkChecks.get(item.src);
  if (!job) {
    job = (async (): Promise<LinkState> => {
      while (checking >= 4) await new Promise<void>((r) => checkWaiters.push(r));
      checking++;
      try {
        const p = new URLSearchParams({ url: item.src, ref: item.referer ?? item.pageUrl, check: "1", kind: item.kind });
        if (item.cookie) p.set("ck", item.cookie);
        const res = await fetch(`/api/thumbs/media?${p}`);
        if (!res.ok) return "unknown";
        const alive = (await res.json()).alive;
        return alive === "yes" || alive === "no" ? alive : "unknown";
      } catch {
        return "unknown";
      } finally {
        checking--;
        checkWaiters.shift()?.();
      }
    })();
    linkChecks.set(item.src, job);
    // 確かめられなかったものは、次に聞かれたらもう一度試す
    void job.then((r) => r === "unknown" && linkChecks.delete(item.src));
  }
  return job;
}

const isHls = (item: MediaItem) => /\.m3u8(\?|$)/i.test(item.src) || item.format === "M3U8";
const isVideoLike = (item: MediaItem) => item.kind !== "image";

/** 直接ダウンロードで、端末のメモリに貯めてよい上限（これより大きいものは、保存先を選べるとき以外はサーバー経由にする） */
const DIRECT_MEMORY_MAX = 400 * 1024 * 1024;

/** ファイルを端末に保存させる（URL を a[download] で開く） */
function triggerDownload(href: string, name?: string) {
  const a = document.createElement("a");
  a.href = href;
  if (name) a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * 元のサイトから直接、端末にダウンロードする（Vercel のサーバーを通さないので、転送量がかからない）。
 * ブラウザが別のサイトのファイルを読めるのは、そのサイトが許可（CORS）を出しているときだけ。
 * 許可がない・合言葉（Cookie）が要る・大きすぎるときは false を返す（呼び出し元がサーバー経由に切り替える）
 */
async function downloadDirect(item: MediaItem, name: string | undefined, onProgress: (ratio: number | null) => void): Promise<boolean | "canceled"> {
  if (item.cookie) return false; // Gofile などの合言葉は、ブラウザからは送れない
  let res: Response;
  try {
    res = await fetch(item.src, { mode: "cors", credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(20000) });
  } catch {
    return false; // 許可（CORS）がない・つながらない
  }
  if (!res.ok || !res.body) return false;
  const type = res.headers.get("content-type") ?? "";
  if (/text\/html|json/i.test(type)) {
    await res.body.cancel().catch(() => {});
    return false; // 動画ではなくページが返ってきた（ログイン画面など）
  }
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  // パソコンの Chrome などは、保存先を選んでそこへ少しずつ書ける（メモリに貯めない）
  const picker = (window as unknown as { showSaveFilePicker?: (o: { suggestedName?: string }) => Promise<{ createWritable: () => Promise<WritableStreamDefaultWriter<Uint8Array> & { write: (c: Uint8Array) => Promise<void>; close: () => Promise<void> }> }> }).showSaveFilePicker;
  if (picker) {
    let handle;
    try {
      handle = await picker({ suggestedName: name });
    } catch {
      await reader.cancel().catch(() => {});
      return "canceled"; // 保存先選びを取り消した（サーバー経由にも切り替えない）
    }
    const out = await handle.createWritable();
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await out.write(value);
      got += value.byteLength;
      onProgress(total ? got / total : null);
    }
    await out.close();
    return true;
  }
  if (total > DIRECT_MEMORY_MAX) {
    await reader.cancel().catch(() => {});
    return false;
  }
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.byteLength;
    if (got > DIRECT_MEMORY_MAX) {
      await reader.cancel().catch(() => {});
      return false;
    }
    onProgress(total ? got / total : null);
  }
  const url = URL.createObjectURL(new Blob(parts as BlobPart[], { type: type || "application/octet-stream" }));
  triggerDownload(url, name);
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return true;
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function ThumbsApp() {
  const [input, setInput] = useState("");
  const [depth, setDepth] = useState(1);
  const [maxPages, setMaxPages] = useState(100);
  const [maxPagination, setMaxPagination] = useState(50);
  const [crossSite, setCrossSite] = useState(false);
  const [render, setRender] = useState<"auto" | "always" | "off">("auto");
  const [kinds, setKinds] = useState<"all" | "video" | "image">("all");
  const [robots, setRobots] = useState(true);
  /** 「Gofile をネット全体から探す」のキーワード（空でもよい） */
  const [huntWord, setHuntWord] = useState("");
  /** 検索から探すとき、ひととおり終わった後に「さらに深く探す」を自動で何回続けるか */
  const [huntRounds, setHuntRounds] = useState(2);
  /** 読んだ Gofile のフォルダ（番号 → 読んだ時刻）。次からは聞かない（Gofile への問い合わせを減らす） */
  const gofileKnown = useRef(new Map<string, number>());
  const [knownCount, setKnownCount] = useState(0);
  const saveKnown = useCallback(() => {
    const m = gofileKnown.current;
    setKnownCount(m.size);
    try {
      localStorage.setItem(GOFILE_KNOWN_KEY, JSON.stringify([...m].slice(-MAX_GOFILE_KNOWN)));
    } catch {
      /* 保存できなくても動く */
    }
  }, []);
  const forgetKnown = useCallback(() => {
    gofileKnown.current = new Map();
    saveKnown();
  }, [saveKnown]);
  /** 登録サイトの自動巡回の間隔（分。0 はなし）と、最後に巡回した時刻 */
  const [patrolMin, setPatrolMin] = useState(0);
  const patrolLast = useRef(0);
  const [patrolAt, setPatrolAt] = useState(0);
  /** 畳んでいるもの（メニュー・取得の一覧）。この端末に保存する */
  const [menuOpen, setMenuOpen] = useState(true);
  const [jobsOpen, setJobsOpen] = useState(true);
  const toggleFold = (which: "menu" | "jobs") => {
    const next = { menu: which === "menu" ? !menuOpen : menuOpen, jobs: which === "jobs" ? !jobsOpen : jobsOpen };
    setMenuOpen(next.menu);
    setJobsOpen(next.jobs);
    try {
      localStorage.setItem(FOLD_KEY, JSON.stringify(next));
    } catch {
      /* 保存できなくても動く */
    }
  };
  /** 「探す」で使わない置き場・検索先（設定で外したもの） */
  const [huntOff, setHuntOff] = useState<string[]>([]);
  const toggleHunt = (id: string) =>
    setHuntOff((list) => {
      const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
      try {
        localStorage.setItem(HUNT_OFF_KEY, JSON.stringify(next));
      } catch {
        /* 保存できなくても動く */
      }
      return next;
    });
  const [jobs, setJobs] = useState<Job[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [jobFilter, setJobFilter] = useState<string | null>(null);
  // 拡大表示しているもの（id で覚える。新しいものが上に足されても、見ているものが入れ替わらないように）
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [sites, setSites] = useState<SavedSite[]>([]);
  const [excludes, setExcludes] = useState<string[]>([]);
  /** Gofile のアカウントトークン（この端末だけに保存。取得のときにサーバーへ送る） */
  const [gofileToken, setGofileToken] = useState("");
  const gofileTokenRef = useRef("");
  useEffect(() => {
    gofileTokenRef.current = gofileToken;
  }, [gofileToken]);
  const [now, setNow] = useState(0);
  /** 一番最近の取得（もっと読み込むを含む）を始めた時刻。これより後に加わったものに NEW の印を付ける */
  const [newSince, setNewSince] = useState(0);
  const newSinceRef = useRef(0);
  const [tile, setTile] = useState(DEFAULT_TILE);
  const [shape, setShape] = useState<Shape>("square");
  const controllers = useRef(new Map<string, AbortController>());
  // 取得中にリストを変えても、次の通信から最新のリストが使われるよう ref にも持つ
  const excludesRef = useRef<string[]>([]);
  useEffect(() => {
    excludesRef.current = excludes;
  }, [excludes]);
  const loaded = useRef(false);

  // --- 前回の一覧を復元 / 保存（ブラウザの localStorage） ---
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
      // サーバー描画と食い違わないよう、保存データの復元は表示後に 1 回だけ行う
      // 以前の取得で同じ動画が 2 個入っていたら、ここで 1 個にまとめる
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (saved?.items) setItems(dedupeMedia(saved.items as Item[]));
      if (typeof saved?.newSince === "number") {
        setNewSince(saved.newSince);
        newSinceRef.current = saved.newSince;
      }
      if (saved?.jobs) setJobs(saved.jobs.map((j: Job) => (j.status === "running" ? { ...j, status: "stopped" } : j)));
      const library = JSON.parse(localStorage.getItem(LIBRARY_KEY) ?? "null");
      if (Array.isArray(library?.history)) setHistory(library.history);
      if (Array.isArray(library?.sites)) setSites(library.sites.slice(0, MAX_SITES));
      if (Array.isArray(library?.excludes)) setExcludes(library.excludes.slice(0, MAX_EXCLUDES));
      if (typeof library?.gofileToken === "string") setGofileToken(library.gofileToken);
      const view = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "null");
      if (typeof view?.tile === "number") setTile(Math.min(TILE_SIZES.length - 1, Math.max(0, Math.round(view.tile))));
      if (view?.shape === "wide" || view?.shape === "square") setShape(view.shape);
      const off = JSON.parse(localStorage.getItem(HUNT_OFF_KEY) ?? "[]");
      if (Array.isArray(off)) setHuntOff(off.filter((x): x is string => typeof x === "string").slice(0, 30));
      const fold = JSON.parse(localStorage.getItem(FOLD_KEY) ?? "null");
      if (fold?.menu === false) setMenuOpen(false);
      if (fold?.jobs === false) setJobsOpen(false);
      const known = JSON.parse(localStorage.getItem(GOFILE_KNOWN_KEY) ?? "[]");
      if (Array.isArray(known)) {
        const fresh = known.filter((e): e is [string, number] => Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "number" && Date.now() - e[1] < GOFILE_KNOWN_MS);
        gofileKnown.current = new Map(fresh);
        setKnownCount(fresh.length);
      }
      const patrol = JSON.parse(localStorage.getItem(PATROL_KEY) ?? "null");
      if (typeof patrol?.min === "number" && patrol.min >= 0 && patrol.min <= 1440) setPatrolMin(patrol.min);
      if (typeof patrol?.last === "number") {
        patrolLast.current = patrol.last;
        setPatrolAt(patrol.last);
      }
      const rounds = Number(localStorage.getItem(ROUNDS_KEY));
      if (localStorage.getItem(ROUNDS_KEY) !== null && rounds >= 0 && rounds <= 20) setHuntRounds(Math.round(rounds));
    } catch {
      /* ignore */
    }
    setNow(Date.now());
    loaded.current = true;
  }, []);
  // 一覧の保存。変化が続く間は 0.5 秒待ってまとめて保存し、画面が隠れる（アプリ切り替え・閉じる）ときはすぐ保存する
  const latest = useRef({ items, jobs });
  /** 取得の中から一覧を見るための別名（取得の中では latest が途中経過の名前に使われているため） */
  const listNow = latest;
  const dirty = useRef(false);
  const saveNow = useCallback(() => {
    if (!loaded.current || !dirty.current) return;
    dirty.current = false;
    try {
      // 途中経過は大きいので、新しい 5 件のジョブ分だけ保存する
      let kept = 0;
      const slimJobs = latest.current.jobs.map((j) => (j.resume && kept++ < 5 ? j : { ...j, resume: undefined }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ items: latest.current.items.slice(0, MAX_ITEMS), jobs: slimJobs, newSince: newSinceRef.current }));
    } catch {
      /* 容量オーバーなどは無視 */
    }
  }, []);
  useEffect(() => {
    if (!loaded.current) return;
    latest.current = { items, jobs };
    dirty.current = true;
    const t = setTimeout(saveNow, 500);
    return () => clearTimeout(t);
  }, [items, jobs, saveNow]);
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") saveNow();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", saveNow);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", saveNow);
    };
  }, [saveNow]);
  useEffect(() => {
    if (!loaded.current) return;
    try {
      localStorage.setItem(LIBRARY_KEY, JSON.stringify({ history, sites, excludes, gofileToken }));
    } catch {
      /* ignore */
    }
  }, [history, sites, excludes, gofileToken]);
  useEffect(() => {
    if (!loaded.current) return;
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify({ tile, shape }));
    } catch {
      /* ignore */
    }
  }, [tile, shape]);

  /** 履歴の先頭に入れる（同じ URL があれば置き換え） */
  const recordHistory = useCallback((entry: HistoryEntry) => {
    setHistory((list) => [entry, ...list.filter((h) => h.url !== entry.url)].slice(0, MAX_HISTORY));
  }, []);

  const updateJob = useCallback((id: string, patch: Partial<Job> | ((j: Job) => Partial<Job>)) => {
    setJobs((list) => list.map((j) => (j.id === id ? { ...j, ...(typeof patch === "function" ? patch(j) : patch) } : j)));
  }, []);

  const startJob = useCallback(
    async (url: string, override?: CrawlSettings, existing?: { job: Job; found: number }, html?: string) => {
      let settings: CrawlSettings = existing?.job.settings ?? override ?? { depth, maxPages, maxPagination, crossSite, render, kinds, robots };
      // ページ数の上限で打ち切ったものを続けるときは、同じページ数だけ上限を足す
      if (existing?.job.truncated && existing.job.resume) {
        settings = { ...settings, maxPages: Math.min(1000, existing.job.resume.pages + settings.maxPages) };
      }
      const id = existing?.job.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const controller = new AbortController();
      controllers.current.set(id, controller);
      if (existing) {
        updateJob(id, { status: "running", message: undefined, note: undefined, truncated: false, settings });
      } else {
        setJobs((list) => [{ id, url, status: "running", pages: 0, errors: 0, settings }, ...list]);
      }
      let knownDirty = false;
      let pageCount = existing?.job.pages ?? 0;
      let foundCount = existing?.found ?? 0;
      const startedAt = Date.now();
      // ここから後に加わったものが「今回の新着」
      newSinceRef.current = startedAt;
      setNewSince(startedAt);
      recordHistory({ url, at: startedAt, pages: pageCount, found: foundCount, settings });

      try {
        // サーバーは 1 回に動ける時間に上限があるので、「続き」が返ってきたら送り返して再開してもらう。
        // 通信が途中で切れたら、同じところから最大 3 回までやり直す
        let current: CrawlState | undefined = existing?.job.resume;
        /** 届いた中で一番新しい途中経過（再接続はここから） */
        let latest: CrawlState | undefined = current;
        let retries = 0;
        for (;;) {
          let next: CrawlState | undefined;
          let finished = false;
          try {
            const res = await fetch("/api/thumbs/crawl", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                url,
                ...settings,
                exclude: excludesRef.current,
                gofileToken: gofileTokenRef.current || undefined,
                resume: current,
                // ブラウザから送られてきたページの中身（最初の 1 回だけ送る）
                html: current ? undefined : html,
                knownGofile: [...gofileKnown.current.keys()].slice(-MAX_GOFILE_KNOWN),
                // 前に動画が見つかったページ・投稿は読み直さない（新しく増えた分だけを読む）
                ...(() => {
                  const k = knownOf(listNow.current.items);
                  return { knownPages: k.pages, knownTweets: k.tweets };
                })(),
              }),
              signal: controller.signal,
            });
            if (res.status >= 500) throw new ServerError(res.status);
            if (!res.ok || !res.body) {
              const data = await res.json().catch(() => ({}));
              updateJob(id, { status: "error", message: data.error ?? `エラー（HTTP ${res.status}）` });
              return;
            }
            // ストリームを 1 行ずつ読み、届いたものからすぐ画面に追加する
            const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
            let buffer = "";
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += value;
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";
              for (const line of lines) {
                if (!line.trim()) continue;
                const event = JSON.parse(line) as CrawlEvent;
                if (event.type === "page") {
                  // 読んだ Gofile のフォルダを覚える（次からは聞かない）
                  const gid = event.gofile ? /^https:\/\/gofile\.io\/d\/([\w-]{4,40})/.exec(event.url)?.[1] : null;
                  if (gid) {
                    gofileKnown.current.set(gid, Date.now());
                    knownDirty = true;
                  }
                  pageCount++;
                  updateJob(id, (j) => ({ pages: j.pages + 1 }));
                } else if (event.type === "error") updateJob(id, (j) => ({ errors: j.errors + 1, message: event.message }));
                else if (event.type === "skip") updateJob(id, (j) => ({ skips: (j.skips ?? 0) + 1 }));
                else if (event.type === "done") {
                  finished = true;
                  updateJob(id, { status: "done", truncated: event.truncated, resume: event.state });
                } else if (event.type === "continue" || event.type === "checkpoint") {
                  if (event.type === "continue") next = event.state;
                  latest = event.state;
                  updateJob(id, { resume: event.state });
                }
                else if (event.type === "note") updateJob(id, { note: event.message });
                else if (event.type === "gated") {
                  updateJob(id, (j) =>
                    (j.gated ?? []).some((g) => g.url === event.url)
                      ? {}
                      : {
                          // 新しく見つけたものを上に
                          gated: [{ url: event.url, thumb: event.thumb, duration: event.duration, video: event.video, title: event.title, app: event.app, at: Date.now() }, ...(j.gated ?? [])].slice(
                            0,
                            MAX_GATED,
                          ),
                        },
                  );
                }
                else if (event.type === "media") {
                  foundCount += event.items.length;
                  setItems((before) => {
                    const stamp = Date.now();
                    // リンク切れの印の付いたものと同じ動画が届いたら、それを生き返らせる
                    const revived = reviveArrivals(before, event.items, stamp);
                    const prev = revived.list;
                    const incoming = revived.rest;
                    // 以前に取得して「確認できず非表示」のまま残っているものが、いま確認済みで届いたものと同じなら、
                    // 古いほうを捨てる（残しておくと、新しく届いたものが「もうある」と見なされて、ずっと表示されない）
                    const arriving = new SeenMedia(incoming.filter((i) => i.checked));
                    const list = prev.filter((i) => isFresh(i, stamp) || i.dead || !arriving.has(i));
                    // 同じ動画（URL の後ろだけ違う・画質違い）は 2 個入れない
                    const known = new SeenMedia(list);
                    const ids = new Set(list.map((i) => i.id));
                    const fresh: Item[] = [];
                    for (const i of incoming) {
                      if (ids.has(i.id) || known.has(i) || isItemExcluded(i, excludesRef.current)) continue;
                      ids.add(i.id);
                      known.add(i);
                      // サーバーがリンク切れでないと確かめたもの。受け取った時刻を印にする
                      fresh.push({ ...i, jobId: id, checked: i.checked ? Date.now() : undefined, addedAt: Date.now() });
                    }
                    // 新しく見つけたものを上に並べる
                    return fresh.length || list.length !== before.length || prev !== before ? [...fresh, ...list].slice(0, MAX_ITEMS) : before;
                  });
                }
              }
            }
            // 「終わり」も「続き」も届かずに切れた＝途中で通信が切れた
            if (!finished && !next) throw new Error("stream cut");
          } catch (err) {
            if (controller.signal.aborted) throw err;
            if (retries >= 3) throw err;
            retries++;
            updateJob(id, { message: `通信が切れたので再接続しています（${retries}/3）` });
            await new Promise((r) => setTimeout(r, 2000 * retries));
            current = latest;
            continue; // 最後の途中経過からやり直す（重複した画像は一覧に二重に入らない）
          }
          if (retries) updateJob(id, { message: undefined });
          retries = 0;
          if (!next || controller.signal.aborted) break;
          current = next;
        }
        updateJob(id, (j) => (j.status === "running" ? { status: "done" } : {}));
      } catch (err) {
        if (controller.signal.aborted) updateJob(id, { status: "stopped" });
        else updateJob(id, { status: "error", message: describeError(err) });
      } finally {
        controllers.current.delete(id);
        if (knownDirty) saveKnown();
        recordHistory({ url, at: startedAt, pages: pageCount, found: foundCount, settings });
      }
    },
    [depth, maxPages, maxPagination, crossSite, render, kinds, robots, updateJob, recordHistory, saveKnown, listNow],
  );

  const resumeJob = useCallback(
    (job: Job) => {
      if (controllers.current.has(job.id)) return;
      void startJob(job.url, job.settings, { job, found: items.filter((i) => i.jobId === job.id).length });
    },
    [startJob, items],
  );

  // --- ブラウザから送られてきたページを受け取る（ブックマークレットが、このアプリを #import 付きで開いて中身を渡す） ---
  const [importing, setImporting] = useState(false);
  const [appOrigin, setAppOrigin] = useState("");
  const startJobRef = useRef(startJob);
  useEffect(() => {
    startJobRef.current = startJob;
  });
  // --- Gofile のトークンを、ブックマークレットから受け取る（#gofile-token=…。「#」より後ろはサーバーに送られない） ---
  const [tokenArrived, setTokenArrived] = useState<string | null>(null);
  useEffect(() => {
    const m = /^#gofile-token=([A-Za-z0-9]{10,128})$/.exec(location.hash);
    if (!m) return;
    // アドレスからはすぐ消す（履歴・共有にトークンを残さない）
    window.history.replaceState(null, "", location.pathname + location.search);
    // この端末のトークンは、まだ空のときだけ入れる（ほかの人のトークンを取りに行っても、自分のぶんが消えないように）
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 一度だけ、受け取ったトークンを入れる
    setGofileToken((prev) => prev || m[1]);
    setTokenArrived(m[1]);
    // 「＋ トークンを足す」の欄に入れて見せる（メニューを開く）
    setMenuOpen(true);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 画面に出してから、このアプリのアドレスを入れる
    setAppOrigin(location.origin);
    if (location.hash !== "#import" || !window.opener) return;
    setImporting(true);
    const opener = window.opener as Window;
    // 送り元のページに「受け取れます」と知らせ続ける（送り元は、それを聞いてから中身を送る）
    const ping = setInterval(() => {
      try {
        opener.postMessage("thumbs-ready", "*");
      } catch {
        /* 送り元が閉じられた */
      }
    }, 400);
    const giveUp = setTimeout(() => {
      clearInterval(ping);
      setImporting(false);
    }, 60000);
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: unknown; url?: unknown; html?: unknown } | null;
      if (!d || d.type !== "thumbs-import" || typeof d.url !== "string" || typeof d.html !== "string") return;
      if (!/^https?:\/\//.test(d.url)) return;
      clearInterval(ping);
      clearTimeout(giveUp);
      window.removeEventListener("message", onMessage);
      setImporting(false);
      window.history.replaceState(null, "", location.pathname);
      // 送られてきたページを「入力したページ」として読む（サーバーからは読みに行かない）。そこからのリンクは 1 階層だけ辿る
      void startJobRef.current(d.url, { depth: 1, maxPages: 60, maxPagination: 0, crossSite: false, render: "auto", kinds: "video", robots: true }, undefined, d.html.slice(0, 2_500_000));
    };
    window.addEventListener("message", onMessage);
    return () => {
      clearInterval(ping);
      clearTimeout(giveUp);
      window.removeEventListener("message", onMessage);
    };
  }, []);
  // --- サーバー側の自動巡回（データベースがあるとき）。ブラウザを閉じていてもサーバーが巡回し、開いたときに結果を受け取る ---
  const [serverPatrol, setServerPatrol] = useState(false);
  const [serverBusy, setServerBusy] = useState(false);
  const [serverNote, setServerNote] = useState("");
  const pullPatrol = useCallback(async () => {
    let since = 0;
    try {
      since = Number(localStorage.getItem(PATROL_SEEN_KEY)) || 0;
    } catch {
      /* 0 から */
    }
    const res = await fetch(`/api/thumbs/patrol?since=${since}`).catch(() => null);
    if (!res?.ok) return;
    const data = (await res.json().catch(() => null)) as {
      configured?: boolean;
      now?: number;
      sites?: { url: string; lastRun: number | null; lastFound: number }[];
      items?: { id: string; siteUrl: string; kind: string; data: Record<string, unknown>; foundAt: number }[];
    } | null;
    if (!data?.configured) return;
    setServerPatrol(true);
    const last = Math.max(0, ...(data.sites ?? []).map((x) => x.lastRun ?? 0));
    setServerNote(last ? `最後の巡回 ${new Date(last).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}` : "まだ巡回していません");
    const got = data.items ?? [];
    if (got.length) {
      // サイトごとの行（なければ作る）
      const idOf = new Map<string, string>();
      const fresh: Job[] = [];
      for (const it of got) {
        if (idOf.has(it.siteUrl)) continue;
        const job = latest.current.jobs.find((j) => j.url === it.siteUrl && !j.settings?.hunt);
        if (job) idOf.set(it.siteUrl, job.id);
        else {
          const id = `patrol-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          idOf.set(it.siteUrl, id);
          fresh.push({ id, url: it.siteUrl, status: "done", pages: 0, errors: 0, settings: sitesRef.current.find((x) => x.url === it.siteUrl)?.settings });
        }
      }
      if (fresh.length) setJobs((list) => [...fresh, ...list]);
      // ここから後に加わったものが「新着」
      const stamp = Date.now();
      newSinceRef.current = stamp;
      setNewSince(stamp);
      const media = got.filter((it) => it.kind !== "gated");
      setItems((before) => {
        // リンク切れの印の付いたものと同じ動画が届いたら、それを生き返らせる（生き返らせたものは、新しくは足さない）
        const arrived = media.map((it) => it.data as unknown as MediaItem);
        const revived = reviveArrivals(before, arrived, stamp);
        const prev = revived.list;
        const left = new Set(revived.rest);
        const known = new SeenMedia(prev);
        const ids = new Set(prev.map((i) => i.id));
        const add: Item[] = [];
        for (const it of media.filter((_, n) => left.has(arrived[n]))) {
          const m = it.data as unknown as MediaItem;
          if (!m || typeof m.id !== "string" || typeof m.src !== "string" || ids.has(m.id) || known.has(m) || isItemExcluded(m, excludesRef.current)) continue;
          ids.add(m.id);
          known.add(m);
          // サーバーが確かめた時刻を印にする（時間がたっていれば、画面が確かめ直してから表示する）
          add.push({ ...m, jobId: idOf.get(it.siteUrl)!, checked: m.checked ? it.foundAt : undefined, addedAt: stamp });
        }
        return add.length ? [...add.reverse(), ...prev].slice(0, MAX_ITEMS) : prev;
      });
      for (const it of got.filter((x) => x.kind === "gated")) {
        const g = it.data as { url?: unknown; thumb?: unknown; title?: unknown; duration?: unknown; video?: unknown; app?: unknown };
        if (typeof g.url !== "string") continue;
        const tile: Gated = {
          url: g.url,
          thumb: typeof g.thumb === "string" ? g.thumb : undefined,
          title: typeof g.title === "string" ? g.title : undefined,
          duration: typeof g.duration === "number" ? g.duration : undefined,
          video: typeof g.video === "string" ? g.video : undefined,
          app: typeof g.app === "string" ? g.app : undefined,
          at: stamp,
        };
        updateJob(idOf.get(it.siteUrl)!, (j) => ((j.gated ?? []).some((x) => x.url === tile.url) ? {} : { gated: [tile, ...(j.gated ?? [])].slice(0, MAX_GATED) }));
      }
    }
    try {
      // 受け取った分の時刻まで進める（3000 件で区切られたときは、最後の 1 件の時刻まで）
      const upTo = got.length >= 3000 ? got[got.length - 1].foundAt : (data.now ?? Date.now());
      localStorage.setItem(PATROL_SEEN_KEY, String(upTo));
    } catch {
      /* 保存できなくても動く */
    }
  }, [updateJob]);
  useEffect(() => {
    // 保存データを戻した後に 1 回、その後は 2 分おきに受け取る。画面を開いている間は、時刻になったサイトの巡回もサーバーに頼む
    // （サーバーの定期実行の間隔が長くても、開いている間は選んだ間隔で巡回する）
    const first = setTimeout(() => void pullPatrol(), 1500);
    const t = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void fetch("/api/thumbs/patrol", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ run: "due" }) })
        .catch(() => null)
        .then(() => pullPatrol());
    }, 120000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [pullPatrol]);
  // 巡回するサイト・間隔・除外リスト・Gofile のトークンが変わったら、サーバーに伝える
  useEffect(() => {
    if (!serverPatrol || !loaded.current) return;
    const t = setTimeout(() => {
      void fetch("/api/thumbs/patrol", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sites, intervalMin: patrolMin, exclude: excludes }),
      }).catch(() => null);
    }, 800);
    return () => clearTimeout(t);
  }, [serverPatrol, sites, patrolMin, excludes]);
  const runServerPatrol = async () => {
    setServerBusy(true);
    try {
      await fetch("/api/thumbs/patrol", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ run: true }) });
      await pullPatrol();
    } finally {
      setServerBusy(false);
    }
  };

  // --- 登録サイトの自動巡回（このページを開いている間、決めた間隔で登録サイトを取得し直す） ---
  const sitesRef = useRef(sites);
  useEffect(() => {
    sitesRef.current = sites;
  });
  const patrolBusy = useRef(false);
  const runPatrol = useCallback(async () => {
    if (patrolBusy.current || !sitesRef.current.length) return;
    patrolBusy.current = true;
    patrolLast.current = Date.now();
    setPatrolAt(patrolLast.current);
    try {
      const saved = JSON.parse(localStorage.getItem(PATROL_KEY) ?? "{}");
      localStorage.setItem(PATROL_KEY, JSON.stringify({ ...saved, last: patrolLast.current }));
    } catch {
      /* 保存できなくても動く */
    }
    try {
      for (const site of sitesRef.current) {
        // 同じ URL の取得があれば、その行を使って最初から取得し直す（行を増やさない）。動いている最中なら飛ばす
        const job = latest.current.jobs.find((j) => j.url === site.url && !j.settings?.hunt);
        if (job && controllers.current.has(job.id)) continue;
        if (job) {
          const found = latest.current.items.filter((i) => i.jobId === job.id).length;
          await startJobRef.current(site.url, site.settings, { job: { ...job, resume: undefined, truncated: false, settings: site.settings }, found });
        } else await startJobRef.current(site.url, site.settings);
      }
    } finally {
      patrolBusy.current = false;
    }
  }, []);
  useEffect(() => {
    // サーバーが巡回してくれるときは、画面では巡回しない
    if (!patrolMin || serverPatrol) return;
    const tick = () => {
      if (Date.now() - patrolLast.current >= patrolMin * 60000) void runPatrol();
    };
    const t = setInterval(tick, 20000);
    return () => clearInterval(t);
  }, [patrolMin, runPatrol, serverPatrol]);
  const changePatrol = (min: number) => {
    setPatrolMin(min);
    // 選んだ時点から数え始める（選んですぐには走らせない）
    patrolLast.current = Date.now();
    setPatrolAt(patrolLast.current);
    try {
      localStorage.setItem(PATROL_KEY, JSON.stringify({ min, last: patrolLast.current }));
    } catch {
      /* 保存できなくても動く */
    }
  };

  /** ブックマークに登録して使う「このページをサムネ収集に送る」ボタンの中身 */
  const bookmarklet = appOrigin
    ? `javascript:(function(){var o=${JSON.stringify(appOrigin)};var w=window.open(o+'/thumbs#import');if(!w){alert('ポップアップを許可してください');return;}var h=document.documentElement.outerHTML.slice(0,2500000);var u=location.href;function f(e){if(e.origin===o&&e.data==='thumbs-ready'){w.postMessage({type:'thumbs-import',url:u,html:h},o);removeEventListener('message',f);}}addEventListener('message',f);})();`
    : "";
  const [copied, setCopied] = useState(false);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // 改行・スペース区切りで複数 URL をまとめて入れられる
    const urls = input
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (/^https?:\/\//i.test(s) ? s : `https://${s}`));
    const valid = urls.filter((u) => {
      try {
        new URL(u);
        return true;
      } catch {
        return false;
      }
    });
    if (!valid.length) {
      setFormError("URL を入力してください（例: https://example.com/gallery/）");
      return;
    }
    setFormError(null);
    setInput("");
    for (const u of valid) void startJob(u);
  };

  /**
   * Gofile をネット全体から探す。検索（Yahoo! のリアルタイム検索＝X の投稿、Web 検索、Bing）の結果のページから出発して、
   * 結果のサイト（X の投稿・掲示板・まとめ）を辿り、Gofile のリンクの中身を集める
   */
  const startHunt = () => {
    const kw = huntWord.trim().slice(0, 60);
    const q = (s: string) => encodeURIComponent(s.trim());
    const all: [string, string][] = [
      ["Gofile", `https://search.yahoo.co.jp/realtime/search?p=${q(`gofile.io ${kw}`)}`],
      ["Gofile", `https://search.yahoo.co.jp/realtime/search?p=${q(`gofile ${kw || "配布"}`)}`],
      ["Gofile", `https://search.yahoo.co.jp/search?p=${q(`"gofile.io/d/" ${kw}`)}`],
      ["Gofile", `https://search.yahoo.co.jp/search?p=${q(`gofile ${kw || "動画"} 掲示板`)}`],
      ["Gofile", `https://www.bing.com/search?q=${q(`"gofile.io/d/" ${kw}`)}`],
      // 5ちゃんねるのスレッド検索・はてなブックマークの本文検索（掲示板・まとめ記事を探す）
      ["Gofile", `https://find.5ch.net/search?q=${q(`gofile ${kw}`)}`],
      ["Gofile", `https://b.hatena.ne.jp/q/${q(`gofile ${kw}`)}?target=text&sort=recent`],
      // 海外の検索（韓国・チェコ・中国。日本の検索に出ない掲示板・まとめが見つかることがある）
      ["Gofile", `https://search.naver.com/search.naver?query=${q(`"gofile.io/d/" ${kw}`)}`],
      ["Gofile", `https://search.seznam.cz/?q=${q(`"gofile.io/d/" ${kw}`)}`],
      ["Gofile", `https://www.sogou.com/web?query=${q(`"gofile.io/d/" ${kw}`)}`],
      // Gofile 以外のファイル置き場（pixeldrain・Google ドライブ・Dropbox・catbox）の共有リンク
      ["pixeldrain", `https://search.yahoo.co.jp/realtime/search?p=${q(`pixeldrain.com ${kw}`)}`],
      ["pixeldrain", `https://search.yahoo.co.jp/search?p=${q(`"pixeldrain.com/u/" ${kw}`)}`],
      ["pixeldrain", `https://www.bing.com/search?q=${q(`"pixeldrain.com/l/" ${kw}`)}`],
      ["Google ドライブ", `https://search.yahoo.co.jp/realtime/search?p=${q(`drive.google.com 動画 ${kw}`)}`],
      ["Google ドライブ", `https://search.yahoo.co.jp/search?p=${q(`"drive.google.com/file/d/" 動画 ${kw}`)}`],
      ["Dropbox", `https://search.yahoo.co.jp/realtime/search?p=${q(`dropbox.com 動画 ${kw}`)}`],
      ["catbox", `https://search.yahoo.co.jp/search?p=${q(`"files.catbox.moe" mp4 ${kw}`)}`],
    ];
    // 設定で外した置き場・検索先は使わない
    const urls = all.filter(([host, u]) => !huntOff.includes(host) && !huntOff.includes(engineOf(u))).map(([, u]) => u);
    if (!urls.length) {
      setFormError("探す先がありません（「探す先の設定」で、置き場と検索先を 1 つ以上選んでください）");
      return;
    }
    const skipHosts = HUNT_HOSTS.filter((h) => huntOff.includes(h));
    const settings: CrawlSettings = { depth: 2, maxPages: 150, maxPagination: 5, crossSite: true, render: "auto", kinds: "video", robots, hunt: true, gofileOnly: true, skipHosts };
    setFormError(null);
    runHunt(urls, settings);
  };

  /**
   * 任意のワードで、動画をネット全体から探す。検索（Web・X の投稿・動画検索・掲示板・まとめ）の結果のページから出発して、
   * 結果のサイトを辿り、見つけた動画を全部集める
   */
  const startVideoHunt = () => {
    const kw = huntWord.trim().slice(0, 60);
    if (!kw) {
      setFormError("動画を探すときは、キーワードを入れてください");
      return;
    }
    const q = (s: string) => encodeURIComponent(s.trim());
    const urls = [
      `https://search.yahoo.co.jp/search?p=${q(`${kw} 動画`)}`,
      `https://search.yahoo.co.jp/realtime/search?p=${q(`${kw} 動画`)}`,
      `https://www.bing.com/search?q=${q(`${kw} 動画`)}`,
      `https://search.yahoo.co.jp/video/search?p=${q(kw)}`,
      `https://search.yahoo.co.jp/search?p=${q(`${kw} 動画 まとめ`)}`,
      `https://b.hatena.ne.jp/q/${q(`${kw} 動画`)}?target=text&sort=recent`,
      `https://find.5ch.net/search?q=${q(kw)}`,
      `https://search.naver.com/search.naver?query=${q(`${kw} 動画`)}`,
      // 動画サービスの公式の検索の窓口
      ...Object.values(videoApiUrls(kw)),
    ].filter((u) => !huntOff.includes(engineOf(u)));
    if (!urls.length) {
      setFormError("探す先がありません（「探す先の設定」で、検索先を 1 つ以上選んでください）");
      return;
    }
    const settings: CrawlSettings = { depth: 2, maxPages: 150, maxPagination: 5, crossSite: true, render: "auto", kinds: "video", robots, hunt: true };
    setFormError(null);
    runHunt(urls, settings);
  };

  /** 検索をいくつも始める */
  const runHunt = (urls: string[], settings: CrawlSettings) => {
    // 一度に全部は走らせない（サーバーと Gofile に負担がかかる）。3 つずつ、終わったら次を始める
    let next = 0;
    const rounds = huntRounds;
    const worker = async () => {
      while (next < urls.length) {
        const u = urls[next++];
        await startJob(u, settings);
        // ひととおり終わったら、設定した回数だけ「さらに深く探す」を自動で続ける（止めた・失敗したときは続けない）
        for (let round = 0; round < rounds; round++) {
          await new Promise((r) => setTimeout(r, 500));
          const job = latest.current.jobs.find((j) => j.url === u && j.settings?.hunt);
          if (!job || job.status !== "done" || !job.truncated || !job.resume) break;
          await startJob(u, job.settings, { job, found: latest.current.items.filter((i) => i.jobId === job.id).length });
        }
      }
    };
    for (let i = 0; i < 3; i++) void worker();
  };

  /** 除外リストに追加し、すでに一覧にある該当の画像・動画も消す */
  const addExclude = useCallback((input: string): boolean => {
    const rule = normalizeRule(input);
    if (!rule) return false;
    setExcludes((list) => (list.includes(rule) ? list : [...list, rule].slice(-MAX_EXCLUDES)));
    setItems((list) => list.filter((i) => !isItemExcluded(i, [rule])));
    return true;
  }, []);
  const removeExclude = (rule: string) => setExcludes((list) => list.filter((r) => r !== rule));

  const saveSite = (url: string, settings: CrawlSettings) => {
    setSites((list) => (list.some((s) => s.url === url) || list.length >= MAX_SITES ? list : [...list, { url, settings }]));
  };
  const removeSite = (url: string) => setSites((list) => list.filter((s) => s.url !== url));

  const stopJob = (id: string) => controllers.current.get(id)?.abort();
  const removeJob = (id: string) => {
    stopJob(id);
    setJobs((l) => l.filter((j) => j.id !== id));
    setItems((l) => l.filter((i) => i.jobId !== id));
    // 消した分の Gofile の動画をもう一度取れるように、覚えたフォルダも忘れる
    forgetKnown();
    if (jobFilter === id) setJobFilter(null);
  };
  const clearAll = () => {
    if (!confirm("一覧をすべて消しますか？")) return;
    controllers.current.forEach((c) => c.abort());
    setJobs([]);
    setItems([]);
    setJobFilter(null);
    forgetKnown();
  };

  const hideItem = useCallback((id: string) => setItems((l) => l.filter((i) => i.id !== id)), []);
  /** リンク切れの印を付ける（一覧からは消さない。消すのは手動） */
  const markDead = useCallback(
    (id: string) => setItems((l) => l.map((i) => (i.id === id && !i.dead ? { ...i, dead: Date.now(), checked: Date.now() } : i))),
    [],
  );

  // --- 「復活したら保存」の保存先：Google ドライブ（つながっていなければ Vercel Blob） ---
  const [drive, setDrive] = useState<DriveInfo | null>(null);
  const [driveNote, setDriveNote] = useState<string | null>(null);
  const loadDrive = useCallback(async () => {
    const res = await fetch("/api/thumbs/drive").catch(() => null);
    if (res?.ok) setDrive((await res.json().catch(() => null)) as DriveInfo | null);
  }, []);
  useEffect(() => {
    // Google の許可画面から戻ってきたとき（?drive=connected など）の結果を出して、URL からは消す
    const q = new URLSearchParams(location.search);
    const result = q.get("drive");
    if (result) {
      const msg = q.get("driveMessage");
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 戻ってきた 1 回だけ
      setDriveNote(
        result === "connected"
          ? `✅ Google ドライブとつなぎました${msg ? `（${msg}）` : ""}。これからは「サムネ収集（復活保存）」フォルダに保存します`
          : result === "notconfigured"
            ? "Google ドライブを使う設定（Vercel の環境変数）がまだありません"
            : `⚠ つなげませんでした：${msg ?? "不明なエラー"}`,
      );
      if (result === "connected" || result === "error") setFilter("dead");
      window.history.replaceState(null, "", window.location.pathname);
    }
    void loadDrive();
  }, [loadDrive]);

  // --- 「復活したら保存」：サーバーが見張っている動画と、その状態 ---
  const [revive, setRevive] = useState<Map<string, ReviveRow>>(new Map());
  const [reviveOn, setReviveOn] = useState(false);
  const reviveSaving = useRef(false);
  const loadRevive = useCallback(async () => {
    const res = await fetch("/api/thumbs/revive").catch(() => null);
    if (!res?.ok) return;
    const data = (await res.json().catch(() => null)) as { configured?: boolean; rows?: ReviveRow[] } | null;
    if (!data?.configured) return;
    setReviveOn(true);
    setRevive(new Map((data.rows ?? []).map((r) => [r.fp, r])));
    // 巡回・取得で見つけたまま保存されていないものがあれば、今すぐ保存してもらう（巡回を待たずに）
    if (!reviveSaving.current && (data.rows ?? []).some((r) => r.status === "found")) {
      reviveSaving.current = true;
      void fetch("/api/thumbs/revive", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "save" }) })
        .catch(() => null)
        .finally(() => {
          reviveSaving.current = false;
          void loadRevive();
        });
    }
  }, []);
  useEffect(() => {
    const first = setTimeout(() => void loadRevive(), 2500);
    const timer = setInterval(() => void loadRevive(), 3 * 60 * 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [loadRevive]);
  /** 🔔 を付ける・外す（動画ファイルだけ。指紋がなければ、ファイルの URL・ファイル名で見分ける） */
  const setWatch = useCallback(
    async (list: Item[], on: boolean) => {
      const withPrint = list.filter((i) => i.kind === "video" && rkOf(i));
      if (!withPrint.length) return 0;
      if (on) {
        // 付けたときの鍵を一覧に覚えさせる（あとで URL や指紋が変わっても、同じ見張りを指せるように）
        const keys = new Map(withPrint.map((i) => [i.id, rkOf(i)!]));
        setItems((l) => l.map((i) => (keys.has(i.id) && !i.rk ? { ...i, rk: keys.get(i.id) } : i)));
      }
      const body = on
        ? { action: "watch", items: withPrint.map((i) => ({ fp: rkOf(i), title: i.title, thumb: i.thumb, pageUrl: i.pageUrl, duration: i.duration })) }
        : { action: "unwatch", fps: withPrint.map((i) => rkOf(i)) };
      await fetch("/api/thumbs/revive", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
      await loadRevive();
      return withPrint.length;
    },
    [loadRevive],
  );
  /** 一覧から消す（保存した動画があるものは、保存した動画も消すか聞く） */
  const removeItems = useCallback(
    async (list: Item[]) => {
      const saved = list.filter((i) => revive.get(rkOf(i) ?? "")?.status === "saved");
      if (saved.length && !confirm(`保存した動画が ${saved.length} 本あります。保存した動画も消しますか？\n（「キャンセル」で、保存した動画のあるものは一覧に残します）`)) {
        const keep = new Set(saved.map((i) => i.id));
        list = list.filter((i) => !keep.has(i.id));
      } else if (saved.length) {
        await fetch("/api/thumbs/revive", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "delete", fps: saved.map((i) => rkOf(i)) }) }).catch(() => null);
      }
      const watching = list.filter((i) => { const r = revive.get(rkOf(i) ?? ""); return r && r.status !== "saved"; });
      if (watching.length) await setWatch(watching, false);
      const ids = new Set(list.map((i) => i.id));
      setItems((l) => l.filter((i) => !ids.has(i.id)));
      void loadRevive();
    },
    [revive, setWatch, loadRevive],
  );
  /** 画面で調べた再生時間を、一覧に覚えさせる（保存されるので、次からは調べ直さない） */
  const setDuration = useCallback(
    (id: string, duration: number) =>
      setItems((l) => l.map((i) => (i.id === id && !i.duration ? { ...i, duration: Math.round(duration * 10) / 10 } : i))),
    [],
  );

  // --- サムネイルの大きさ：ボタン・スライダー・2 本指のピンチ（スマホ）・Ctrl + ホイール（パソコンのトラックパッドのピンチ）---
  const gridRef = useRef<HTMLUListElement>(null);
  const pinch = useRef<{ dist: number; tile: number } | null>(null);
  const resize = useCallback((delta: number) => setTile((t) => Math.min(TILE_SIZES.length - 1, Math.max(0, t + delta))), []);
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    let wheel = 0;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      wheel += e.deltaY;
      if (Math.abs(wheel) > 40) {
        resize(wheel < 0 ? 1 : -1);
        wheel = 0;
      }
    };
    // iPhone の Safari は、2 本指の操作でページ全体を拡大してしまうので止める
    const stopZoom = (e: Event) => e.preventDefault();
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2) e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", stopZoom);
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", stopZoom);
      el.removeEventListener("touchmove", onTouchMove);
    };
  }, [resize, items.length]);
  const touchDist = (t: React.TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const onGridTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) pinch.current = { dist: touchDist(e.touches), tile };
  };
  const onGridTouchMove = (e: React.TouchEvent) => {
    if (!pinch.current || e.touches.length !== 2) return;
    // 指を 1.35 倍広げるごとに 1 段大きく、縮めるごとに 1 段小さく
    const steps = Math.round(Math.log(touchDist(e.touches) / pinch.current.dist) / Math.log(1.35));
    const next = Math.min(TILE_SIZES.length - 1, Math.max(0, pinch.current.tile + steps));
    if (next !== tile) setTile(next);
  };
  const onGridTouchEnd = (e: React.TouchEvent) => {
    if (e.touches.length < 2) pinch.current = null;
  };

  // --- 以前の一覧のリンク切れ ---
  // 一覧はすぐ全部表示し、裏で確かめて、リンク切れと決まったものだけ外す（確かめ終わるまで隠すと、数百件あると長く何も見えないため）。
  // サーバーに確かめるのは動画だけ。画像は表示するときに読み込めなければ、その場で一覧から外れる（サーバーの通信を使わない）
  const shown = items;
  /** 確かめに出したもの（同じものを何度も聞かない） */
  const asked = useRef(new Set<string>());
  /** 確かめられなかった（通信の失敗など）もの。表示はそのまま */
  const [unsure, setUnsure] = useState(0);
  useEffect(() => {
    if (!loaded.current || !now) return;
    for (const item of items) {
      if (item.kind === "image" || isFresh(item, now) || asked.current.has(item.id)) continue;
      asked.current.add(item.id);
      void checkLink(item).then((r) => {
        // 見られる：確かめた時刻を付ける（リンク切れの印があれば外す）／リンク切れ：印を付けて残す
        if (r === "yes") setItems((l) => l.map((i) => (i.id === item.id ? { ...i, checked: Date.now(), dead: undefined } : i)));
        else if (r === "no") markDead(item.id);
        else setUnsure((n) => n + 1);
      });
    }
  }, [items, now, markDead]);
  /** まだ確かめていない以前の動画（確かめられなかったものは数えない） */
  const waiting = Math.max(0, items.filter((i) => i.kind !== "image" && !isFresh(i, now)).length - unsure);

  const visible = useMemo(
    () =>
      shown.filter(
        (i) =>
          (filter === "all" ||
            (filter === "new"
              ? newSince > 0 && (i.addedAt ?? 0) >= newSince
              : filter === "dead"
                ? !!i.dead
                : filter === "image"
                  ? i.kind === "image"
                  : i.kind !== "image")) &&
          (!jobFilter || i.jobId === jobFilter),
      ),
    [shown, filter, jobFilter, newSince],
  );
  const viewerIndex = viewerId ? visible.findIndex((i) => i.id === viewerId) : -1;
  const viewer = viewerIndex >= 0 ? viewerIndex : null;
  const setViewer = (index: number | null) => setViewerId(index === null ? null : (visible[index]?.id ?? null));
  const counts = useMemo(() => {
    const scoped = jobFilter ? shown.filter((i) => i.jobId === jobFilter) : shown;
    const video = scoped.filter(isVideoLike).length;
    const fresh = newSince > 0 ? scoped.filter((i) => (i.addedAt ?? 0) >= newSince).length : 0;
    const dead = scoped.filter((i) => i.dead).length;
    return { all: scoped.length, image: scoped.length - video, video, new: fresh, dead };
  }, [shown, jobFilter, newSince]);

  /**
   * 「サイトで開く」のタイルのうち、もう動画が取れているページ（前の取得で読めた・X の投稿の番号が同じ）は出さない。
   * 確認を求められて読めなかっただけで、動画は一覧にあるため
   */
  const knownForGated = useMemo(() => {
    const k = knownOf(items);
    return { pages: new Set(k.pages.map(pageKey)), tweets: new Set(k.tweets) };
  }, [items]);
  const gatedLeft = useCallback(
    (list: Gated[] | undefined) =>
      list?.filter((g) => {
        if (knownForGated.pages.has(pageKey(g.url))) return false;
        const t = tweetIdIn(g.url);
        return !(t && knownForGated.tweets.has(t));
      }),
    [knownForGated],
  );

  const running = jobs.some((j) => j.status === "running");
  const foundByJob = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of shown) m.set(i.jobId, (m.get(i.jobId) ?? 0) + 1);
    return m;
  }, [shown]);

  return (
    <div className="min-h-screen bg-neutral-50 pb-16 text-neutral-900 [color-scheme:light] dark:bg-neutral-950 dark:text-neutral-100 dark:[color-scheme:dark]">
      {/* メニューを開いている間は上に貼り付けない（スマホでは設定が画面の大半を占めて、下の設定が隠れてしまうため） */}
      <header className={`${menuOpen ? "relative" : "sticky top-0"} z-30 border-b border-neutral-200 bg-white/90 backdrop-blur-md dark:border-neutral-800 dark:bg-neutral-950/90`}>
        <div className="mx-auto max-w-6xl px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
          <div className="mb-2 flex items-center justify-between">
            <h1 className="flex items-center gap-2 text-lg font-black tracking-tight">
              <Link href="/apps" aria-label="アプリ一覧へ" className="text-sm font-semibold text-neutral-400">
                ‹ アプリ
              </Link>
              <span>
                <span className="mr-1">🖼️</span>サムネ収集
              </span>
            </h1>
            <div className="flex items-center gap-3">
              {running && !menuOpen && <span className="animate-pulse text-xs font-semibold text-fuchsia-500">取得中…</span>}
              {items.length > 0 && (
                <button type="button" onClick={clearAll} className="text-xs font-semibold text-neutral-400 hover:text-red-500">
                  すべて消す
                </button>
              )}
              <button
                type="button"
                onClick={() => toggleFold("menu")}
                aria-expanded={menuOpen}
                className="rounded-full bg-neutral-200/70 px-3 py-1 text-xs font-bold text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
              >
                メニュー {menuOpen ? "▲" : "▼"}
              </button>
            </div>
          </div>
          <form onSubmit={onSubmit} className="flex gap-2">
            <input
              type="url"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="https://example.com/gallery/"
              className="min-w-0 flex-1 rounded-full border border-neutral-200 bg-neutral-50 px-4 py-2.5 text-[16px] text-neutral-900 caret-fuchsia-500 outline-none placeholder:text-neutral-400 focus:border-fuchsia-400 focus:bg-white dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:bg-neutral-950"
            />
            <button
              type="submit"
              className="shrink-0 rounded-full bg-fuchsia-500 px-5 py-2.5 text-sm font-bold text-white shadow-sm shadow-fuchsia-500/30 active:scale-95"
            >
              取得
            </button>
          </form>
          {importing && <p className="mt-1.5 animate-pulse text-xs font-semibold text-sky-500">📥 ブラウザからページを受け取っています…</p>}
          {formError && <p className="mt-1.5 text-xs text-red-500">{formError}</p>}
          {menuOpen && (
          <>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={huntWord}
              onChange={(e) => setHuntWord(e.target.value)}
              placeholder="探すワード"
              aria-label="探すワード"
              className="min-w-0 flex-1 basis-full sm:basis-0 rounded-full border border-neutral-200 bg-neutral-50 px-4 py-2 text-[16px] text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-sky-400 focus:bg-white dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500"
            />
            <button
              type="button"
              onClick={startHunt}
              title="X の投稿・掲示板・まとめサイトを検索して、動画の置き場（Gofile・pixeldrain・Google ドライブ・Dropbox・catbox）の共有リンクの中身を集めます（時間がかかります）"
              className="shrink-0 rounded-full bg-sky-500 px-4 py-2 text-xs font-bold text-white shadow-sm active:scale-95"
            >
              🔎 ファイル置き場を探す
            </button>
            <button
              type="button"
              onClick={startVideoHunt}
              title="キーワードで検索して、結果のサイト（動画サイト・X の投稿・掲示板・まとめ）を辿り、見つけた動画を集めます（数分かかります）"
              className="shrink-0 rounded-full bg-emerald-500 px-4 py-2 text-xs font-bold text-white shadow-sm active:scale-95"
            >
              🔎 動画を探す
            </button>
            <label className="flex items-center gap-1.5 text-xs text-neutral-500" title="ひととおり探し終わった後、さらに深く探すのを自動で何回続けるか（1 回ごとに、取っておいたリンクを 80 ページずつ読み進めます）">
              深く探す回数
              <select
                value={huntRounds}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  setHuntRounds(n);
                  try {
                    localStorage.setItem(ROUNDS_KEY, String(n));
                  } catch {
                    /* 保存できなくても動く */
                  }
                }}
                className="rounded-md border border-neutral-200 bg-white px-1.5 py-1 text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
              >
                {[0, 1, 2, 3, 5, 10, 20].map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? "なし" : `${n}回`}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <details className="mt-2 rounded-xl border border-neutral-200 px-3 py-2 text-xs text-neutral-600 dark:border-neutral-800 dark:text-neutral-300">
            <summary className="cursor-pointer select-none font-semibold">
              ⚙️ 探す先の設定{huntOff.length ? `（${huntOff.length} 件を外しています）` : ""}
            </summary>
            <p className="mt-2 text-[11px] text-neutral-400">チェックを外したものは、「ファイル置き場を探す」「動画を探す」で使いません。</p>
            <p className="mt-2 font-semibold">動画の置き場（ファイル置き場を探す）</p>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1.5">
              {HUNT_HOSTS.map((h) => (
                <label key={h} className="flex items-center gap-1.5">
                  <input type="checkbox" checked={!huntOff.includes(h)} onChange={() => toggleHunt(h)} className="h-4 w-4 accent-sky-500" />
                  {h}
                </label>
              ))}
            </div>
            <p className="mt-3 font-semibold">検索先</p>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1.5">
              {HUNT_ENGINES.map(([id, label]) => (
                <label key={id} className="flex items-center gap-1.5">
                  <input type="checkbox" checked={!huntOff.includes(id)} onChange={() => toggleHunt(id)} className="h-4 w-4 accent-sky-500" />
                  {label}
                </label>
              ))}
            </div>
          </details>
          <details className="mt-2 rounded-xl border border-neutral-200 px-3 py-2 text-xs text-neutral-600 dark:border-neutral-800 dark:text-neutral-300">
            <summary className="cursor-pointer select-none font-semibold">📥 ブラウザで見ているページを送る</summary>
            <p className="mt-2 leading-relaxed">
              「人間かどうかの確認」が出るサイトは、このアプリからは読めません。自分のブラウザで開いて見えているページなら、下のボタンでこのアプリに送って、動画とサムネを取り出せます。
            </p>
            <ol className="mt-2 list-decimal space-y-1 pl-5 leading-relaxed">
              <li>下の「コードをコピー」を押す</li>
              <li>ブラウザで適当なページをブックマークに追加し、そのブックマークを編集して、アドレス（URL）の欄をコピーしたコードに置き換える（名前は「サムネ収集に送る」など）</li>
              <li>動画のあるページを開いた状態で、そのブックマークを選ぶ → このアプリが開いて、取得が始まります</li>
            </ol>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={!bookmarklet}
                onClick={() => {
                  void navigator.clipboard?.writeText(bookmarklet).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2500);
                  });
                }}
                className="rounded-full bg-neutral-900 px-4 py-1.5 font-bold text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
              >
                {copied ? "コピーしました ✓" : "コードをコピー"}
              </button>
              <span className="text-[11px] text-neutral-400">パソコンでは、コードをブックマークバーの新しいブックマークの URL に貼り付けます</span>
            </div>
            <textarea readOnly value={bookmarklet} rows={2} aria-label="ブックマークに入れるコード" className="mt-2 w-full rounded-md border border-neutral-200 bg-neutral-50 p-1.5 font-mono text-[10px] text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900" />
          </details>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl border border-neutral-200 px-3 py-2 text-xs text-neutral-600 dark:border-neutral-800 dark:text-neutral-300">
            <label className="flex items-center gap-1.5" title="登録サイト（☆）を、決めた間隔で自動で取得し直します。このページを開いている間だけ動きます">
              🔁 登録サイトの自動巡回
              <select
                value={patrolMin}
                onChange={(e) => changePatrol(Number(e.target.value))}
                className="rounded-md border border-neutral-200 bg-white px-1.5 py-1 text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
              >
                {[0, 15, 30, 60, 180, 360].map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? "なし" : n < 60 ? `${n}分ごと` : `${n / 60}時間ごと`}
                  </option>
                ))}
              </select>
            </label>
            {patrolMin > 0 && (
              <span className="text-[11px] text-neutral-400">
                {sites.length === 0
                  ? "登録サイトがありません（履歴や一覧の ☆ で登録してください）"
                  : serverPatrol
                    ? `サーバーが巡回します（ブラウザを閉じていても動きます・15 分ごとに時刻を確認）。${serverNote}`
                    : `次は ${new Date(patrolAt + patrolMin * 60000).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })} ごろ（このページを開いている間だけ動きます）`}
              </span>
            )}
            {patrolMin > 0 && sites.length > 0 && (
              <button
                type="button"
                disabled={serverBusy}
                onClick={() => void (serverPatrol ? runServerPatrol() : runPatrol())}
                className="rounded-full bg-neutral-200/70 px-3 py-1 font-bold disabled:opacity-50 dark:bg-neutral-800"
              >
                {serverBusy ? "巡回中…" : "今すぐ巡回"}
              </button>
            )}
            {serverPatrol && <PushToggle />}
            {knownCount > 0 && (
              <span className="flex items-center gap-2 text-[11px] text-neutral-400">
                読んだ Gofile フォルダ {knownCount} 件を覚えています（次からは聞きません・3 日で忘れます）
                <button type="button" onClick={forgetKnown} className="rounded-full bg-neutral-200/70 px-2.5 py-0.5 font-bold text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                  忘れる
                </button>
              </span>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-500">
            <label className="flex items-center gap-1.5">
              取得する種類
              <select value={kinds} onChange={(e) => setKinds(e.target.value as "all" | "video" | "image")} className="rounded-md border border-neutral-200 bg-white px-1.5 py-1 text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100">
                <option value="all">すべて</option>
                <option value="video">動画のみ</option>
                <option value="image">画像のみ</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              下の階層
              <select value={depth} onChange={(e) => setDepth(Number(e.target.value))} className="rounded-md border border-neutral-200 bg-white px-1.5 py-1 text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100">
                {[0, 1, 2, 3, 5, 10, 15, 20].map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? "辿らない" : `${n}階層`}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              ページ送り
              <select value={maxPagination} onChange={(e) => setMaxPagination(Number(e.target.value))} className="rounded-md border border-neutral-200 bg-white px-1.5 py-1 text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100">
                {[0, 10, 30, 50].map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? "しない" : `${n}ページまで`}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              全体で最大
              <select value={maxPages} onChange={(e) => setMaxPages(Number(e.target.value))} className="rounded-md border border-neutral-200 bg-white px-1.5 py-1 text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100">
                {[30, 100, 300, 1000].map((n) => (
                  <option key={n} value={n}>
                    {n}ページ
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              ブラウザで開く
              <select value={render} onChange={(e) => setRender(e.target.value as "auto" | "always" | "off")} className="rounded-md border border-neutral-200 bg-white px-1.5 py-1 text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100">
                <option value="auto">自動</option>
                <option value="always">常に（遅い）</option>
                <option value="off">使わない</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={crossSite}
                onChange={(e) => setCrossSite(e.target.checked)}
                className="h-4 w-4 accent-fuchsia-500"
              />
              別のサイトへのリンクも辿る
            </label>
            <label className="flex items-center gap-1.5" title="サイトが出している「自動で読まないで」という指定を守ります。入力したページ自体は常に読みます">
              <input type="checkbox" checked={robots} onChange={(e) => setRobots(e.target.checked)} className="h-4 w-4 accent-fuchsia-500" />
              robots.txt を守る
            </label>
            {running && <span className="animate-pulse font-semibold text-fuchsia-500">取得中…</span>}
          </div>
          </>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4">
        {tokenArrived && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-sky-300 bg-sky-50 px-3 py-2.5 text-xs text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100">
            <p className="flex-1">
              🔑 Gofile のトークン（…{tokenArrived.slice(-4)}）を受け取りました。下の「🔑 Gofile の設定」の「＋ トークンを足す」に入れたので、名前を入れて「巡回に足す」を押してください
            </p>
            <button type="button" onClick={() => setTokenArrived(null)} className="shrink-0 underline opacity-70">
              閉じる
            </button>
          </div>
        )}
        {menuOpen && (
        <Library
          sites={sites}
          history={history}
          excludes={excludes}
          onAddExclude={addExclude}
          onRemoveExclude={removeExclude}
          gofileToken={gofileToken}
          onGofileToken={setGofileToken}
          appOrigin={appOrigin}
          incomingToken={tokenArrived}
          now={now}
          onRun={(url, settings) => void startJob(url, settings)}
          onSave={saveSite}
          onRemoveSite={removeSite}
          onRemoveHistory={(url) => setHistory((list) => list.filter((h) => h.url !== url))}
          onClearHistory={() => confirm("履歴をすべて消しますか？") && setHistory([])}
        />
        )}
        {jobs.length > 0 && (
          <button
            type="button"
            onClick={() => toggleFold("jobs")}
            aria-expanded={jobsOpen}
            className="mt-3 flex w-full items-center justify-between rounded-xl bg-neutral-100 px-3 py-2 text-xs font-bold text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300"
          >
            <span>
              取得・検索の一覧（{jobs.length} 件{running ? "・取得中" : ""}）
            </span>
            <span>{jobsOpen ? "▲ 畳む" : "▼ 開く"}</span>
          </button>
        )}
        {jobs.length > 0 && jobsOpen && (
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {jobs.map((job) => (
              <JobRow
                key={job.id}
                job={{ ...job, gated: gatedLeft(job.gated) }}
                found={foundByJob.get(job.id) ?? 0}
                active={jobFilter === job.id}
                onSelect={() => setJobFilter(jobFilter === job.id ? null : job.id)}
                onStop={() => stopJob(job.id)}
                onResume={() => resumeJob(job)}
                saved={sites.some((s) => s.url === job.url)}
                canSave={sites.length < MAX_SITES}
                onSave={() => saveSite(job.url, job.settings ?? { depth, maxPages, maxPagination, crossSite, render, kinds, robots })}
                onRemove={() => removeJob(job.id)}
                newSince={newSince}
                onFold={() => updateJob(job.id, { folded: !job.folded })}
              />
            ))}
          </ul>
        )}

        {items.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2 py-1">
            {(
              [
                ["all", "すべて"],
                ["image", "🖼 画像"],
                ["video", "🎬 動画"],
                ["new", "🆕 新着"],
                ["dead", "⚠ リンク切れ"],
              ] as const
            )
              .filter(([value]) => (value !== "new" && value !== "dead") || counts[value] > 0 || filter === value)
              .map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                className={`rounded-full px-3.5 py-1.5 text-xs font-bold transition ${
                  filter === value
                    ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
                    : "bg-neutral-200/70 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                }`}
              >
                {label} <span className="opacity-60">{counts[value]}</span>
              </button>
            ))}
            <div className="ml-auto flex items-center gap-1.5 text-xs text-neutral-500" title="一覧の大きさ（スマホは 2 本指のピンチ、パソコンは Ctrl + ホイールでも変えられます）">
              <button
                type="button"
                onClick={() => setShape(shape === "square" ? "wide" : "square")}
                aria-label={shape === "square" ? "横長（16:9）で表示" : "正方形で表示"}
                title={shape === "square" ? "横長（16:9）で表示" : "正方形で表示"}
                className="h-7 rounded-full bg-neutral-200/70 px-2.5 font-bold dark:bg-neutral-800"
              >
                {shape === "square" ? "⬜" : "▭"}
              </button>
              <button
                type="button"
                onClick={() => resize(-1)}
                disabled={tile === 0}
                aria-label="小さく（たくさん並べる）"
                className="h-7 w-7 rounded-full bg-neutral-200/70 text-base font-bold disabled:opacity-30 dark:bg-neutral-800"
              >
                −
              </button>
              <input
                type="range"
                min={0}
                max={TILE_SIZES.length - 1}
                value={tile}
                onChange={(e) => setTile(Number(e.target.value))}
                aria-label="サムネイルの大きさ"
                className="w-20 accent-fuchsia-500 sm:w-28"
              />
              <button
                type="button"
                onClick={() => resize(1)}
                disabled={tile === TILE_SIZES.length - 1}
                aria-label="大きく"
                className="h-7 w-7 rounded-full bg-neutral-200/70 text-base font-bold disabled:opacity-30 dark:bg-neutral-800"
              >
                ＋
              </button>
            </div>
          </div>
        )}

        {items.length === 0 && jobs.length === 0 && <EmptyState />}

        {filter === "dead" && visible.length > 0 && (
          <div className="mt-2 space-y-2 rounded-xl border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-100">
            <p>
              リンク切れの {visible.length} 件です。一覧には残してあります（消すのは手動）。
              {reviveOn
                ? "🔔 を付けた動画は、巡回・取得で同じ動画（同じファイル）が見つかったら、サーバーに保存します。"
                : "「復活したら保存」は、サーバーの保存先（データベース・Blob）が使えるときだけ使えます。"}
            </p>
            {reviveOn && <DrivePanel drive={drive} note={driveNote} onChanged={() => void loadDrive()} />}
            <div className="flex flex-wrap gap-2">
              {reviveOn && (
                <button
                  type="button"
                  onClick={() =>
                    void setWatch(visible, true).then((n) =>
                      alert(n ? `${n} 本に 🔔 を付けました` : "🔔 を付けられる動画がありませんでした（画像・埋め込み動画には付けられません）"),
                    )
                  }
                  className="rounded-full bg-amber-500 px-3 py-1.5 font-bold text-white"
                >
                  🔔 全部「復活したら保存」にする
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  const list = visible.filter((i) => !["watch", "saved", "found", "saving"].includes(revive.get(rkOf(i) ?? "")?.status ?? ""));
                  if (!list.length) return alert("消せるものがありません（🔔・💾 の付いたものは残します）");
                  if (confirm(`🔔・💾 の付いていないリンク切れ ${list.length} 件を一覧から消しますか？`)) void removeItems(list);
                }}
                className="rounded-full bg-white/70 px-3 py-1.5 font-bold text-amber-900 dark:bg-black/30 dark:text-amber-100"
              >
                🗑 印のないリンク切れを消す
              </button>
            </div>
          </div>
        )}

        <ul
          ref={gridRef}
          onTouchStart={onGridTouchStart}
          onTouchMove={onGridTouchMove}
          onTouchEnd={onGridTouchEnd}
          onTouchCancel={onGridTouchEnd}
          // 2 本指のピンチをページの拡大ではなく、一覧の大きさの変更に使う（1 本指のスクロールはそのまま）
          style={{
            gridTemplateColumns: `repeat(auto-fill, minmax(min(${TILE_SIZES[tile]}px, 100%), 1fr))`,
            touchAction: "pan-x pan-y",
          }}
          className={`mt-2 grid ${tile <= 1 ? "gap-1" : "gap-1.5"}`}
        >
          {visible.map((item, index) => (
            <li key={item.id}>
              <Thumb
                item={item}
                isNew={newSince > 0 && (item.addedAt ?? 0) >= newSince}
                shape={shape}
                large={TILE_SIZES[tile] >= 220}
                small={tile <= 1}
                onOpen={() => setViewer(index)}
                onBroken={hideItem}
                onDead={markDead}
                revive={revive.get(rkOf(item) ?? "")}
                onDuration={setDuration}
              />
            </li>
          ))}
        </ul>
        {waiting > 0 && (
          <p className="mt-2 text-center text-xs text-neutral-400">
            🔍 以前の動画のリンク切れを裏で確認中… 残り {waiting} 件（一覧はそのまま見られます。切れていたものには ⚠ の印が付きます）
          </p>
        )}
        {items.length > 0 && visible.length === 0 && waiting === 0 && (
          <p className="mt-10 text-center text-sm text-neutral-400">この条件に合うものはありません</p>
        )}
        <LoadMore jobs={jobs} running={running} onMore={resumeJob} />
      </main>

      {viewer !== null && (
        <Viewer
          items={visible}
          index={viewer}
          onIndex={setViewer}
          onClose={() => setViewer(null)}
          onBroken={(id) => markDead(id)}
          reviveOn={reviveOn}
          revive={revive}
          driveOn={!!drive?.connected}
          onWatch={(item, on) => void setWatch([item], on)}
          onRemove={(item) => {
            if (!confirm("一覧から消しますか？")) return;
            // 消したら次を表示する。最後の 1 件を消したときは、1 つ前（なければ閉じる）
            const nextItem = visible[viewer + 1] ?? visible[viewer - 1];
            setViewerId(nextItem ? nextItem.id : null);
            void removeItems([item]);
          }}
          onExclude={(host) => {
            if (!confirm(`${host} を除外リストに追加して、一覧から消しますか？\n（次からこのサイトは取得しません）`)) return;
            setViewer(null);
            addExclude(host);
          }}
        />
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mx-auto mt-12 max-w-md text-center text-sm leading-relaxed text-neutral-500">
      <p className="text-4xl">🔎</p>
      <p className="mt-3 font-semibold text-neutral-700 dark:text-neutral-300">URL を入れると、その先の画像・動画のサムネイルを集めます</p>
      <ul className="mt-4 space-y-1.5 text-left text-xs">
        <li>・続けて別の URL を入れると、一覧にどんどん追加されます（改行区切りでまとめて入力も可）</li>
        <li>・「下の階層」を選ぶと、入力したページより下のページもリンクを辿って集めます（最大20階層）</li>
        <li>・「ページ送り」で、2ページ目・次へ などの続きのページも集めます（最大50ページ）</li>
        <li>・動画が見つからないときは、自動でリンク先（同じサイトの別の場所・もっと下の階層・別のサイト）まで広げて動画を探します</li>
        <li>・「別のサイトへのリンクも辿る」にすると、最初から別サイトの画像・動画も集めます</li>
        <li>・サイトが自動アクセスを断るときや、年齢確認の入口があるときは、ブラウザで開き直して進みます</li>
        <li>・JavaScript で画像を後から出すサイトは、自動でブラウザで開いて集めます（少し時間がかかります）</li>
        <li>・取得した URL は履歴に残り、よく使うサイトは ☆ で 5 個まで登録できます</li>
        <li>・🎬 は動画、🖼 は画像。右下の数字は動画の長さ。タップで再生・拡大、ダウンロードもできます</li>
        <li>・一覧の大きさは右上の − ＋ で変えられます（スマホは 2 本指でピンチ、パソコンは Ctrl + ホイールでも）</li>
        <li>・Google ドライブ・Dropbox（フォルダも）・OneDrive・Gofile などの共有リンクも、そのまま入れれば動画を取り出します</li>
        <li>・X（旧 Twitter）の投稿の URL や、X の動画保存・ランキング系サイトも、投稿の番号から動画を取り出します</li>
        <li>・広告は自動で止め、再生ボタンや「広告をスキップ」も自動で押して、奥にある動画を探します</li>
        <li>・サムネイルのない動画は、動画から 1 コマ取り出してサムネイルを作ります（この端末に保存）</li>
        <li>・一覧はこの端末のブラウザに保存されます</li>
      </ul>
    </div>
  );
}

/** Gofile 探しの取得の名前（検索の URL のままだと読みにくいので） */
function huntLabel(url: string): string {
  try {
    const u = new URL(url);
    const word = (u.searchParams.get("p") ?? u.searchParams.get("q") ?? u.searchParams.get("query") ?? u.searchParams.get("search") ?? decodeURIComponent(u.pathname.replace(/^.*\//, "")))
      .replace(/"/g, "")
      .replace(/ AND mediatype:movies$/, "");
    const h = u.hostname;
    const where = u.pathname.startsWith("/realtime")
      ? "X の投稿"
      : h.includes("bing")
        ? "Web（Bing）"
        : h.includes("5ch")
          ? "5ちゃんねる"
          : h.includes("hatena")
            ? "はてなブックマーク"
            : h.includes("naver")
              ? "Web（Naver）"
              : h.includes("seznam")
                ? "Web（Seznam）"
                : h.includes("sogou")
                  ? "Web（Sogou）"
                  : h.includes("dailymotion")
                    ? "Dailymotion"
                    : h.includes("nicovideo")
                      ? "ニコニコ動画"
                      : h === "archive.org"
                        ? "Internet Archive"
                        : u.pathname.includes("/timelines/tag/")
                          ? "Mastodon"
                          : "Web（Yahoo!）";
    return `🔎 ${where}：${word}`;
  } catch {
    return url;
  }
}

function JobRow({
  job,
  onResume,
  found,
  saved,
  canSave,
  onSave,
  active,
  onSelect,
  onStop,
  onRemove,
  newSince,
  onFold,
}: {
  /** 「サイトで開く」のタイルを畳む・開く */
  onFold: () => void;
  newSince: number;
  job: Job;
  onResume: () => void;
  found: number;
  saved: boolean;
  canSave: boolean;
  onSave: () => void;
  active: boolean;
  onSelect: () => void;
  onStop: () => void;
  onRemove: () => void;
}) {
  const status =
    job.status === "running"
      ? `取得中… ${job.pages}ページ`
      : job.status === "error"
        ? job.message ?? "エラー"
        : job.status === "stopped"
          ? `停止（${job.pages}ページ）`
          : `${job.pages}ページ${job.truncated ? (job.settings?.hunt ? "（さらに深く探せます）" : "（上限で打ち切り）") : ""}`;
  const trouble = [job.errors ? `読めず ${job.errors}` : "", job.skips ? `飛ばした ${job.skips}` : ""].filter(Boolean).join("・");
  return (
    <li
      className={`rounded-xl border px-3 py-2 text-xs transition ${
        active
          ? "border-fuchsia-400 bg-fuchsia-50 dark:bg-fuchsia-950/30"
          : "border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900"
      }`}
    >
      <div className="flex items-center gap-2">
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${
          job.status === "running" ? "animate-pulse bg-fuchsia-500" : job.status === "error" ? "bg-red-500" : "bg-emerald-500"
        }`}
      />
      <button type="button" onClick={onSelect} className="min-w-0 flex-1 text-left" title="この URL の結果だけ表示">
        <span className="block truncate font-semibold">{job.settings?.hunt ? huntLabel(job.url) : job.url.replace(/^https?:\/\//, "")}</span>
        <span className={`block truncate ${job.status === "error" ? "text-red-500" : "text-neutral-400"}`}>
          {status} ・ {found}件{trouble && job.status !== "error" ? ` ・ ${trouble}` : ""}
        </span>
        {job.errors > 0 && job.status !== "error" && job.message && found === 0 && !job.note && (
          <span className="line-clamp-2 text-amber-600 dark:text-amber-400">⚠ {job.message}</span>
        )}
        {job.note && (
          <span
            className={`text-amber-600 dark:text-amber-400 ${job.note.includes("［診断］") ? "block whitespace-pre-line break-all" : "line-clamp-3"}`}
          >
            ⚠ {job.note}
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={onSave}
        disabled={saved || !canSave}
        aria-label={saved ? "登録済み" : "このサイトを登録"}
        title={saved ? "登録済み" : canSave ? "このサイトを登録" : "登録は5個までです"}
        className={`shrink-0 px-1 text-base ${saved ? "text-amber-400" : "text-neutral-300 hover:text-amber-400 disabled:opacity-40"}`}
      >
        {saved ? "★" : "☆"}
      </button>
      {(job.status === "stopped" || job.status === "error" || (job.status === "done" && job.truncated && job.resume)) && (
        <button
          type="button"
          onClick={onResume}
          className="shrink-0 rounded-full bg-fuchsia-500 px-2.5 py-1 font-semibold text-white"
          title={job.resume ? "止まったところから再開" : "最初からやり直す"}
        >
          ▶ {job.resume ? "続きから" : "やり直す"}
        </button>
      )}
      {job.status === "running" ? (
        <button type="button" onClick={onStop} className="shrink-0 rounded-full bg-neutral-100 px-2.5 py-1 font-semibold dark:bg-neutral-800">
          停止
        </button>
      ) : (
        <button type="button" onClick={onRemove} aria-label="削除" className="shrink-0 px-1.5 text-base text-neutral-400 hover:text-red-500">
          ×
        </button>
      )}
      </div>
      {job.gated && job.gated.length > 0 && (
        <button
          type="button"
          onClick={onFold}
          aria-expanded={!job.folded}
          className="mt-1.5 flex w-full items-center justify-between rounded-lg bg-neutral-100 px-2.5 py-1.5 text-[11px] font-semibold text-neutral-500 dark:bg-neutral-800 dark:text-neutral-300"
        >
          <span>タップで開くタイル {job.gated.length} 件</span>
          <span>{job.folded ? "▼ 開く" : "▲ 畳む"}</span>
        </button>
      )}
      {job.gated && job.gated.length > 0 && !job.folded && <GatedPages pages={job.gated} newSince={newSince} />}
    </li>
  );
}

/**
 * 「人間かどうかの確認」を求められた・自動アクセスを断られたので、このアプリでは読めなかったページ。
 * 本人のブラウザでサイトを直接開いてもらう（確認は本人がふつうに通れる）
 */
function GatedPages({ pages, newSince }: { pages: Gated[]; newSince: number }) {
  // 下までスクロールしたら、12 件ずつ足して表示する
  const [count, setCount] = useState(12);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = end.current;
    if (!el || count >= pages.length) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setCount((n) => n + 12), { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [count, pages.length]);
  const shown = pages.slice(0, count);
  return (
    <div className="mt-2 border-t border-neutral-100 pt-2 dark:border-neutral-800">
      <p className="mb-1.5 text-[11px] text-neutral-500">
        {pages.some((g) => g.app) && pages.every((g) => g.app)
          ? `📱 アプリでしか再生できない動画 ${pages.length} 件。タップすると ${pages[0].app} を開きます`
          : `🔐 このアプリでは再生できなかったもの ${pages.length} 件。タップすると動画（わからないときはサイト）を直接開きます`}
      </p>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {shown.map((g) => (
          <li key={g.url}>
            <a
              href={g.video ?? g.url}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
              className={`relative block aspect-[4/3] overflow-hidden rounded-lg bg-neutral-200 dark:bg-neutral-800 ${
                newSince > 0 && (g.at ?? 0) >= newSince ? "ring-2 ring-amber-400" : ""
              }`}
              title={g.video ?? g.url}
            >
              {g.thumb ? (
                // eslint-disable-next-line @next/next/no-img-element -- 外部サイトのサムネイル
                <img src={g.thumb} alt="" referrerPolicy="no-referrer" loading="lazy" className="h-full w-full object-cover" />
              ) : (
                <span className="flex h-full w-full items-center justify-center break-all px-2 text-center text-[11px] leading-tight text-neutral-500">
                  {g.url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60)}
                </span>
              )}
              {g.title ? (
                <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/70 to-transparent px-1.5 pb-7 pt-4 text-[10px] text-white">{g.title}</span>
              ) : null}
              {newSince > 0 && (g.at ?? 0) >= newSince ? (
                <span className="absolute right-1 top-1 rounded-md bg-amber-400 px-1.5 py-0.5 text-[10px] font-extrabold text-black shadow">NEW</span>
              ) : null}
              {g.duration ? (
                <span className="absolute left-1 top-1 rounded bg-black/65 px-1.5 py-0.5 text-[11px] font-semibold text-white">{clock(g.duration)}</span>
              ) : null}
              <span className="absolute bottom-1 right-1 rounded-md bg-black/65 px-2 py-1 text-[11px] font-bold text-white">
                {g.video ? "▶ 動画を開く" : g.app ? `↗ ${g.app} で開く` : "↗ サイトで開く"}
              </span>
            </a>
          </li>
        ))}
      </ul>
      {count < pages.length && (
        <div ref={end} className="py-3 text-center text-[11px] text-neutral-400">
          読み込み中… （残り {pages.length - count} 件）
        </div>
      )}
    </div>
  );
}

/**
 * 一番下までスクロールしたら、続きを取得する（ページ数の上限で打ち切った取得を、続きから再開する）。
 * 画面が短くて最初から見えているときは勝手に始めず、ボタンを押してもらう
 */
function LoadMore({ jobs, running, onMore }: { jobs: Job[]; running: boolean; onMore: (job: Job) => void }) {
  // 一度に続けるのは 3 つまで（検索から探すと取得が十数個になる。読んだページの少ないものから順に）
  const more = jobs
    .filter((j) => j.status === "done" && j.truncated && j.resume)
    .sort((a, b) => a.pages - b.pages)
    .slice(0, 3);
  const end = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);
  const latest = useRef({ more, running, onMore });
  useEffect(() => {
    latest.current = { more, running, onMore };
  });
  useEffect(() => {
    const onScroll = () => (scrolled.current = true);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    const el = end.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        const { more: m, running: busy, onMore: go } = latest.current;
        if (!e.isIntersecting || !scrolled.current || busy || !m.length) return;
        scrolled.current = false;
        for (const j of m) go(j);
      },
      { rootMargin: "600px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  if (!more.length && !running) return <div ref={end} />;
  return (
    <div ref={end} className="py-6 text-center">
      {running ? (
        <span className="animate-pulse text-xs font-semibold text-fuchsia-500">続きを読み込み中…</span>
      ) : (
        <button type="button" onClick={() => more.forEach(onMore)} className="rounded-full bg-neutral-900 px-5 py-2 text-xs font-bold text-white dark:bg-white dark:text-neutral-900">
          {more.some((j) => j.settings?.hunt) ? "さらに深く探す" : "もっと読み込む"}
        </button>
      )}
    </div>
  );
}

/**
 * サムネイル 1 枚。
 * - 画像・サムネイルは、まず元サイトから直接読み込み（referrerPolicy=no-referrer で直リンク制限を避ける）、
 *   失敗したらサーバー中継で再挑戦。画像がそれでも駄目なら一覧から外す
 * - サムネイルのない動画（または読み込めなかった動画）は、画面に見えたら動画から 1 コマ取り出して作る
 */
function Thumb({
  item,
  isNew,
  shape,
  large,
  small,
  onOpen,
  onBroken,
  onDead,
  revive,
  onDuration,
}: {
  /** 今回の取得で増えたもの（NEW の印と枠を付ける） */
  isNew: boolean;
  /** 読み込めなかった画像に、リンク切れの印を付ける */
  onDead: (id: string) => void;
  /** 「復活したら保存」の状態（見張っていなければ undefined） */
  revive?: ReviveRow;
  item: Item;
  shape: Shape;
  /** 大きく表示しているとき（題名も出す） */
  large: boolean;
  /** 小さく表示しているとき（印を小さくする） */
  small: boolean;
  onOpen: () => void;
  onBroken: (id: string) => void;
  /** 画面で再生時間がわかったとき */
  onDuration: (id: string, duration: number) => void;
}) {
  const imageSrc = item.kind === "image" ? item.src : item.thumb;
  const [attempt, setAttempt] = useState(0);
  const [imgFailed, setImgFailed] = useState(false);
  const [captured, setCaptured] = useState<string | null | undefined>(() => peekVideoThumb(item.src));
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const video = isVideoLike(item);
  const needCapture = item.kind === "video" && !isHls(item) && (!imageSrc || imgFailed) && captured === undefined;
  /** サーバーが長さを調べられなかった動画は、画面で調べる（埋め込み動画は調べられない） */
  const needDuration = item.kind === "video" && !item.duration;
  const proxied = proxyUrl(item);

  // 画面に入ったら（少し手前から）作り始める。一度見えたら覚えておく
  useEffect(() => {
    if (!(needCapture || needDuration) || visible) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [needCapture, needDuration, visible]);

  // 長さ：1 コマを作るときにわかればそれを使い、なければ動画の最初の情報だけ読んで調べる
  const report = useRef(onDuration);
  useEffect(() => {
    report.current = onDuration;
  });
  useEffect(() => {
    if (!needDuration || !visible || needCapture) return;
    let alive = true;
    const known = peekVideoDuration(item.src);
    const job = known !== undefined ? Promise.resolve(known) : getVideoDuration(item.src, proxied, isHls(item));
    void job.then((d) => {
      if (alive && d) report.current(item.id, d);
    });
    return () => {
      alive = false;
    };
  }, [needDuration, visible, needCapture, item, proxied]);

  useEffect(() => {
    if (!needCapture || !visible) return;
    let alive = true;
    void getVideoThumb(item.src, proxied).then((result) => {
      if (alive) setCaptured(result);
    });
    return () => {
      alive = false;
    };
  }, [needCapture, visible, item.src, proxied]);

  const duration = item.duration ?? (item.kind === "video" ? (peekVideoDuration(item.src) ?? undefined) : undefined);

  const onError = () => {
    if (attempt === 0) setAttempt(1);
    else if (item.kind === "image") onDead(item.id);
    else setImgFailed(true);
  };

  let media: React.ReactNode;
  if (imageSrc && !imgFailed) {
    // 合言葉（Cookie）が要るファイルは、直接では読めないので最初から中継で読む
    const viaProxy = attempt > 0 || (!!item.cookie && imageSrc === item.src);
    const src = viaProxy ? proxyUrl({ src: imageSrc, pageUrl: item.pageUrl, cookie: imageSrc === item.src ? item.cookie : undefined }) : imageSrc;
    media = (
      // eslint-disable-next-line @next/next/no-img-element -- 外部サイトの任意の画像を出すため next/image は使わない
      <img
        src={src}
        alt={item.title ?? ""}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={onError}
        onLoad={(e) => {
          const img = e.currentTarget;
          // アイコンなどの小さすぎる画像は一覧から外す
          if (item.kind === "image" && img.naturalWidth < 48 && img.naturalHeight < 48) onBroken(item.id);
        }}
        className="h-full w-full object-cover"
      />
    );
  } else if (captured) {
    // eslint-disable-next-line @next/next/no-img-element -- 端末の中で作った画像（data URL）
    media = <img src={captured} alt={item.title ?? ""} className="h-full w-full object-cover" />;
  } else {
    media = (
      <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-gradient-to-br from-neutral-700 to-neutral-900 text-white">
        <span className={`text-2xl ${needCapture ? "animate-pulse" : ""}`}>🎬</span>
        {needCapture && <span className="text-[9px] opacity-60">サムネ作成中</span>}
      </div>
    );
  }

  return (
    <button
      ref={ref}
      type="button"
      onClick={onOpen}
      className={`group relative block w-full overflow-hidden rounded-lg bg-neutral-200 active:scale-[0.97] dark:bg-neutral-800 ${
        shape === "wide" ? "aspect-video" : "aspect-square"
      } ${isNew ? "ring-2 ring-amber-400" : ""} ${item.dead && revive?.status !== "saved" ? "opacity-60 grayscale" : ""}`}
    >
      {media}
      {(item.dead || revive) && (
        <span
          className={`absolute left-1 rounded-md font-bold text-white shadow ${small ? "top-4 px-1 text-[8px]" : "top-7 px-1.5 py-0.5 text-[10px]"} ${
            revive?.status === "saved" ? "bg-emerald-600/95" : item.dead ? "bg-neutral-700/95" : "bg-amber-500/95"
          }`}
        >
          {revive?.status === "saved"
            ? small
              ? "💾"
              : "💾 保存済み"
            : [item.dead ? (small ? "⚠" : "⚠ リンク切れ") : "", revive ? (revive.status === "found" || revive.status === "saving" ? "⏳" : "🔔") : ""].filter(Boolean).join(" ")}
        </span>
      )}
      {item.revivedAt && !item.dead && !small && (
        <span className="absolute right-1 top-7 rounded-md bg-emerald-500/95 px-1.5 py-0.5 text-[10px] font-bold text-white shadow">🔁 復活</span>
      )}
      {isNew && (
        <span
          className={`absolute right-1 top-1 rounded-md bg-amber-400 font-extrabold text-black shadow ${small ? "px-1 text-[8px]" : "px-1.5 py-0.5 text-[10px]"}`}
        >
          NEW
        </span>
      )}
      <span
        className={`absolute left-1 top-1 rounded-md font-bold text-white shadow ${
          small ? "px-1 text-[8px]" : "px-1.5 py-0.5 text-[10px]"
        } ${video ? "bg-red-500/90" : "bg-sky-500/90"}`}
      >
        {small ? (video ? "🎬" : "🖼") : video ? "🎬 動画" : "🖼 画像"}
      </span>
      {item.format && !small && (
        <span className="absolute bottom-1 left-1 max-w-[60%] truncate rounded bg-black/60 px-1 py-0.5 text-[9px] font-semibold text-white">
          {item.format}
        </span>
      )}
      {duration ? (
        <span
          className={`absolute bottom-1 right-1 rounded bg-black/75 font-bold tabular-nums text-white ${small ? "px-1 text-[9px]" : "px-1.5 py-0.5 text-[11px]"}`}
        >
          {formatDuration(duration)}
        </span>
      ) : null}
      {!small && (large || video) && item.title && (
        <span
          className={`pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent text-left font-semibold text-white ${
            large ? "line-clamp-2 px-2 pb-6 pt-6 text-xs" : "line-clamp-1 px-1.5 pb-5 pt-4 text-[10px]"
          }`}
        >
          {item.title}
        </span>
      )}
    </button>
  );
}

/**
 * 動画プレーヤー。再生できる方法を順番に試す。
 *   1. 元のサイトから直接（このアプリの URL は相手に伝えない。ブラウザで直接開くのと同じ扱い）
 *   2. 駄目ならこちらのサーバー経由（元ページを Referer として名乗る）
 * 配信形式（HLS）は、iPhone ならそのまま、ほかのブラウザでは hls.js で再生する。
 */
function VideoPlayer({ item, onGiveUp, onStage }: { item: Item; onGiveUp: () => void; onStage: (stage: "direct" | "proxy") => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  // 合言葉（Cookie）が要る動画（Gofile など）は、この端末から直接は読めないので最初からサーバー経由
  const [stage, setStage] = useState<"direct" | "proxy">(item.cookie ? "proxy" : "direct");
  /** 切り替える前に再生していた位置（切り替え後に続きから再生する） */
  const resumeAt = useRef(0);
  const giveUp = useRef(onGiveUp);
  const stageChanged = useRef(onStage);
  useEffect(() => {
    giveUp.current = onGiveUp;
    stageChanged.current = onStage;
  });

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    let cancelled = false;
    let started = false;
    let player: { destroy: () => void } | null = null;
    const url = stage === "direct" ? item.src : proxyUrl(item);
    stageChanged.current(stage);

    const fail = () => {
      if (cancelled) return;
      cancelled = true;
      if (v.currentTime > 0) resumeAt.current = v.currentTime;
      if (stage === "direct") setStage("proxy");
      else giveUp.current();
    };
    const onMeta = () => {
      started = true;
      if (resumeAt.current > 0 && Number.isFinite(v.duration) && resumeAt.current < v.duration) v.currentTime = resumeAt.current;
    };
    const play = () => void v.play().catch(() => {});
    // 直接の読み込みが、つながったまま進まないとき（相手が返事をしない）は、サーバー経由に切り替える。
    // ブラウザが通信量の節約のために読み込みを待っているだけ（networkState が読み込み中でない）なら切り替えない
    const watchdog =
      stage === "direct"
        ? setTimeout(() => !started && v.readyState === 0 && v.networkState === HTMLMediaElement.NETWORK_LOADING && fail(), 12000)
        : undefined;
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("error", fail);

    if (isHls(item) && !v.canPlayType("application/vnd.apple.mpegurl")) {
      // iPhone 以外のブラウザは HLS をそのまま再生できないので、hls.js に任せる
      void import("hls.js")
        .then(({ default: Hls }) => {
          if (cancelled) return;
          if (!Hls.isSupported()) return fail();
          const hls = new Hls({ enableWorker: true });
          player = hls;
          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (data.fatal) fail();
          });
          hls.on(Hls.Events.MANIFEST_PARSED, play);
          hls.loadSource(url);
          hls.attachMedia(v);
        })
        .catch(fail);
    } else {
      v.src = url;
      v.load();
      play();
    }
    return () => {
      cancelled = true;
      clearTimeout(watchdog);
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("error", fail);
      player?.destroy();
      v.pause();
      v.removeAttribute("src");
      v.load();
    };
  }, [item, stage]);

  return (
    <video
      ref={ref}
      poster={item.thumb ?? peekVideoThumb(item.src) ?? undefined}
      controls
      autoPlay
      playsInline
      className="max-h-full max-w-full rounded-lg bg-black"
    />
  );
}

/** 「復活したら保存」の保存先（Google ドライブ・Vercel Blob）の表示と、Google ドライブをつなぐ・切る */
/** 公開鍵（base64url）を、ブラウザの購読に渡す形にする */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * 自動巡回で新しい動画が見つかったら、この端末にプッシュ通知する（オン・オフ）。
 * iPhone・iPad は、Safari の「ホーム画面に追加」で入れたアプリから開いたときだけ使える
 */
function PushToggle() {
  const [state, setState] = useState<"loading" | "unsupported" | "ios-browser" | "denied" | "off" | "on" | "busy">("loading");
  const [note, setNote] = useState<string | null>(null);
  const regRef = useRef<ServiceWorkerRegistration | null>(null);
  useEffect(() => {
    void (async () => {
      const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
      const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        return setState(ios && !standalone ? "ios-browser" : "unsupported");
      }
      if (Notification.permission === "denied") return setState("denied");
      try {
        const reg = await navigator.serviceWorker.register("/thumbs-sw.js", { scope: "/thumbs-push/" });
        regRef.current = reg;
        const sub = await reg.pushManager.getSubscription();
        if (!sub) return setState("off");
        const res = await fetch(`/api/thumbs/push?endpoint=${encodeURIComponent(sub.endpoint)}`).catch(() => null);
        const data = (res?.ok ? await res.json().catch(() => null) : null) as { subscribed?: boolean } | null;
        setState(data?.subscribed ? "on" : "off");
      } catch {
        setState("unsupported");
      }
    })();
  }, []);
  const turnOn = async () => {
    setState("busy");
    setNote(null);
    try {
      // 許可を聞くのは、ボタンを押したときだけ（ブラウザの決まり）
      const perm = await Notification.requestPermission();
      if (perm !== "granted") return setState(perm === "denied" ? "denied" : "off");
      const reg = regRef.current ?? (await navigator.serviceWorker.register("/thumbs-sw.js", { scope: "/thumbs-push/" }));
      await navigator.serviceWorker.ready.catch(() => null);
      const info = (await (await fetch("/api/thumbs/push")).json()) as { publicKey?: string };
      if (!info.publicKey) throw new Error("サーバーの準備ができていません（データベースが必要です）");
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(info.publicKey) }));
      const label = /iphone|ipad/i.test(navigator.userAgent) ? "iPhone・iPad" : /android/i.test(navigator.userAgent) ? "Android" : "パソコン";
      const res = await fetch("/api/thumbs/push", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "subscribe", sub: sub.toJSON(), label }) });
      if (!res.ok) throw new Error(`登録できませんでした（HTTP ${res.status}）`);
      setState("on");
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
      setState("off");
    }
  };
  const turnOff = async () => {
    setState("busy");
    const sub = await regRef.current?.pushManager.getSubscription().catch(() => null);
    if (sub) {
      await fetch("/api/thumbs/push", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "unsubscribe", endpoint: sub.endpoint }) }).catch(() => null);
      await sub.unsubscribe().catch(() => false);
    }
    setState("off");
  };
  const test = async () => {
    setNote("送っています…");
    const res = await fetch("/api/thumbs/push", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "test" }) }).catch(() => null);
    const data = (res?.ok ? await res.json().catch(() => null) : null) as { sent?: number } | null;
    setNote(data?.sent ? `テストの通知を送りました（${data.sent} 台）` : "送れませんでした");
  };
  if (state === "loading") return null;
  return (
    <span className="flex flex-wrap items-center gap-2 text-[11px]">
      {state === "unsupported" && <span className="text-neutral-400">🔕 このブラウザはプッシュ通知に対応していません</span>}
      {state === "ios-browser" && (
        <span className="text-neutral-400">🔔 新着のプッシュ通知：iPhone は、共有ボタン →「ホーム画面に追加」で入れたアプリから開くと使えます</span>
      )}
      {state === "denied" && <span className="text-neutral-400">🔕 通知が許可されていません（端末の設定で、このアプリの通知を許可してください）</span>}
      {(state === "off" || state === "busy") && (
        <button type="button" disabled={state === "busy"} onClick={() => void turnOn()} className="rounded-full bg-sky-600 px-3 py-1 font-bold text-white disabled:opacity-60">
          🔔 新着をプッシュ通知
        </button>
      )}
      {state === "on" && (
        <>
          <span className="font-semibold text-emerald-600 dark:text-emerald-400">🔔 新着を通知します</span>
          <button type="button" onClick={() => void test()} className="rounded-full bg-neutral-200/70 px-2.5 py-0.5 font-bold dark:bg-neutral-800">
            テスト
          </button>
          <button type="button" onClick={() => void turnOff()} className="rounded-full bg-neutral-200/70 px-2.5 py-0.5 font-bold dark:bg-neutral-800">
            やめる
          </button>
        </>
      )}
      {note && <span className="text-neutral-400">{note}</span>}
    </span>
  );
}

function DrivePanel({ drive, note, onChanged }: { drive: DriveInfo | null; note: string | null; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; steps: { name: string; ok: boolean; ms: number; detail?: string }[] } | "running" | null>(null);
  if (!drive) return null;
  const runTest = async () => {
    setTest("running");
    const res = await fetch("/api/thumbs/drive", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "test" }) }).catch(() => null);
    const data = res?.ok ? await res.json().catch(() => null) : null;
    setTest(data ?? { ok: false, steps: [{ name: "サーバーに頼む", ok: false, ms: 0, detail: `返事がありませんでした（${res ? `HTTP ${res.status}` : "通信エラー"}）` }] });
  };
  return (
    <div className="space-y-1.5 rounded-lg bg-white/60 px-2.5 py-2 dark:bg-black/20">
      {note && <p className="font-semibold">{note}</p>}
      {drive.connected ? (
        <p className="flex flex-wrap items-center gap-2">
          <span>
            💾 保存先：<b>Google ドライブ</b>
            {drive.email ? `（${drive.email}）` : ""}の「サムネ収集（復活保存）」フォルダ
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              if (!confirm("Google ドライブとのつながりを切りますか？（保存した動画はドライブに残ります。これからは Vercel Blob に保存します）")) return;
              setBusy(true);
              await fetch("/api/thumbs/drive", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "disconnect" }) }).catch(() => null);
              setBusy(false);
              onChanged();
            }}
            className="rounded-full bg-black/10 px-2.5 py-1 font-semibold dark:bg-white/10"
          >
            つながりを切る
          </button>
          <button
            type="button"
            disabled={test === "running"}
            onClick={() => void runTest()}
            className="rounded-full bg-sky-600 px-2.5 py-1 font-semibold text-white disabled:opacity-60"
          >
            {test === "running" ? "🧪 テスト中…（30 秒ほど）" : "🧪 テスト保存"}
          </button>
        </p>
      ) : drive.configured ? (
        <p className="flex flex-wrap items-center gap-2">
          <span>💾 保存先：Vercel Blob（非公開）</span>
          <a href="/api/thumbs/drive/connect" className="rounded-full bg-sky-600 px-3 py-1 font-bold text-white">
            Google ドライブとつなぐ
          </a>
        </p>
      ) : (
        <details>
          <summary className="cursor-pointer">💾 保存先：Vercel Blob（非公開）・Google ドライブに保存するには（設定の手順）</summary>
          <ol className="mt-1.5 list-decimal space-y-1 pl-5">
            <li>
              <a href="https://console.cloud.google.com/" target="_blank" rel="noopener noreferrer" className="underline">
                Google Cloud
              </a>
              でプロジェクトを作り、「Google Drive API」を有効にする
            </li>
            <li>「OAuth 同意画面」を作り（外部・アプリ名は自由）、スコープに drive.file を入れて「公開（本番）」にする（テスト中のままだと 7 日ごとにつなぎ直しが必要）</li>
            <li>
              「認証情報」→「OAuth クライアント ID」（ウェブ アプリケーション）を作り、「承認済みのリダイレクト URI」に次を登録する：
              <br />
              <code className="break-all select-all rounded bg-black/10 px-1 dark:bg-white/10">{drive.redirectUri}</code>
            </li>
            <li>できたクライアント ID とシークレットを、Vercel の環境変数 GOOGLE_DRIVE_CLIENT_ID・GOOGLE_DRIVE_CLIENT_SECRET に入れて、配置し直す</li>
            <li>この欄に出る「Google ドライブとつなぐ」を押して許可する</li>
          </ol>
        </details>
      )}
      {test && test !== "running" && (
        <div className="rounded bg-black/5 px-2 py-1.5 dark:bg-white/5">
          <p className="font-bold">{test.ok ? "✅ テスト成功：Google ドライブに保存できます" : "❌ テスト失敗"}</p>
          <ul className="mt-1 space-y-0.5">
            {test.steps.map((s) => (
              <li key={s.name}>
                {s.ok ? "✅" : "❌"} {s.name}
                <span className="opacity-60">
                  {" "}
                  {(s.ms / 1000).toFixed(1)} 秒{s.detail ? `・${s.detail}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Viewer({
  items,
  index,
  onIndex,
  onClose,
  onExclude,
  onBroken,
  reviveOn,
  revive,
  driveOn,
  onWatch,
  onRemove,
}: {
  items: Item[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  onExclude: (host: string) => void;
  /** リンク切れで見られなかったものに、リンク切れの印を付ける（一覧には残す） */
  onBroken: (id: string) => void;
  /** 「復活したら保存」が使えるか（サーバーの保存先があるか） */
  reviveOn: boolean;
  revive: Map<string, ReviveRow>;
  /** Google ドライブがつながっているか（つながっていれば「ドライブに保存」を出す） */
  driveOn: boolean;
  onWatch: (item: Item, on: boolean) => void;
  /** 一覧から消す（手動） */
  onRemove: (item: Item) => void;
}) {
  const item = items[index];
  const key = rkOf(item);
  const row = key ? revive.get(key) : undefined;
  const saved = row?.status === "saved" && key ? key : null;
  /** リンク切れを外したことのお知らせ（次の動画に切り替わったあとも少し出しておく） */
  const [removed, setRemoved] = useState<string | null>(null);
  const [useProxy, setUseProxy] = useState(!!item.cookie);
  /** 動画をどこから読んでいるか（直接 / サーバー経由） */
  const [stage, setStage] = useState<"direct" | "proxy">("direct");
  /** 再生・表示できなかった理由（サーバー経由でも駄目だったとき、調べて出す） */
  const [playError, setPlayError] = useState<string | null>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);

  const go = useCallback(
    (delta: number) => {
      const next = index + delta;
      if (next >= 0 && next < items.length) {
        setUseProxy(!!items[next].cookie);
        setPlayError(null);
        setRemoved(null);
        onIndex(next);
      }
    },
    [index, items, onIndex],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [go, onClose]);

  const direct = item.src;
  const src = useProxy ? proxyUrl(item) : direct;
  const canDownload = item.kind !== "embed" && !isHls(item);
  /** ダウンロードの状態（直接読んでいる途中の割合・どちらで落としたか） */
  const [dl, setDl] = useState<{ id: string; state: "direct" | "server" | "done"; ratio: number | null } | null>(null);
  const dlHere = dl?.id === item.id ? dl : null;
  const download = async (target: Item) => {
    const name = decodeURIComponent(new URL(target.src).pathname.split("/").pop() || "") || undefined;
    setDl({ id: target.id, state: "direct", ratio: null });
    const ok = await downloadDirect(target, name, (ratio) => setDl({ id: target.id, state: "direct", ratio })).catch(() => false);
    if (ok === "canceled") return setDl(null);
    if (ok) return setDl({ id: target.id, state: "done", ratio: 1 });
    // 直接は読めなかった：サーバー経由で（転送量がかかる）
    setDl({ id: target.id, state: "server", ratio: null });
    triggerDownload(proxyUrl(target, { download: true, name }), name);
  };
  /** 「ドライブに保存」の状態（動画ごと。別の動画に切り替えても、保存中のものは続く） */
  const [driveSaves, setDriveSaves] = useState<Record<string, { state: "saving" | "done" | "error"; id?: string; message?: string }>>({});
  const driveSave = driveSaves[item.id];
  const saveToDrive = async (target: Item) => {
    setDriveSaves((m) => ({ ...m, [target.id]: { state: "saving" } }));
    const res = await fetch("/api/thumbs/drive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "save",
        item: { src: target.src, pageUrl: target.pageUrl, referer: target.referer, cookie: target.cookie, title: target.title ?? fileName },
      }),
    }).catch(() => null);
    const data = (res ? await res.json().catch(() => null) : null) as { ok?: boolean; id?: string; error?: string } | null;
    setDriveSaves((m) => ({
      ...m,
      [target.id]: data?.ok && data.id ? { state: "done", id: data.id } : { state: "error", message: data?.error ?? (res ? `HTTP ${res.status}` : "通信が切れました") },
    }));
  };
  const fileName = decodeURIComponent(new URL(item.src).pathname.split("/").pop() || "") || undefined;

  /** 直接もサーバー経由も駄目だったとき、サーバー経由で少しだけ取りに行って理由を調べる */
  const diagnose = useCallback(async () => {
    try {
      const res = await fetch(proxyUrl(item), { headers: { range: "bytes=0-1" } });
      if (!res.ok) {
        const text = (await res.text().catch(() => "")).slice(0, 120);
        if (res.status === 401) {
          setPlayError("パスワードの有効期限が切れました。ページを読み込み直してください。");
          return;
        }
        // こちらのサーバー側の不調（時間切れなど）は、リンク切れとは限らないので外さない
        if (![400, 415, 502].includes(res.status)) {
          setPlayError(`再生できませんでした（サーバーの不調：HTTP ${res.status}）。少し待ってもう一度お試しください。`);
          return;
        }
        // 本当にリンク切れか、もう一度だけ確かめてから外す（ダウンロード用の仕組みなど、再生の読み方だけ失敗することがある）
        if ((await checkLink(item)) !== "no") {
          setPlayError(`この動画はこの画面では再生できませんでした（${text || `HTTP ${res.status}`}）。「動画を直接開く」か「ダウンロード」を試してください。`);
          return;
        }
        // 直接もサーバー経由も読めず、確かめてもリンク切れだった。リンク切れの印を付ける（一覧には残す）
        setRemoved(`リンク切れでした（${text || `HTTP ${res.status}`}）。一覧に「⚠ リンク切れ」の印を付けて残しました`);
        onBroken(item.id);
      } else {
        const type = res.headers.get("content-type") ?? "不明";
        setPlayError(`動画のデータは届いていますが、この端末では再生できない形式です（${type}）。「動画を直接開く」か「ダウンロード」を試してください。`);
      }
    } catch {
      setPlayError("通信できませんでした。電波の状態を確認してください。");
    }
  }, [item, onBroken]);

  let body: React.ReactNode;
  if (saved) {
    // 「復活したら保存」でサーバーに保存した動画（元のリンクが切れていても見られる）
    body = (
      <video key={`saved-${item.id}`} src={savedUrl(saved)} poster={item.thumb} controls autoPlay playsInline className="max-h-full max-w-full rounded-lg bg-black" />
    );
  } else if (item.dead) {
    body = (
      <div key={`dead-${item.id}`} className="max-w-sm space-y-3 rounded-xl bg-white/5 p-4 text-center text-sm">
        {item.thumb && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.thumb} alt="" referrerPolicy="no-referrer" className="mx-auto max-h-48 rounded-lg opacity-60 grayscale" />
        )}
        <p className="font-bold">⚠ リンク切れ</p>
        <p className="text-xs opacity-70">
          元のファイルが消されたか、移動されました（{new Date(item.dead).toLocaleDateString("ja-JP")} に確認）。一覧には残してあります。
        </p>
        {item.kind === "video" &&
          (!reviveOn ? (
            <p className="text-[11px] opacity-60">「復活したら保存」は、サーバーの保存先（データベース・Blob）が使えるときだけ使えます</p>
          ) : !key ? (
            <p className="text-[11px] opacity-60">この動画は見分ける手がかりがないため、「復活したら保存」を付けられません</p>
          ) : row?.status === "found" || row?.status === "saving" ? (
            <p className="text-xs text-emerald-300">⏳ 同じ動画が見つかりました。サーバーに保存しています…</p>
          ) : (
            <button
              type="button"
              onClick={() => onWatch(item, !row)}
              className={`w-full rounded-full py-2.5 text-sm font-bold ${row ? "bg-amber-500 text-black" : "bg-white/15"}`}
            >
              {row ? "🔔 復活したら保存：オン（タップで外す）" : "🔔 復活したら保存する"}
            </button>
          ))}
        {row?.status === "failed" && row.note && <p className="text-[11px] text-red-300">前回の保存は失敗しました：{row.note}</p>}
        {row && row.status === "watch" && (
          <p className="text-[11px] opacity-60">
            {/^\d/.test(key ?? "")
              ? "巡回・取得で同じ動画（同じファイル）が見つかったら、サーバーに保存します"
              : "巡回・取得で、同じ URL か同じファイル名の動画が見つかったら、サーバーに保存します（中身の指紋がない動画なので、名前を変えて上げ直されたものは見つけられません）"}
          </p>
        )}
      </div>
    );
  } else if (item.kind === "embed") {
    body = (
      <iframe
        key={item.id}
        src={`${item.src}${item.src.includes("?") ? "&" : "?"}autoplay=1&playsinline=1`}
        title={item.title ?? "動画"}
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        allowFullScreen
        className="aspect-video w-full max-w-4xl rounded-lg bg-black"
      />
    );
  } else if (item.kind === "video") {
    body = <VideoPlayer key={item.id} item={item} onStage={setStage} onGiveUp={() => void diagnose()} />;
  } else {
    body = (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        key={`${item.id}-${useProxy}`}
        src={src}
        alt={item.title ?? ""}
        referrerPolicy="no-referrer"
        onError={() => !useProxy && setUseProxy(true)}
        className="max-h-full max-w-full object-contain"
      />
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black text-white"
      role="dialog"
      aria-modal="true"
      onTouchStart={(e) => (touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY })}
      onTouchEnd={(e) => {
        if (!touch.current) return;
        const dx = e.changedTouches[0].clientX - touch.current.x;
        const dy = e.changedTouches[0].clientY - touch.current.y;
        touch.current = null;
        // 横スワイプで前後、下スワイプで閉じる
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
        else if (dy > 100 && Math.abs(dy) > Math.abs(dx) * 1.5) onClose();
      }}
    >
      <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))] text-xs">
        <span className="rounded-md bg-white/10 px-2 py-1 font-semibold">
          {item.kind === "image" ? "🖼 画像" : "🎬 動画"}
          {item.format ? ` ・ ${item.format}` : ""}
          {item.duration ? ` ・ ${formatDuration(item.duration)}` : ""}
        </span>
        <span className="opacity-60">
          {index + 1} / {items.length}
        </span>
        <button type="button" onClick={onClose} aria-label="閉じる" className="h-9 w-9 rounded-full bg-white/10 text-lg">
          ×
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center px-2">
        {body}
        {index > 0 && (
          <button
            type="button"
            onClick={() => go(-1)}
            aria-label="前へ"
            className="absolute left-2 top-1/2 hidden h-10 w-10 -translate-y-1/2 rounded-full bg-white/10 sm:block"
          >
            ‹
          </button>
        )}
        {index < items.length - 1 && (
          <button
            type="button"
            onClick={() => go(1)}
            aria-label="次へ"
            className="absolute right-2 top-1/2 hidden h-10 w-10 -translate-y-1/2 rounded-full bg-white/10 sm:block"
          >
            ›
          </button>
        )}
      </div>

      <div className="space-y-2 px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
        {removed && <div className="rounded-lg bg-amber-500/20 px-3 py-2 text-xs text-amber-100">🧹 {removed}</div>}
        {playError && (
          <div className="whitespace-pre-line rounded-lg bg-red-500/20 px-3 py-2 text-xs text-red-200">
            ⚠ {playError}
          </div>
        )}
        {item.title && <p className="line-clamp-2 text-sm">{item.title}</p>}
        <p className="flex items-center gap-2 text-[11px]">
          <span className="min-w-0 truncate opacity-50">
            {hostOf(item.pageUrl)}
            {item.kind === "video" && stage === "proxy" && !playError ? " ・ サーバー経由で再生" : ""}
          </span>
          {item.kind === "video" && (
            <a href={item.src} target="_blank" rel="noopener noreferrer" className="shrink-0 font-semibold underline opacity-80">
              ▶ 動画を直接開く
            </a>
          )}
        </p>
        {/* リンク切れの判定（慎重に何度か確かめる）を待たずに、開いたらすぐ 🔔 を付けられる。再生できている動画にも先に付けておける */}
        {reviveOn && item.kind === "video" && !item.dead && !saved && key && (
          <button
            type="button"
            onClick={() => onWatch(item, !row)}
            className={`w-full rounded-full py-2 text-xs font-bold ${row ? "bg-amber-500 text-black" : playError ? "bg-amber-500/80 text-black" : "bg-white/10"}`}
          >
            {row?.status === "found" || row?.status === "saving"
              ? "⏳ 同じ動画が見つかりました。保存しています…"
              : row
                ? "🔔 消えても復活したら保存：オン（タップで外す）"
                : playError
                  ? "🔔 見られないときは：復活したら保存する"
                  : "🔔 消えても、復活したら保存する"}
          </button>
        )}
        {(saved || item.dead) && (
          <div className="flex gap-2">
            {saved && (
              <a href={savedUrl(saved, true)} className="flex-1 rounded-full bg-emerald-600 py-2.5 text-center text-sm font-bold">
                ⬇ 保存した動画をダウンロード
              </a>
            )}
            {saved && row?.driveId && (
              <a
                href={`https://drive.google.com/file/d/${encodeURIComponent(row.driveId)}/view`}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-full bg-white/10 px-3 py-2.5 text-center text-sm font-semibold"
              >
                ドライブで開く
              </a>
            )}
            <button type="button" onClick={() => onRemove(item)} className="flex-1 rounded-full bg-white/10 py-2.5 text-sm font-semibold">
              🗑 一覧から消す
            </button>
          </div>
        )}
        {driveSave?.state === "done" && driveSave.id && (
          <p className="text-xs text-emerald-300">
            ✅ Google ドライブの「サムネ収集（復活保存）」フォルダに保存しました ・{" "}
            <a href={`https://drive.google.com/file/d/${encodeURIComponent(driveSave.id)}/view`} target="_blank" rel="noopener noreferrer" className="underline">
              ドライブで開く
            </a>
          </p>
        )}
        {dlHere?.state === "done" && <p className="text-xs text-emerald-300">⬇ 元のサイトから直接ダウンロードしました（サーバーの転送量はかかっていません）</p>}
        {dlHere?.state === "server" && (
          <p className="text-xs opacity-70">⬇ このサイトは直接のダウンロードを許可していないため、サーバー経由でダウンロードしています</p>
        )}
        {driveSave?.state === "saving" && <p className="text-xs opacity-70">⏳ ドライブに保存しています（大きい動画は数分かかります。ほかの動画を見ていても続きます）</p>}
        {driveSave?.state === "error" && <p className="text-xs text-red-300">ドライブに保存できませんでした：{driveSave.message}</p>}
        <div className={`flex gap-2 ${item.dead ? "hidden" : ""}`}>
          {canDownload ? (
            <button
              type="button"
              disabled={dlHere?.state === "direct"}
              onClick={() => void download(item)}
              className="flex-1 rounded-full bg-fuchsia-500 py-2.5 text-center text-sm font-bold disabled:opacity-70"
            >
              {dlHere?.state === "direct" ? `⬇ 直接読み込み中${dlHere.ratio !== null ? ` ${Math.round(dlHere.ratio * 100)}%` : "…"}` : "⬇ ダウンロード"}
            </button>
          ) : (
            <span className="flex-1 rounded-full bg-white/10 py-2.5 text-center text-xs opacity-70">
              {item.kind === "embed" ? "埋め込み動画は保存できません" : "配信形式（HLS）のため保存できません"}
            </span>
          )}
          {canDownload && driveOn && (
            <button
              type="button"
              disabled={driveSave?.state === "saving"}
              onClick={() => void saveToDrive(item)}
              className="rounded-full bg-sky-600 px-3 py-2.5 text-sm font-bold disabled:opacity-60"
              title="サーバーが元のサイトから読んで、Google ドライブに直接保存します（スマホの通信は使いません）"
            >
              {driveSave?.state === "saving" ? "⏳ 保存中" : driveSave?.state === "done" ? "✅ 保存済" : "📁 ドライブへ"}
            </button>
          )}
          <button
            type="button"
            onClick={() => onExclude(hostOf(item.pageUrl))}
            className="rounded-full bg-white/10 px-3 py-2.5 text-sm font-semibold"
            title="このサイトを除外リストに追加"
          >
            🚫 除外
          </button>
          <a
            href={item.pageUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full bg-white/10 px-4 py-2.5 text-sm font-semibold"
          >
            元ページ
          </a>
        </div>
      </div>
    </div>
  );
}
