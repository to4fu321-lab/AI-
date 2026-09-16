"use client";

import { useSyncExternalStore } from "react";

/**
 * 画面の明るさ設定。
 *
 * 倉庫の現場は高天井のLEDで明るく、その環境では白背景のほうが
 * 照明の映り込みに負けず読みやすい。そのため既定は必ずライトモードにし、
 * 端末側のダークモード設定には追従しない（プライベートのスマホをダークモードに
 * している人も多く、それに追従すると明るい倉庫でも勝手に暗く起動してしまうため）。
 * 夜勤・早朝・冷蔵倉庫のために、ヘッダーのボタンで明示的にダークへ切り替えられる。
 *
 * 保存値の反映そのものは layout.tsx のインラインスクリプトが描画前に済ませている。
 * ここが持つのは「今どちらが選ばれているか」を画面に出すための購読だけ
 */
export type Theme = "light" | "dark";

const KEY = "kaizen-board:theme";

const listeners = new Set<() => void>();

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
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
    return isTheme(saved) ? saved : "light";
  } catch {
    // プライベートモード等で読めなくても、既定のライトのまま動けばよい
    return "light";
  }
}

/** サーバー側でも既定は必ずライト */
function getServerSnapshot(): Theme {
  return "light";
}

export function useTheme(): [Theme, (next: Theme) => void] {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setTheme = (next: Theme) => {
    const root = document.documentElement;
    // light は既定そのものなので、属性を外して素の状態にする
    if (next === "light") root.removeAttribute("data-theme");
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
