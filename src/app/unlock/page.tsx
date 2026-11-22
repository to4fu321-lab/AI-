import type { Metadata } from "next";
import Link from "next/link";
import { isLockKey, lockLabel, safeNext } from "@/lib/access/locks";
import { UnlockForm } from "./UnlockForm";

export const metadata: Metadata = {
  title: "パスワード入力",
  robots: { index: false },
};

export default async function UnlockPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const rawKey = typeof params.key === "string" ? params.key : "";
  const next = safeNext(params.next);
  const key = isLockKey(rawKey) ? rawKey : null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-4 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <div className="w-full max-w-sm rounded-3xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <p className="text-center text-4xl">🔒</p>
        {key ? (
          <>
            <h1 className="mt-3 text-center text-lg font-black">{lockLabel(key)}</h1>
            <p className="mt-1 text-center text-sm text-neutral-500">パスワードを入力してください</p>
            <UnlockForm lockKey={key} next={next} />
          </>
        ) : (
          <p className="mt-3 text-center text-sm text-neutral-500">入口が正しくありません</p>
        )}
        <Link href="/apps" className="mt-5 block text-center text-xs text-neutral-400 underline">
          アプリ一覧へ戻る
        </Link>
      </div>
    </div>
  );
}
