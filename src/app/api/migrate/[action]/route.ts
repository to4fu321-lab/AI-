import { guardApi } from "@/lib/access/locks";
import { db, toMailbox, toService, UserError, uuid, type MailboxRow, type ServiceRow } from "@/lib/migrate/db";
import { after } from "next/server";
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

const ACTIONS: Record<string, (b: Body, request: Request) => Promise<unknown>> = {
  /** 画面に出すもの一式 */
  async state(): Promise<AppState> {
    const setup = { db: true, google: googleConfigured() };
    try {
      const pool = await db();
      const [boxes, services] = await Promise.all([
        pool.query<MailboxRow>("select * from migrate_mailboxes order by created_at"),
        pool.query<ServiceRow>("select * from migrate_services order by count desc, id"),
      ]);
      return { setup, mailboxes: boxes.rows.map(toMailbox), services: services.rows.map(toService) };
    } catch (e) {
      // 設定がまだのときも画面は開けるようにして、何が足りないかを見せる
      if (e instanceof UserError) return { setup: { ...setup, db: false }, mailboxes: [], services: [] };
      throw e;
    }
  },

  /** メールを調べ始める（返事はすぐ返す。進めるのはサーバーなので、画面を閉じても続く） */
  async scan(b, request) {
    const id = uuid(b.mailboxId);
    const deadline = Date.now() + SCAN_BUDGET_MS;
    const origin = new URL(request.url).origin;
    await requestScan(id);
    after(async () => {
      // 時間で区切れたら、続きを進める回を起こす
      if ((await runScan(id, deadline)) === "more") await kick(origin);
    });
    return { ok: true };
  },

  /** 調べるのを止める */
  async stop(b) {
    await stopScan(uuid(b.mailboxId));
    return { ok: true };
  },

  /** 数え直すために、調べた結果を空にする */
  async reset(b) {
    await resetScan(uuid(b.mailboxId));
    return { ok: true };
  },

  /** つながりを切る */
  async disconnect(b) {
    await disconnect(uuid(b.mailboxId));
    return { ok: true };
  },

  /** 仕分け・開くページ・メモを変える */
  async update(b) {
    const id = uuid(b.id);
    const pool = await db();
    if (typeof b.status === "string") {
      if (!STATUSES.includes(b.status as Status)) throw new UserError("仕分けの種類が違います");
      await pool.query("update migrate_services set status = $2, updated_at = now() where id = $1", [id, b.status]);
    }
    if (typeof b.login_url === "string") {
      const url = str(b.login_url, 500).trim();
      if (url && !/^https:\/\/[^\s]+$/.test(url)) throw new UserError("開くページは https:// から始まる URL を入れてください");
      await pool.query("update migrate_services set login_url = $2, updated_at = now() where id = $1", [id, url]);
    }
    if (typeof b.note === "string") await pool.query("update migrate_services set note = $2, updated_at = now() where id = $1", [id, str(b.note, 2000)]);
    return { ok: true };
  },
};

export async function POST(request: Request, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  const denied = await guardApi(request, `/api/migrate/${action}`);
  if (denied) return denied;
  const run = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : null;
  if (!run) return Response.json({ error: "その操作はありません" }, { status: 404 });
  try {
    const body = (await request.json().catch(() => ({}))) as Body;
    return Response.json(await run(body, request), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof UserError) return Response.json({ error: e.message }, { status: 400 });
    console.error(`[migrate] ${action}`, e);
    return Response.json({ error: e instanceof Error ? e.message.slice(0, 200) : "うまくいきませんでした" }, { status: 500 });
  }
}
