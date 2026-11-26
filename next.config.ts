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
  // アカウント引っ越し（メールを扱う）には、ブラウザ向けの守りのヘッダを付ける：
  // ほかのサイトの枠の中に表示させない・種類のごまかしを許さない・開いた先に URL を伝えない・検索に載せない
  async headers() {
    const secure = [
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://accounts.google.com; object-src 'none'" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Robots-Tag", value: "noindex" },
    ];
    return [
      { source: "/migrate", headers: secure },
      { source: "/migrate/:path*", headers: secure },
      { source: "/api/migrate/:path*", headers: secure },
    ];
  },
};

export default nextConfig;
