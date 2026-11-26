import "server-only";
import { createHash } from "node:crypto";
import { db } from "./db";

/**
 * 自動巡回で使う Gofile のトークン（利用者ごとに 1 つずつ、最大 5 つ）。
 *
 * - 画面の「🔑 Gofile の設定」で保存したトークンが、ここに足される（ほかの人のトークンを上書きしない）
 * - 巡回は、断られていないものを上から順に使う。トークンが断られたら（無効・期限切れ）次のトークンに切り替える
 * - サーバー全体が「聞きすぎ」で止められたときは切り替えない（どのトークンでも同じで、聞き続けると長引くため）
 */

export interface TokenEntry {
  tag: string;
  label: string;
  token: string;
  addedAt: number;
}

export const MAX_TOKENS = 5;
/** 断られたトークンを使わない時間（過ぎたら 1 回だけ試し直す） */
export const BAD_TOKEN_MS = 24 * 60 * 60 * 1000;

/** トークンそのものではなく、見分けるための要約（ログやデータベースの印に使う） */
export const tokenTag = (t: string) => createHash("sha256").update(`gofile:${t}`).digest("hex").slice(0, 16);

export const isGofileToken = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9]{10,128}$/.test(v.trim());

async function read<T>(key: string): Promise<T | null> {
  const pool = await db().catch(() => null);
  if (!pool) return null;
  const r = await pool.query<{ value: T }>("select value from thumbs_patrol_meta where key = $1", [key]).catch(() => null);
  return r?.rows[0]?.value ?? null;
}

async function write(key: string, value: unknown) {
  const pool = await db();
  if (!pool) throw new Error("データベースが設定されていません");
  await pool.query("insert into thumbs_patrol_meta (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value", [key, JSON.stringify(value)]);
}

/** 巡回用のトークン（前の作りで 1 つだけ保存していたものも引き継ぐ） */
export async function listTokens(): Promise<TokenEntry[]> {
  const list = (await read<TokenEntry[]>("gofileTokens")) ?? [];
  const legacy = await read<string>("gofileToken");
  if (legacy && isGofileToken(legacy) && !list.some((e) => e.token === legacy)) {
    list.push({ tag: tokenTag(legacy), label: "前に設定したトークン", token: legacy, addedAt: 0 });
  }
  return list.slice(0, MAX_TOKENS);
}

/** 断られたトークンの印（要約 → 断られた時刻） */
export async function badTokens(): Promise<Record<string, number>> {
  return (await read<Record<string, number>>("gofileBadTokens")) ?? {};
}

export async function markBad(token: string): Promise<void> {
  const bad = await badTokens();
  bad[tokenTag(token)] = Date.now();
  // 古い印は消す
  for (const [k, at] of Object.entries(bad)) if (Date.now() - at > 7 * BAD_TOKEN_MS) delete bad[k];
  await write("gofileBadTokens", bad).catch(() => {});
}

/** 今使ってよいトークン（断られて 24 時間たっていないものを除く）を、順番に */
export async function usableTokens(): Promise<string[]> {
  const [list, bad] = await Promise.all([listTokens(), badTokens()]);
  return list.filter((e) => !(bad[e.tag] && Date.now() - bad[e.tag] < BAD_TOKEN_MS)).map((e) => e.token);
}

/** 足す（同じトークンなら名前を変えるだけ。入れ直したトークンは「断られた」印を外す） */
export async function addToken(label: string, token: string): Promise<void> {
  const t = token.trim();
  if (!isGofileToken(t)) throw new Error("英数字だけのトークンを貼り付けてください");
  const list = await listTokens();
  const tag = tokenTag(t);
  const i = list.findIndex((e) => e.tag === tag);
  const name = label.trim().slice(0, 30) || "名前なし";
  if (i >= 0) list[i] = { ...list[i], label: name };
  else {
    if (list.length >= MAX_TOKENS) throw new Error(`巡回用のトークンは ${MAX_TOKENS} つまでです。使わないものを消してから足してください`);
    list.push({ tag, label: name, token: t, addedAt: Date.now() });
  }
  await write("gofileTokens", list);
  await write("gofileToken", "");
  const bad = await badTokens();
  if (bad[tag]) {
    delete bad[tag];
    await write("gofileBadTokens", bad);
  }
}

export async function removeToken(tag: string): Promise<void> {
  const list = (await listTokens()).filter((e) => e.tag !== tag);
  await write("gofileTokens", list);
  await write("gofileToken", "");
}

/** 画面に見せる形（トークンそのものは出さず、最後の 4 文字だけ） */
export async function tokenView(): Promise<{ tag: string; label: string; tail: string; badAt: number | null }[]> {
  const [list, bad] = await Promise.all([listTokens(), badTokens()]);
  return list.map((e) => ({ tag: e.tag, label: e.label, tail: e.token.slice(-4), badAt: bad[e.tag] && Date.now() - bad[e.tag] < BAD_TOKEN_MS ? bad[e.tag] : null }));
}
