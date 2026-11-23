import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // サーバー用 Chromium は Next.js にまとめさせず、そのまま読み込む
  serverExternalPackages: ["@sparticuz/chromium", "puppeteer-core"],
  // Chromium 本体（圧縮ファイル）を、ページを読む API（取得・自動巡回・定期実行）に必ず同梱する
  outputFileTracingIncludes: {
    "/api/thumbs/crawl": ["./node_modules/@sparticuz/chromium/bin/**/*"],
    "/api/thumbs/patrol": ["./node_modules/@sparticuz/chromium/bin/**/*"],
    "/api/cron/thumbs-patrol": ["./node_modules/@sparticuz/chromium/bin/**/*"],
  },
};

export default nextConfig;
