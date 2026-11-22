import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { signedUrl } from "@/lib/autopost/db";
import { currentViewer } from "@/lib/autopost/memberSession";
import { loadMemberSite } from "@/lib/autopost/memberSite";

export const metadata: Metadata = { title: "会員限定の動画", robots: { index: false }, referrer: "no-referrer" };
export const dynamic = "force-dynamic";

export default async function WatchPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await currentViewer().catch(() => null);
  if (!viewer) redirect("/members/login");
  const { id } = await params;
  const site = await loadMemberSite();
  const item = site.videos.find((v) => v.postId === id);
  if (!item) notFound();
  // 動画の URL は 2 時間で切れる。URL を人に渡されても、長くは見られない
  const src = await signedUrl(item.video.path, 2 * 3600);

  return (
    <div className="min-h-screen bg-neutral-950 pb-16 text-white">
      <div className="mx-auto max-w-3xl px-4 pt-[max(1.25rem,env(safe-area-inset-top))]">
        <Link href="/members" className="text-xs font-semibold text-neutral-400">‹ {site.name}</Link>
        <video src={src} poster={item.video.thumb || undefined} controls playsInline controlsList="nodownload" className="mt-3 max-h-[75vh] w-full rounded-xl bg-black" />
        <h1 className="mt-4 text-xl font-black">{item.title || "（題名なし）"}</h1>
        {item.postedAt && <p className="mt-1 text-xs text-neutral-500">{new Date(item.postedAt).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })}</p>}
        <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-relaxed text-neutral-300">{item.body}</p>
      </div>
    </div>
  );
}
