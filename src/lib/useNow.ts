"use client";

import { useSyncExternalStore } from "react";

/**
 * 現在時刻（1分ごとに更新）。
 * SSR とハイドレーションの表示ズレを避けるため、外部ストアとして購読する。
 */
let current = Date.now();
let timer: number | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (timer === null) {
    timer = window.setInterval(() => {
      current = Date.now();
      for (const item of listeners) item();
    }, 60_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot() {
  return current;
}

/** SSR 時は固定値。クライアント側の初回描画で実時刻に置き換わる */
function getServerSnapshot() {
  return 0;
}

export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
