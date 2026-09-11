"use client";

import { useEffect, useRef } from "react";
import Script from "next/script";

declare global {
  interface Window {
    twttr?: { widgets: { load: (el?: HTMLElement) => void } };
  }
}

export function XEmbed({ statusUrl }: { statusUrl: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.twttr?.widgets.load(containerRef.current ?? undefined);
  }, []);

  return (
    <div
      ref={containerRef}
      className="flex min-h-[260px] w-full items-start justify-center bg-white p-3 dark:bg-neutral-100"
    >
      <blockquote className="twitter-tweet" data-theme="light">
        <a href={statusUrl}>ポストを読み込み中…</a>
      </blockquote>
      <Script
        src="https://platform.twitter.com/widgets.js"
        strategy="lazyOnload"
        onLoad={() => window.twttr?.widgets.load(containerRef.current ?? undefined)}
      />
    </div>
  );
}
