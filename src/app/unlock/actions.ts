"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  cookieName,
  isLockKey,
  issueToken,
  MAX_AGE_SECONDS,
  passwordFor,
  safeEqual,
  safeNext,
  type LockKey,
} from "@/lib/access/locks";
import { APPS } from "@/data/apps";

export interface UnlockState {
  error?: string;
}

export async function unlock(_prev: UnlockState, form: FormData): Promise<UnlockState> {
  const key = String(form.get("key") ?? "");
  const input = String(form.get("password") ?? "");
  const next = safeNext(form.get("next"));
  if (!isLockKey(key)) return { error: "入口が正しくありません" };

  const password = passwordFor(key);
  if (!password) return { error: "このアプリにはまだパスワードが設定されていません（管理者に連絡してください）" };

  if (!safeEqual(input.trim(), password)) {
    // 総当たりで何度も試されにくいよう、間違えたときは少し待たせる
    await new Promise((r) => setTimeout(r, 1000));
    return { error: "パスワードが違います" };
  }

  const token = await issueToken(key);
  if (!token) return { error: "通行証を作れませんでした" };
  const jar = await cookies();
  jar.set(cookieName(key), token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
  redirect(next);
}

/** この端末に保存されている通行証をすべて消す（共用の端末で使ったあとなど） */
export async function lockAll() {
  const jar = await cookies();
  const keys: LockKey[] = ["ezoshirube", "private", ...APPS.filter((a) => a.access === "sale").map((a) => `app:${a.slug}` as const)];
  for (const key of keys) jar.delete(cookieName(key));
  redirect("/apps");
}
