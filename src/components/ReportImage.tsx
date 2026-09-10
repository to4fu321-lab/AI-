"use client";

import { useImageUrl } from "@/lib/store";

/**
 * 画像参照（同梱サンプル or IndexedDB の Blob）を表示する。
 * next/image はローカル Blob URL を扱えないため、意図的に img を使う。
 */
export function ReportImage({
  src,
  alt,
  className = "",
  fallbackEmoji = "📝",
}: {
  src?: string;
  alt: string;
  className?: string;
  fallbackEmoji?: string;
}) {
  const url = useImageUrl(src);

  if (!url) {
    return (
      <div
        className={`grid place-items-center bg-canvas text-3xl text-ink-faint ${className}`}
        aria-hidden
      >
        {fallbackEmoji}
      </div>
    );
  }

  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={alt} className={className} loading="lazy" />;
}
