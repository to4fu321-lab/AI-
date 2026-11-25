import "server-only";
import { generateVAPIDKeys, sendNotification } from "web-push";
import { db } from "./db";
import { thumbsLog } from "./safeFetch";

/**
 * 自動巡回で新しい動画が見つかったときの、プッシュ通知。
 *
 * - 送るための鍵（VAPID）は、初めて使うときに作ってデータベースに置く（設定は要らない）
 * - 通知を受け取る端末（ブラウザが発行する「宛先」）もデータベースに置く。届かなくなった宛先は消す
 * - iPhone・iPad は、Safari で「ホーム画面に追加」したアプリから開いたときだけ受け取れる（iOS 16.4 以降）
 */

interface Keys {
  publicKey: string;
  privateKey: string;
}

export interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

async function keys(): Promise<Keys | null> {
  const pool = await db().catch(() => null);
  if (!pool) return null;
  const r = await pool.query<{ value: Keys }>("select value from thumbs_patrol_meta where key = 'vapid'");
  if (r.rows[0]?.value?.publicKey) return r.rows[0].value;
  const made = generateVAPIDKeys();
  // 同時に 2 つ作られても、先に入ったほうを使う
  await pool.query("insert into thumbs_patrol_meta (key, value) values ('vapid', $1) on conflict (key) do nothing", [JSON.stringify(made)]);
  const again = await pool.query<{ value: Keys }>("select value from thumbs_patrol_meta where key = 'vapid'");
  return again.rows[0]?.value ?? null;
}

/** 画面が宛先を作るのに使う公開鍵 */
export async function pushPublicKey(): Promise<string | null> {
  return (await keys())?.publicKey ?? null;
}

export const isPushSub = (v: unknown): v is PushSub => {
  const s = v as PushSub;
  return (
    !!s &&
    typeof s.endpoint === "string" &&
    /^https:\/\//.test(s.endpoint) &&
    s.endpoint.length < 1000 &&
    typeof s.keys?.p256dh === "string" &&
    typeof s.keys?.auth === "string" &&
    s.keys.p256dh.length < 200 &&
    s.keys.auth.length < 100
  );
};

export async function addSub(sub: PushSub, label: string): Promise<void> {
  const pool = await db();
  if (!pool) throw new Error("データベースが設定されていません");
  await pool.query(
    `insert into thumbs_push (endpoint, keys, label) values ($1, $2, $3)
     on conflict (endpoint) do update set keys = excluded.keys, label = excluded.label`,
    [sub.endpoint, JSON.stringify(sub.keys), label.slice(0, 100)],
  );
}

export async function removeSub(endpoint: string): Promise<void> {
  const pool = await db();
  await pool?.query("delete from thumbs_push where endpoint = $1", [endpoint]);
}

export async function hasSub(endpoint: string): Promise<boolean> {
  const pool = await db().catch(() => null);
  if (!pool) return false;
  const r = await pool.query("select 1 from thumbs_push where endpoint = $1", [endpoint]);
  return !!r.rowCount;
}

/** 登録されているすべての端末に通知を送る。送れた数を返す */
export async function pushAll(message: { title: string; body: string; url?: string; tag?: string }): Promise<number> {
  const pool = await db().catch(() => null);
  if (!pool) return 0;
  const k = await keys();
  if (!k) return 0;
  const subs = await pool.query<{ endpoint: string; keys: PushSub["keys"] }>("select endpoint, keys from thumbs_push limit 50");
  if (!subs.rowCount) return 0;
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || "thumbs.invalid";
  const vapidDetails = { subject: `https://${host}/thumbs`, publicKey: k.publicKey, privateKey: k.privateKey };
  const payload = JSON.stringify({ url: "/thumbs", ...message });
  let sent = 0;
  for (const s of subs.rows) {
    try {
      await sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload, { vapidDetails, TTL: 6 * 60 * 60, urgency: "normal" });
      sent++;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      // 404・410：その端末は通知をやめた（アプリを消した・許可を取り消した）。宛先を消す
      if (status === 404 || status === 410) await pool.query("delete from thumbs_push where endpoint = $1", [s.endpoint]).catch(() => {});
      thumbsLog(`push 失敗 HTTP ${status ?? "-"} ${err instanceof Error ? err.message.slice(0, 80) : ""}`);
    }
  }
  return sent;
}
