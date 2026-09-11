/**
 * デモ用の永続化レイヤー。
 * - 報告などのメタデータ … localStorage（軽量・同期的に読める）
 * - 投稿写真の実体       … IndexedDB（Blob をそのまま保存。localStorage の容量制限を回避）
 *
 * ここと store.ts だけを差し替えれば、そのまま Supabase などのバックエンドに移行できる。
 */
import type { DemoState } from "./types";

// データ構造を変えたらキーを上げる（古い保存データを読み込まないため）
const STATE_KEY = "kaizen-board:state:v3";
const DB_NAME = "kaizen-board";
const DB_VERSION = 1;
const IMAGE_STORE = "images";

export function loadState(): DemoState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DemoState;
    if (!parsed?.reports || !parsed?.users) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveState(state: DemoState) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    // 容量超過などは黙って諦める（デモの継続を優先）
  }
}

export function clearState() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STATE_KEY);
  } catch {
    // noop
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IMAGE_STORE)) {
        db.createObjectStore(IMAGE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(IMAGE_STORE, mode);
        const request = run(transaction.objectStore(IMAGE_STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => db.close();
      }),
  );
}

/** Blob を保存し、`idb:<id>` 形式の参照を返す */
export async function putImage(blob: Blob): Promise<string> {
  const id = `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await tx("readwrite", (store) => store.put(blob, id));
  return `idb:${id}`;
}

export async function getImage(ref: string): Promise<Blob | null> {
  if (!ref.startsWith("idb:")) return null;
  try {
    const blob = await tx<Blob | undefined>("readonly", (store) => store.get(ref.slice(4)));
    return blob ?? null;
  } catch {
    return null;
  }
}

export async function clearImages() {
  try {
    await tx("readwrite", (store) => store.clear());
  } catch {
    // noop
  }
}
