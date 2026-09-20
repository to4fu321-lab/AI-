"use client";

import { useSyncExternalStore } from "react";

/**
 * 初回ガイドの開閉状態。
 * theme.ts と同じ購読パターンで、既読フラグを localStorage に持つ。
 * 内容を変えたら KEY を上げて、既読ユーザーにも一度だけ新しい内容を出す。
 */
const KEY = "kaizen-board:intro-seen-v2";

const listeners = new Set<() => void>();
let openOverride: boolean | null = null;

function hasSeen(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return true;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): boolean {
  return openOverride ?? !hasSeen();
}

function getServerSnapshot(): boolean {
  return false;
}

export function useIntroGuide(): [boolean, (next: boolean) => void] {
  const open = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setOpen = (next: boolean) => {
    openOverride = next;
    if (!next) {
      try {
        window.localStorage.setItem(KEY, "1");
      } catch {
        // 保存できなくても、その場で閉じる分には困らない
      }
    }
    for (const listener of listeners) listener();
  };

  return [open, setOpen];
}
