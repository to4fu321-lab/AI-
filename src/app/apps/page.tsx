import type { Metadata, Viewport } from "next";
import { AppsDirectory } from "@/components/apps/AppsDirectory";
import { APPS } from "@/data/apps";

export const metadata: Metadata = {
  title: "アプリ一覧 | 作ったアプリのまとめ",
  description: "これまでに作ったアプリをまとめて紹介します。",
  appleWebApp: { capable: true, title: "アプリ一覧", statusBarStyle: "default" },
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

/** 公開から何日間「NEW」を付けるか */
const NEW_DAYS = 14;
// このページはデプロイ時に 1 回だけ作られるので、NEW の判定もデプロイ時点の日付で行う
const BUILT_AT = Date.now();

const apps = [...APPS]
  .sort((a, b) => b.addedAt.localeCompare(a.addedAt))
  .map((a) => ({ ...a, isNew: BUILT_AT - new Date(a.addedAt).getTime() < NEW_DAYS * 86400000 }));

export default function AppsPage() {
  return <AppsDirectory apps={apps} />;
}
