/**
 * 動画からサムネイル画像を作る（ブラウザの中で）。
 *
 * サムネイルが見つからない動画は、動画を少しだけ読み込んで 1 コマを <canvas> に描き、JPEG にする。
 * - まず元のサーバーから直接読む（CORS を許可しているサーバーなら、こちらのサーバーを通らず通信量がかからない）
 * - 駄目ならこちらのサーバー経由（同じドメインになるので、描いた画像を取り出せる）
 * - 作ったサムネイルは端末の IndexedDB に保存し、次からはすぐ出す
 * - 同時に作るのは 2 本まで（画面に見えているものから順に）
 */

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
}

const memory = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();

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
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (active >= 2) await new Promise<void>((r) => waiters.push(r));
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

function grabFrame(url: string, cors: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.setAttribute("playsinline", "");
    v.setAttribute("muted", "");
    if (cors) v.crossOrigin = "anonymous";
    // iPhone は画面に置いていない動画を読み込まないことがあるので、見えない場所に置く
    Object.assign(v.style, { position: "fixed", left: "-2px", top: "-2px", width: "1px", height: "1px", opacity: "0", pointerEvents: "none" });
    document.body.appendChild(v);

    let done = false;
    let tries = 0;
    const finish = (result: string | null) => {
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
        // 真っ黒だったり描けなかったりしたら、少し再生して先のコマを使う
        void v.play().catch(() => {});
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
      if (saved && (saved.data || Date.now() - saved.at < RETRY_AFTER_MS)) return saved.data || null;
      const made = await withSlot(async () => (await grabFrame(src, true)) ?? (await grabFrame(proxied, false)));
      void dbPut(src, { data: made ?? "", at: Date.now() });
      return made;
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
