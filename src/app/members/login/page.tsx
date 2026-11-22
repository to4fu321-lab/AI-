import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentViewer } from "@/lib/autopost/memberSession";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "会員ログイン", robots: { index: false } };

export default async function MemberLoginPage() {
  if (await currentViewer().catch(() => null)) redirect("/members");
  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-950 px-6 text-white">
      <div className="w-full max-w-sm">
        <p className="text-xs font-bold tracking-widest text-fuchsia-400">MEMBERS ONLY</p>
        <h1 className="mt-1 text-2xl font-black">会員ログイン</h1>
        <p className="mt-2 text-sm text-neutral-400">会員の方だけが動画をご覧いただけます。</p>
        <LoginForm />
        <Link href="/apps" className="mt-8 block text-center text-xs text-neutral-500">‹ アプリ一覧へ</Link>
      </div>
    </main>
  );
}
