import type { Metadata, Viewport } from "next";
import { RepairApp } from "@/components/repair/RepairApp";

export const metadata: Metadata = {
  title: "動画修復 | 再生できないMP4・MOVを直す",
  description:
    "撮影の中断や転送の失敗で再生できなくなったMP4・MOV動画を、iPhoneのブラウザだけで修復します。動画は端末内で処理され、どこにも送信されません。",
  appleWebApp: { capable: true, title: "動画修復", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default function RepairPage() {
  return <RepairApp />;
}
