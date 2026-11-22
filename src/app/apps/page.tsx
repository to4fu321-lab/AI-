import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { AppsDirectory, type ListedApp } from "@/components/apps/AppsDirectory";
import { APPS } from "@/data/apps";
import { hasAccess, lockOfApp } from "@/lib/access/locks";

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
const STARTED_AT = Date.now();

export default async function AppsPage() {
  const jar = await cookies();
  const ezoshirube = await hasAccess(jar, "ezoshirube");
  const owner = await hasAccess(jar, "private");

  const listed: ListedApp[] = [];
  for (const app of [...APPS].sort((a, b) => b.addedAt.localeCompare(a.addedAt))) {
    // 鍵が開いていないメンバー用・自分用のアプリは、名前も含めて画面に送らない
    if (app.access === "ezoshirube" && !ezoshirube) continue;
    if (app.access === "private" && !owner) continue;
    const key = lockOfApp(app);
    listed.push({
      ...app,
      isNew: STARTED_AT - new Date(app.addedAt).getTime() < NEW_DAYS * 86400000,
      locked: key ? !(await hasAccess(jar, key)) : false,
    });
  }

  return <AppsDirectory apps={listed} unlocked={{ ezoshirube, owner }} />;
}
