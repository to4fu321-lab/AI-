"use client";

import { useEffect, useRef } from "react";
import { useInView } from "@/lib/useInView";

function postPlayerCommand(iframe: HTMLIFrameElement | null, func: "playVideo" | "pauseVideo") {
  iframe?.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args: [] }), "*");
}

export function YouTubeEmbed({
  videoId,
  title,
}: {
  videoId: string;
  title: string;
}) {
  const { ref, inView } = useInView<HTMLDivElement>(0.6);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const readyRef = useRef(false);

  useEffect(() => {
    if (!readyRef.current) return;
    postPlayerCommand(iframeRef.current, inView ? "playVideo" : "pauseVideo");
  }, [inView]);

  return (
    <div ref={ref} className="relative aspect-video w-full overflow-hidden bg-black">
      <iframe
        ref={iframeRef}
        className="absolute inset-0 h-full w-full"
        src={`https://www.youtube.com/embed/${videoId}?enablejsapi=1&mute=1&playsinline=1`}
        title={title}
        loading="lazy"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowFullScreen
        onLoad={() => {
          readyRef.current = true;
          if (inView) postPlayerCommand(iframeRef.current, "playVideo");
        }}
      />
    </div>
  );
}
