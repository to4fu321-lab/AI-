import type { MetadataRoute } from "next";

/** ホーム画面に追加したときに、ブラウザUIなしの全画面アプリとして起動する */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "カイゼンボード",
    short_name: "カイゼン",
    description:
      "倉庫・ピッキング現場の改善報告アプリ。写真と手書きで30秒で報告でき、管理者が必ず反応します。",
    lang: "ja",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f4f6f9",
    theme_color: "#ea5504",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
