import type { Metadata, Viewport } from "next";
import { Noto_Sans_JP } from "next/font/google";
import "./globals.css";
import { AppShell } from "@/components/AppShell";

const notoSansJP = Noto_Sans_JP({
  subsets: ["latin"],
  weight: ["400", "500", "700", "900"],
  display: "swap",
  variable: "--font-noto-sans-jp",
});

export const metadata: Metadata = {
  title: "カイゼンボード | 現場の気づきを、30秒で。",
  description:
    "倉庫・ピッキング現場のスタッフが、改善アイデアや破損・ヒヤリハットをスマホから写真＋手書きで共有できる現場改善報告アプリ。投稿にはポイントが付き、管理者は採用・一部修正採用・お礼などで必ず反応します。",
  applicationName: "カイゼンボード",
  appleWebApp: {
    capable: true,
    title: "カイゼン",
    statusBarStyle: "default",
  },
  icons: {
    apple: "/icons/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#ea5504",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/**
 * 保存した明るさ設定を、画面が描かれる前に反映する。
 * React の描画を待つと、暗いモードの人に一瞬だけ白い画面が光ってしまう
 */
const APPLY_THEME = `try{var t=localStorage.getItem("kaizen-board:theme");if(t==="dark"||t==="light")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // data-theme は上のスクリプトが描画前に書き込むので、サーバーの出力とは必ず食い違う
    <html lang="ja" className={notoSansJP.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: APPLY_THEME }} />
      </head>
      <body className="min-h-dvh font-sans antialiased">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
