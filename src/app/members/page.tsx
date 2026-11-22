import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentViewer } from "@/lib/autopost/memberSession";
import { loadMemberSite } from "@/lib/autopost/memberSite";
import { memberLogout } from "./actions";

export const metadata: Metadata = { title: "会員限定の動画", robots: { index: false } };
export const dynamic = "force-dynamic";

function time(seconds: number): string {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export default async function MembersPage() {
  const viewer = await currentViewer().catch(() => null);
  if (!viewer) redirect("/members/login");
  const site = await loadMemberSite();

  return (
    <div className="min-h-screen bg-neutral-950 pb-16 text-white">
      <header className="mx-auto flex max-w-5xl items-start justify-between px-4 pt-[max(1.5rem,env(safe-area-inset-top))]">
        <div>
          <p className="text-xs font-bold tracking-widest text-fuchsia-400">MEMBERS ONLY</p>
          <h1 className="mt-1 text-2xl font-black tracking-tight">{site.name}</h1>
          <p className="mt-1 text-xs text-neutral-400">{viewer === "admin" ? "管理者として見ています" : `${viewer.name || viewer.login_id} さん`}</p>
        </div>
        {viewer === "admin" ? (
          <Link href="/autopost" className="rounded-full bg-neutral-800 px-3 py-1.5 text-xs font-semibold text-neutral-300">管理画面</Link>
        ) : (
          <form action={memberLogout}>
            <button type="submit" className="rounded-full bg-neutral-800 px-3 py-1.5 text-xs font-semibold text-neutral-300">ログアウト</button>
          </form>
        )}
      </header>

      <main className="mx-auto mt-6 max-w-5xl px-4">
        {site.videos.length === 0 ? (
          <p className="rounded-2xl bg-neutral-900 p-6 text-sm text-neutral-400">まだ動画がありません。公開までしばらくお待ちください。</p>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            {site.videos.map((v) => (
              <Link key={v.postId} href={`/members/watch/${v.postId}`} className="group block">
                <div className="relative overflow-hidden rounded-xl bg-neutral-900">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {v.video.thumb ? <img src={v.video.thumb} alt="" className="aspect-video w-full object-contain" /> : <div className="aspect-video w-full" />}
                  <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-semibold">{time(v.video.duration)}</span>
                </div>
                <p className="mt-2 line-clamp-2 text-sm font-bold group-hover:text-fuchsia-300">{v.title || "（題名なし）"}</p>
                {v.postedAt && <p className="mt-0.5 text-xs text-neutral-500">{new Date(v.postedAt).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })}</p>}
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
