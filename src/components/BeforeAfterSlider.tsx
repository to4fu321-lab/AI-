"use client";

import { useState } from "react";
import { ReportImage } from "./ReportImage";

/**
 * Before / After の比較スライダー。
 * つまみは range 入力そのものなので、指でもマウスでもキーボードでも動かせる。
 */
export function BeforeAfterSlider({
  before,
  after,
}: {
  before?: string;
  after?: string;
}) {
  const [position, setPosition] = useState(50);

  return (
    <div className="relative overflow-hidden rounded-2xl border border-line bg-ink">
      <ReportImage src={after} alt="改善後の写真" className="block w-full" />

      <div
        className="absolute inset-0"
        style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
      >
        <ReportImage src={before} alt="改善前の写真" className="h-full w-full object-cover" />
      </div>

      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow"
        style={{ left: `${position}%` }}
      >
        <span className="absolute top-1/2 left-1/2 grid h-10 w-10 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white text-xs font-bold text-ink shadow-lg">
          ⇔
        </span>
      </div>

      <span className="pointer-events-none absolute left-2 top-2 rounded-md bg-ink/80 px-2 py-1 text-[11px] font-bold text-white">
        Before
      </span>
      <span className="pointer-events-none absolute right-2 top-2 rounded-md bg-brand px-2 py-1 text-[11px] font-bold text-white">
        After
      </span>

      <input
        type="range"
        min={0}
        max={100}
        value={position}
        onChange={(event) => setPosition(Number(event.target.value))}
        aria-label="Before / After の表示位置"
        className="absolute inset-0 h-full w-full cursor-ew-resize opacity-0"
      />
    </div>
  );
}
