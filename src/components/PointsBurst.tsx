"use client";

import { useEffect, useState } from "react";
import type { PointLine } from "@/lib/points";

/** 獲得ポイントを内訳ごとに積み上げて見せる演出 */
export function PointsBurst({ lines }: { lines: PointLine[] }) {
  const [shown, setShown] = useState(0);

  const count = lines.length;
  useEffect(() => {
    const timers = Array.from({ length: count }, (_, index) =>
      window.setTimeout(() => setShown(index + 1), 350 * (index + 1)),
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [count]);

  const total = lines.slice(0, shown).reduce((sum, line) => sum + line.points, 0);

  return (
    <div className="card overflow-hidden">
      <div className="bg-brand px-4 py-6 text-center text-white">
        <p className="text-note font-bold opacity-90">獲得ポイント</p>
        <p className="text-num !text-5xl">
          +{total}
          <span className="ml-1 text-head">pt</span>
        </p>
      </div>
      <ul className="divide-y divide-line">
        {lines.map((line, index) => (
          <li
            key={line.label}
            className={`flex items-center justify-between px-4 py-3 text-body transition-opacity duration-300 ${
              index < shown ? "opacity-100" : "opacity-0"
            }`}
          >
            <span className="text-ink-muted">{line.label}</span>
            <span className="font-bold text-brand">+{line.points}pt</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
