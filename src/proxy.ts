import { NextResponse, type NextRequest } from "next/server";
import { hasAccess, lockForPath } from "@/lib/access/locks";

/**
 * すべてのリクエストの前に動く「門番」。
 * パスワードで守られたアプリの URL なら通行証（Cookie）を確かめ、なければ鍵の入力画面へ回す。
 */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const lock = lockForPath(pathname);
  if (!lock) return NextResponse.next();
  if (await hasAccess(request.cookies, lock.key)) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "パスワードが必要です" }, { status: 401 });
  }
  const url = request.nextUrl.clone();
  url.pathname = "/unlock";
  url.search = new URLSearchParams({ key: lock.key, next: pathname + search }).toString();
  return NextResponse.redirect(url);
}

export const config = {
  // Next.js の内部ファイルと画像などの静的ファイルは門番を通さない（速度のため）
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|wasm)$).*)"],
};
