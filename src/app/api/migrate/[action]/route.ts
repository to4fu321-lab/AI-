import { after } from "next/server";
import { guardApi } from "@/lib/access/locks";
import { currentUser, deleteAccount, destroySession, sessionCookie, type User } from "@/lib/migrate/auth";
import { db, toMailbox, toService, UserError, uuid, type MailboxRow, type ServiceRow } from "@/lib/migrate/db";
import { disconnect, googleConfigured } from "@/lib/migrate/gmail";
import { kick, requestScan, resetScan, runScan, stopScan } from "@/lib/migrate/scan";
import type { AppState, Status } from "@/lib/migrate/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 「調べる」は返事をすぐ返し、そのあと裏で（after）時間のかぎり進める。区切れたら次の回へ引き継ぐ
export const maxDuration = 300;
const SCAN_BUDGET_MS = 240_000;

type Body = Record<string, unknown>;

const str = (v: unknown, max = 2000) => (typeof v === "string" ? v.slice(0, max) : "");
const STATUSES: Status[] = ["new", "move", "skip", "done"];

/**
 * ログインした利用者の操作。どの操作も、利用者（user）を受け取り、その人のデータだけを読み書きする。
 * 番号（id）を指定する操作は、必ず「その番号が、この利用者のものか」を問い合わせの条件に入れる
 */
const ACTIONS: Record<string, (user: User, b: Body, request: Request) => Promise<unknown>> = {
  /** メールを調べ始める（返事はすぐ返す。進めるのはサーバーなので、画面を閉じても続く） */
  async scan(user, b, request) {
    const id = uuid(b.mailboxId);
    const deadline = Date.now() + SCAN_BUDGET_MS;
    const origin = new URL(request.url).origin;
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

  /** 仕分け・開くページ・メモを変える */
  async update(user, b) {
    const id = uuid(b.id);
    const sets: string[] = [];
    const values: unknown[] = [id, user.id];
    const set = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (typeof b.status === "string") {
      if (!STATUSES.includes(b.status as Status)) throw new UserError("仕分けの種類が違います");
      set("status", b.status);
    }
    if (typeof b.login_url === "string") {
      const url = str(b.login_url, 500).trim();
      if (url && !/^https:\/\/[^\s]+$/.test(url)) throw new UserError("開くページは https:// から始まる URL を入れてください");
      set("login_url", url);
    }
    if (typeof b.note === "string") set("note", str(b.note, 2000));
    if (!sets.length) return { ok: true };
    const r = await (await db()).query(`update migrate_services set ${sets.join(", ")}, updated_at = now() where id = $1 and user_id = $2`, values);
    if (!r.rowCount) throw new UserError("サービスが見つかりません");
    return { ok: true };
  },
};

const json = (body: unknown, status = 200, cookies: string[] = []) => {
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(JSON.stringify(body), { status, headers });
};

export async function POST(request: Request, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  const denied = await guardApi(request, `/api/migrate/${action}`);
  if (denied) return denied;
  // ほかのサイトのページから、利用者のブラウザを使って操作させない（ログインの印は Cookie なので）
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return json({ error: "このサイトの画面から操作してください" }, 403);

  try {
    const setup = { db: true, google: googleConfigured() };
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
      const pool = await db();
      const [boxes, services] = await Promise.all([
        pool.query<MailboxRow>("select * from migrate_mailboxes where user_id = $1 order by created_at", [user.id]),
        pool.query<ServiceRow>("select * from migrate_services where user_id = $1 order by count desc, id", [user.id]),
      ]);
      return json({ setup, user: { email: user.email, name: user.name }, mailboxes: boxes.rows.map(toMailbox), services: services.rows.map(toService) } satisfies AppState);
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
    console.error(`[migrate] ${action}`, e);
    return json({ error: e instanceof Error ? e.message.slice(0, 200) : "うまくいきませんでした" }, 500);
  }
}
