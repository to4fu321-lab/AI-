"use client";

import { useSyncExternalStore } from "react";

/**
 * 画面の明るさ設定。
 *
 * 倉庫の現場は高天井のLEDで明るく、その環境では白背景のほうが
 * 照明の映り込みに負けず読みやすい。なので既定は「端末にまかせる」のまま、
 * 夜勤・早朝・冷蔵倉庫のために暗いモードを選べるようにしている。
 *
 * 保存値の反映そのものは layout.tsx のインラインスクリプトが描画前に済ませている。
 * ここが持つのは「今どれが選ばれているか」を画面に出すための購読だけ
 */
export type Theme = "system" | "light" | "dark";

const KEY = "kaizen-board:theme";

const listeners = new Set<() => void>();

function isTheme(value: unknown): value is Theme {
  return value === "system" || value === "light" || value === "dark";
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // 別のタブで切り替えたときにも追従する
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function getSnapshot(): Theme {
  try {
    const saved = window.localStorage.getItem(KEY);
    return isTheme(saved) ? saved : "system";
  } catch {
    // プライベートモード等で読めなくても、端末の設定のまま動けばよい
    return "system";
  }
}

/** サーバー側では保存値を知りようがないので、端末にまかせる状態から始める */
function getServerSnapshot(): Theme {
  return "system";
}

export function useTheme(): [Theme, (next: Theme) => void] {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setTheme = (next: Theme) => {
    const root = document.documentElement;
    // system のときは属性を外して端末の設定にまかせる
    if (next === "system") root.removeAttribute("data-theme");
    else root.dataset.theme = next;

    try {
      window.localStorage.setItem(KEY, next);
    } catch {
      // 保存できなくても、その場の表示は切り替わる
    }
    for (const listener of listeners) listener();
  };

  return [theme, setTheme];
}
