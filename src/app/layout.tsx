import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BuzzTube | バズ動画まとめキュレーションサイト",
  description:
    "X（旧Twitter）やYouTubeで今バズっているトレンド動画をAIが自動収集・要約して紹介するキュレーションサイト。",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <head>
        {/*
          フォント（Noto Sans JP）は、見る人のブラウザが読み込む。
          next/font/google はビルドのたびに数百個のフォントファイルをダウンロードするので、
          1 つでも失敗するとビルド全体が失敗していた（本番の配置が止まる）。
        */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font -- ここは全ページ共通のレイアウトなので、全ページで読み込まれる */}
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700;900&display=swap" />
      </head>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
