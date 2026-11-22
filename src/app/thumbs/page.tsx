import type { Metadata, Viewport } from "next";
import { ThumbsApp } from "@/components/thumbs/ThumbsApp";

export const metadata: Metadata = {
  title: "サムネ収集 | URLの先の画像・動画を一覧表示",
  description: "URLを入れると、そのページと下の階層にある画像・動画のサムネイルを一覧で集めます。タップで再生、ダウンロードもできます。",
  appleWebApp: { capable: true, title: "サムネ収集", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default function ThumbsPage() {
  return <ThumbsApp />;
}
