import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // サーバー用 Chromium は Next.js にまとめさせず、そのまま読み込む
  serverExternalPackages: ["@sparticuz/chromium", "puppeteer-core"],
  // Chromium 本体（圧縮ファイル）をサムネ収集のクロール API に必ず同梱する
  outputFileTracingIncludes: {
    "/api/thumbs/crawl": ["./node_modules/@sparticuz/chromium/bin/**/*"],
  },
};

export default nextConfig;
