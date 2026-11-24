/**
 * 動画からサムネイル画像を作る（ブラウザの中で）。
 *
 * サムネイルが見つからない動画は、動画を少しだけ読み込んで 1 コマを <canvas> に描き、JPEG にする。
 * - まず元のサーバーから直接読む（CORS を許可しているサーバーなら、こちらのサーバーを通らず通信量がかからない）
 * - 駄目ならこちらのサーバー経由（同じドメインになるので、描いた画像を取り出せる）
 * - 作ったサムネイルは端末の IndexedDB に保存し、次からはすぐ出す
 * - 同時に作るのは 2 本まで（画面に見えているものから順に）
 *
 * 再生時間（長さ）もここで調べる。サーバーが調べられなかった動画だけ、
 * 動画の最初の情報（メタデータ）だけを読んで長さを知る。HLS は目次の断片の長さを足す。
 */
import { playlistDuration } from "@/lib/thumbs/duration";

const DB_NAME = "thumbs-frames";
const STORE = "frames";
const MAX_ENTRIES = 4000;
/** 作れなかった動画は、1 日たつまで作り直さない */
const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const WIDTH = 320;
const TIMEOUT_MS = 15000;

interface Entry {
  /** JPEG の data URL。作れなかったときは空文字 */
  data: string;
  at: number;
  /** 1 コマを取り出したときにわかった長さ（秒） */
  duration?: number;
}

const memory = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();
/** わかった長さ（秒）。わからなかったものは null */
const durations = new Map<string, number | null>();
const durationJobs = new Map<string, Promise<number | null>>();
const finiteDuration = (d: number) => (Number.isFinite(d) && d > 0.5 && d < 7 * 24 * 3600 ? d : null);

// --- IndexedDB（端末の中の保存場所） ---

let dbPromise: Promise<IDBDatabase | null> | null = null;
function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  dbPromise ??= new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return dbPromise;
}

async function dbGet(key: string): Promise<Entry | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise((resolve) => {
    const req = db.transaction(STORE).objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as Entry | undefined);
    req.onerror = () => resolve(undefined);
  });
}

async function dbPut(key: string, entry: Entry): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const store = db.transaction(STORE, "readwrite").objectStore(STORE);
  store.put(entry, key);
  // 増えすぎたら古いものから消す（ざっくり、上限を超えた分だけ）
  const count = store.count();
  count.onsuccess = () => {
    let extra = count.result - MAX_ENTRIES;
    if (extra <= 0) return;
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c || extra-- <= 0) return;
      c.delete();
      c.continue();
    };
  };
}

// --- 同時に作る本数の制限 ---

let active = 0;
const waiters: (() => void)[] = [];
async function withSlot<T>(fn: () => Promise<T>, max = 2): Promise<T> {
  while (active >= max) await new Promise<void>((r) => waiters.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}

// --- 1 コマを取り出す ---

/** ほぼ真っ黒（暗転している最初のコマなど）か */
function isBlank(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  const { data } = ctx.getImageData(0, 0, w, h);
  let max = 0;
  const step = Math.max(4, Math.floor(data.length / 4 / 200)) * 4;
  for (let i = 0; i < data.length; i += step) {
    max = Math.max(max, data[i], data[i + 1], data[i + 2]);
    if (max > 24) return false;
  }
  return true;
}

function grabFrame(url: string, cors: boolean): Promise<{ data: string; duration: number | null } | null> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    // 直接読むときは相手のサーバーの通信なので先読みしてよい。サーバー経由（cors=false）のときは、
    // 先読みした分だけこのアプリのサーバーの通信量（課金）になるので、必要な部分だけ読む
    v.preload = cors ? "auto" : "metadata";
    v.setAttribute("playsinline", "");
    v.setAttribute("muted", "");
    if (cors) v.crossOrigin = "anonymous";
    // iPhone は画面に置いていない動画を読み込まないことがあるので、見えない場所に置く
    Object.assign(v.style, { position: "fixed", left: "-2px", top: "-2px", width: "1px", height: "1px", opacity: "0", pointerEvents: "none" });
    document.body.appendChild(v);

    let done = false;
    let tries = 0;
    const finish = (data: string | null) => {
      const result = data ? { data, duration: finiteDuration(v.duration) } : null;
      if (done) return;
      done = true;
      clearTimeout(timer);
      v.pause();
      v.removeAttribute("src");
      v.load();
      v.remove();
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), TIMEOUT_MS);

    /** 描けたら true（真っ黒なら false で、もう少し先のコマで再挑戦） */
    const draw = (): boolean => {
      if (!v.videoWidth || !v.videoHeight) return false;
      const w = WIDTH;
      const h = Math.max(1, Math.round((WIDTH * v.videoHeight) / v.videoWidth));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return false;
      try {
        ctx.drawImage(v, 0, 0, w, h);
        if (isBlank(ctx, w, h) && tries++ < 3) return false;
        finish(canvas.toDataURL("image/jpeg", 0.72));
      } catch {
        // 別ドメインで CORS が許可されていないと、描いた画像を取り出せない（SecurityError）
        finish(null);
      }
      return true;
    };

    v.addEventListener("loadedmetadata", () => {
      const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 10;
      v.currentTime = Math.min(1.5, d * 0.1);
    });
    v.addEventListener("seeked", () => {
      requestAnimationFrame(() => {
        if (draw()) return;
        // 真っ黒だったり描けなかったりしたら、先のコマを使う。
        // 直接なら少し再生する。サーバー経由なら再生はせず（再生した分だけ通信量がかかる）、3 秒先へ飛んで描き直す
        if (cors) void v.play().catch(() => {});
        else if (Number.isFinite(v.duration) && v.currentTime + 3 < v.duration) v.currentTime += 3;
        else finish(null);
      });
    });
    v.addEventListener("timeupdate", () => {
      if (!v.paused && v.currentTime > 0.3) draw();
    });
    v.addEventListener("error", () => finish(null));
    v.src = url;
    v.load();
  });
}

