import { randomBytes } from "node:crypto";
import { after } from "next/server";
import { guardApi } from "@/lib/access/locks";
import { currentUser, deleteAccount, destroySession, sessionCookie, type User } from "@/lib/migrate/auth";
import { UserError, uuid } from "@/lib/migrate/db";
import { disconnect, googleConfigured, tokenKeyConfigured } from "@/lib/migrate/gmail";
import { loadLedger, setRetiring, updateService } from "@/lib/migrate/ledger";
import { kick, requestScan, resetScan, runScan, selfOrigin, stopScan } from "@/lib/migrate/scan";
import type { AppState } from "@/lib/migrate/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 「調べる」は返事をすぐ返し、そのあと裏で（after）時間のかぎり進める。区切れたら次の回へ引き継ぐ
export const maxDuration = 300;
const SCAN_BUDGET_MS = 240_000;

type Body = Record<string, unknown>;

/**
 * ログインした利用者の操作。どの操作も、利用者（user）を受け取り、その人のデータだけを読み書きする。
 * 番号（id）を指定する操作は、必ず「その番号が、この利用者のものか」を問い合わせの条件に入れる（lib の側で行う）
 */
const ACTIONS: Record<string, (user: User, b: Body, request: Request) => Promise<unknown>> = {
  /** メールを調べ始める（返事はすぐ返す。進めるのはサーバーなので、画面を閉じても続く） */
  async scan(user, b, request) {
    const id = uuid(b.mailboxId);
    const deadline = Date.now() + SCAN_BUDGET_MS;
    const origin = selfOrigin(request);
    await requestScan(user.id, id);
    after(async () => {
      // 時間で区切れたら、続きを進める回を起こす
      if ((await runScan(id, deadline)) === "more") await kick(origin);
    });
    return { ok: true };
  },

  /** 調べるのを止める */
  async stop(user, b) {
    await stopScan(user.id, uuid(b.mailboxId));
    return { ok: true };
  },

  /** 数え直すために、調べた結果を空にする */
  async reset(user, b) {
    await resetScan(user.id, uuid(b.mailboxId));
    return { ok: true };
  },

  /** つながりを切る */
  async disconnect(user, b) {
    await disconnect(user.id, uuid(b.mailboxId));
    return { ok: true };
  },

  /** 「このアドレスをやめたい」の印を付ける・外す */
  async retire(user, b) {
    await setRetiring(user.id, b.mailboxId, b.retiring);
    return { ok: true };
  },

  /** 仕分け・開くページ・メモを変える */
  async update(user, b) {
    await updateService(user.id, b.id, { status: b.status, login_url: b.login_url, note: b.note });
    return { ok: true };
  },
};

const json = (body: unknown, status = 200, cookies: string[] = []) => {
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(JSON.stringify(body), { status, headers });
};

/**
 * この画面からの操作か（ほかのサイトのページが、利用者のブラウザを使って操作させるのを断る）。
 * ブラウザは、POST には Origin を必ず付ける。Origin が無い・違う呼び出しは通さない。
 * 本文は JSON だけ受け付ける（ほかのサイトのフォームからは、JSON を送れない）
 */
function sameSite(request: Request): boolean {
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  if (!origin) return site === "same-origin";
  try {
    return new URL(origin).host === (request.headers.get("host") ?? new URL(request.url).host);
  } catch {
    return false;
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  const denied = await guardApi(request, `/api/migrate/${action}`);
  if (denied) return denied;
  if (!sameSite(request)) return json({ error: "このサイトの画面から操作してください" }, 403);
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return json({ error: "このサイトの画面から操作してください" }, 415);

  try {
    // 鍵が設定されているかどうかは、ログインした人にだけ教える（知らない人には、設定の様子を見せない）
    const setup = { db: true, google: googleConfigured(), tokenKey: true };
    let user: User | null;
    try {
      user = await currentUser(request);
    } catch (e) {
      // データベースの設定がまだのときも画面は開けるようにして、何が足りないかを見せる
      if (action === "state" && e instanceof UserError) return json({ setup: { ...setup, db: false }, user: null, mailboxes: [], services: [] } satisfies AppState);
      throw e;
    }

    /** 画面に出すもの一式（ログインしていなければ、空で返す） */
    if (action === "state") {
      if (!user) return json({ setup, user: null, mailboxes: [], services: [] } satisfies AppState);
      return json({ setup: { ...setup, tokenKey: tokenKeyConfigured() }, user: { email: user.email, name: user.name }, ...(await loadLedger(user.id)) } satisfies AppState);
    }

    if (action === "logout") {
      await destroySession(request);
      return json({ ok: true }, 200, [sessionCookie("")]);
    }

    if (!user) return json({ error: "ログインが必要です" }, 401);

    /** アカウントの削除（つないだメールの許可を取り消し、この利用者のデータをすべて消す） */
    if (action === "deleteAccount") {
      await deleteAccount(user.id);
      return json({ ok: true }, 200, [sessionCookie("")]);
    }

    const run = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : null;
    if (!run) return json({ error: "その操作はありません" }, 404);
    const body = (await request.json().catch(() => ({}))) as Body;
    return json(await run(user, body, request));
  } catch (e) {
    if (e instanceof UserError) return json({ error: e.message }, 400);
    // 内部のエラーの文は、利用者には見せない（データベースや通信の中身が漏れないように）。照らし合わせ用の番号だけ返す
    const ref = randomBytes(4).toString("hex");
    console.error(`[migrate] ${action} ref=${ref}`, e);
    return json({ error: `うまくいきませんでした（問い合わせ番号 ${ref}）` }, 500);
  }
}
