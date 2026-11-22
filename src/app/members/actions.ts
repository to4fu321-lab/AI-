"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { hasSecret, verifyPassword } from "@/lib/autopost/crypto";
import { db, must } from "@/lib/autopost/db";
import { issueMemberToken, MEMBER_COOKIE, MEMBER_MAX_AGE } from "@/lib/autopost/memberSession";

export interface LoginState {
  error?: string;
  /** 間違えたとき、ログイン ID は入れ直さなくて済むように返す */
  loginId?: string;
}

export async function memberLogin(_prev: LoginState, form: FormData): Promise<LoginState> {
  const loginId = String(form.get("loginId") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  if (!loginId || !password) return { error: "ログイン ID とパスワードを入れてください" };
  if (!hasSecret()) return { error: "このサイトはまだ準備中です（管理者に連絡してください）" };

  let member: { id: string; pass_hash: string; active: boolean } | null;
  try {
    member = must(await db().from("autopost_members").select("id,pass_hash,active").eq("login_id", loginId).maybeSingle());
  } catch {
    return { error: "このサイトはまだ準備中です（管理者に連絡してください）" };
  }
  if (!member || !verifyPassword(password, member.pass_hash)) {
    // 総当たりで何度も試されにくいよう、間違えたときは少し待たせる
    await new Promise((r) => setTimeout(r, 1000));
    return { error: "ログイン ID かパスワードが違います", loginId };
  }
  if (!member.active) return { error: "この会員は現在ご利用いただけません", loginId };

  (await cookies()).set(MEMBER_COOKIE, issueMemberToken(member.id), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MEMBER_MAX_AGE,
  });
  redirect("/members");
}

export async function memberLogout() {
  (await cookies()).delete(MEMBER_COOKIE);
  redirect("/members/login");
}
