import type { Metadata, Viewport } from "next";
import { MigrateApp } from "@/components/migrate/MigrateApp";

export const metadata: Metadata = {
  title: "アカウント引っ越し | 登録済みサービスの洗い出しとメール変更",
  description: "Gmail から登録済みのサービスを洗い出し、新しいメールアドレスへの変更を 1 件ずつ進めます。",
  appleWebApp: { capable: true, title: "引っ越し", statusBarStyle: "default" },
  robots: { index: false },
  // 各サービスのログインページを開くとき、このアプリの URL を相手に伝えない
  referrer: "no-referrer",
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

export default function MigratePage() {
  return <MigrateApp />;
}