/** 作成済みならすぐ返す（まだなら undefined） */
export function peekVideoThumb(src: string): string | null | undefined {
  return memory.get(src);
}

/** 調べ済みの長さ（まだなら undefined） */
export function peekVideoDuration(src: string): number | null | undefined {
  return durations.get(src);
}

/**
 * 動画のサムネイルを得る。保存済みならそれを、なければ作る。
 * @param src 動画の URL（直接読む）
 * @param proxied こちらのサーバー経由の URL（直接読めないとき）
 */
export function getVideoThumb(src: string, proxied: string): Promise<string | null> {
  const known = memory.get(src);
  if (known !== undefined) return Promise.resolve(known);
  let job = pending.get(src);
  if (!job) {
    job = (async () => {
      const saved = await dbGet(src);
      if (saved && (saved.data || Date.now() - saved.at < RETRY_AFTER_MS)) {
        if (saved.duration) durations.set(src, saved.duration);
        return saved.data || null;
      }
      const made = await withSlot(async () => (await grabFrame(src, true)) ?? (await grabFrame(proxied, false)));
      if (made?.duration) durations.set(src, made.duration);
      void dbPut(src, { data: made?.data ?? "", at: Date.now(), duration: made?.duration ?? undefined });
      return made?.data ?? null;
    })()
      .catch(() => null)
      .then((result) => {
        memory.set(src, result);
        pending.delete(src);
        return result;
      });
    pending.set(src, job);
  }
  return job;
}

// --- 長さ（再生時間）を調べる ---

/** 動画の最初の情報だけを読んで長さを知る（別のサイトの動画でも、長さは CORS なしで読める） */
function readMetadata(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "metadata";
    v.playsInline = true;
    let done = false;
    const finish = (d: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      v.removeAttribute("src");
      v.load();
      resolve(d);
    };
    const timer = setTimeout(() => finish(null), 12000);
    v.addEventListener("loadedmetadata", () => finish(finiteDuration(v.duration)));
    v.addEventListener("durationchange", () => finiteDuration(v.duration) && finish(finiteDuration(v.duration)));
    v.addEventListener("error", () => finish(null));
    v.src = url;
    v.load();
  });
}

/** HLS の目次（サーバー経由）を読み、断片の長さを足す。全体の目次なら最初の画質の目次を読む */
async function readPlaylist(proxied: string): Promise<number | null> {
  let at = new URL(proxied, location.href).toString();
  for (let level = 0; level < 2; level++) {
    const res = await fetch(at);
    if (!res.ok) return null;
    const p = playlistDuration(await res.text());
    if (p.duration) return p.duration;
    if (!p.variant) return null;
    at = new URL(p.variant, at).toString();
  }
  return null;
}

/**
 * 動画の長さ（秒）を得る。わかっていればすぐ、なければ調べる（同時に 3 本まで）。
 * 調べた結果は端末に保存し、次からはすぐ返す
 */
export function getVideoDuration(src: string, proxied: string, hls: boolean): Promise<number | null> {
  const known = durations.get(src);
  if (known !== undefined) return Promise.resolve(known);
  let job = durationJobs.get(src);
  if (!job) {
    job = (async () => {
      const saved = await dbGet(`d:${src}`);
      if (saved && (saved.duration || Date.now() - saved.at < RETRY_AFTER_MS)) return saved.duration ?? null;
      const found = await withSlot(
        async () => (hls ? await readPlaylist(proxied).catch(() => null) : ((await readMetadata(src)) ?? (await readMetadata(proxied)))),
        3,
      );
      void dbPut(`d:${src}`, { data: "", at: Date.now(), duration: found ?? undefined });
      return found;
    })()
      .catch(() => null)
      .then((d) => {
        durations.set(src, d);
        durationJobs.delete(src);
        return d;
      });
    durationJobs.set(src, job);
  }
  return job;
}
