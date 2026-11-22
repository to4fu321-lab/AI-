import "server-only";
import { cookies } from "next/headers";
import { hasAccess } from "@/lib/access/locks";
import { hasSecret, sign, verifySigned } from "./crypto";
import { db, must, MEMBER_COLUMNS } from "./db";
import type { Member } from "./types";

/** 会員制動画サイト（/members）のログイン状態。署名つきの Cookie で持つ */

export const MEMBER_COOKIE = "ap_member";
export const MEMBER_MAX_AGE = 60 * 60 * 24 * 30;

export function issueMemberToken(memberId: string): string {
  const exp = Math.floor(Date.now() / 1000) + MEMBER_MAX_AGE;
  return `${memberId}.${exp}.${sign(`member|${memberId}|${exp}`)}`;
}

/**
 * いま見ている人。会員なら会員の情報、管理者（自分専用の鍵を開けている人）なら "admin"、どちらでもなければ null。
 * 会員は毎回データベースで確かめるので、止めた会員はすぐ見られなくなる。
 */
export async function currentViewer(): Promise<Member | "admin" | null> {
  const jar = await cookies();
  if (await hasAccess(jar, "private")) return "admin";
  const token = jar.get(MEMBER_COOKIE)?.value;
  if (!token || !hasSecret()) return null;
  const [id, expText, signature] = token.split(".");
  const exp = Number(expText);
  if (!id || !signature || !Number.isFinite(exp) || exp < Date.now() / 1000) return null;
  if (!verifySigned(`member|${id}|${exp}`, signature)) return null;
  const member = must(await db().from("autopost_members").select(MEMBER_COLUMNS).eq("id", id).maybeSingle()) as Member | null;
  return member?.active ? member : null;
}
