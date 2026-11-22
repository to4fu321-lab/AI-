import type { Metadata, Viewport } from "next";
import { AutopostApp } from "@/components/autopost/AutopostApp";

export const metadata: Metadata = {
  title: "動画オート投稿 | 編集から各サイトへの投稿まで",
  description: "動画を選ぶだけで、YouTube・X・Instagram・自分の会員サイトなど投稿先ごとの題名と本文を作り、投稿まで進めます。",
  appleWebApp: { capable: true, title: "オート投稿", statusBarStyle: "default" },
  robots: { index: false },
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

export default function AutopostPage() {
  return <AutopostApp />;
}
