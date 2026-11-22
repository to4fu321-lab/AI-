import "server-only";
import { createHmac, randomBytes } from "node:crypto";
import { UserError, type Creds } from "./db";
import type { Post, SiteRules, Video } from "./types";

/**
 * 各サイトへの投稿。どれも公式の API を使う（ID・パスワードでログインを自動操作するやり方は、
 * 規約で禁じられていて 2 段階認証などですぐ止まるので使わない）。
 * 動画は置き場の期限つき URL から読み、サーバーのメモリに全部は載せずに流し込む。
 */

export interface PublishInput {
  post: Pick<Post, "title" | "body">;
  video: Pick<Video, "size" | "name">;
  /** 置き場の動画を読むための期限つき URL */
  sourceUrl: string;
  rules: SiteRules;
  creds: Creds;
}

function need(creds: Creds, keys: string[], siteLabel: string) {
  const missing = keys.filter((k) => !creds[k]);
  if (missing.length) throw new UserError(`${siteLabel} の鍵が足りません（投稿先の設定で入れてください）`);
}

async function fail(label: string, res: Response): Promise<never> {
  const text = (await res.text().catch(() => "")).slice(0, 400);
  throw new UserError(`${label}（${res.status}）${text ? `：${text}` : ""}`);
}

async function openSource(url: string): Promise<{ body: ReadableStream<Uint8Array>; size: number }> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new UserError(`置き場の動画を読めませんでした（${res.status}）`);
  return { body: res.body, size: Number(res.headers.get("content-length") ?? 0) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- YouTube ----------

export async function youtubeAccessToken(creds: Creds): Promise<string> {
  need(creds, ["clientId", "clientSecret"], "YouTube");
  if (!creds.refreshToken) throw new UserError("YouTube とまだ連携していません（投稿先の設定で「Google と連携」を押してください）");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token: creds.refreshToken, grant_type: "refresh_token" }),
  });
  if (!res.ok) await fail("YouTube の認証に失敗しました。「Google と連携」をやり直してください", res);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function publishYoutube(input: PublishInput): Promise<string> {
  const token = await youtubeAccessToken(input.creds);
  const source = await openSource(input.sourceUrl);
  const size = source.size || input.video.size;
  const start = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=UTF-8",
      "x-upload-content-length": String(size),
      "x-upload-content-type": "video/mp4",
    },
    body: JSON.stringify({
      snippet: { title: input.post.title || input.video.name, description: input.post.body, categoryId: "22" },
      status: { privacyStatus: input.rules.privacy, selfDeclaredMadeForKids: false },
    }),
  });
  const location = start.headers.get("location");
  if (!start.ok || !location) await fail("YouTube がアップロードを受け付けませんでした", start);
  const upload = await fetch(location!, {
    method: "PUT",
    headers: { "content-type": "video/mp4", "content-length": String(size) },
    body: source.body,
    // 動画を流し込みながら送るための指定（Node.js の fetch で必要）
    duplex: "half",
  } as RequestInit);
  if (!upload.ok) await fail("YouTube へのアップロードに失敗しました", upload);
  const { id } = (await upload.json()) as { id: string };
  return `https://youtu.be/${id}`;
}

// ---------- X ----------

const pct = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** OAuth 1.0a の署名つきヘッダー。本文が JSON・multipart のときは URL のパラメータだけを署名に含める */
export function oauth1Header(method: string, url: string, creds: Creds, nonce = randomBytes(16).toString("hex"), timestamp = Math.floor(Date.now() / 1000)): string {
  const u = new URL(url);
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(timestamp),
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };
  const params = [...Object.entries(oauth), ...u.searchParams.entries()]
    .map(([k, v]) => [pct(k), pct(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const base = [method.toUpperCase(), pct(u.origin + u.pathname), pct(params)].join("&");
  const signature = createHmac("sha1", `${pct(creds.apiSecret)}&${pct(creds.accessSecret)}`).update(base).digest("base64");
  return `OAuth ${Object.entries({ ...oauth, oauth_signature: signature }).map(([k, v]) => `${pct(k)}="${pct(v)}"`).join(", ")}`;
}

async function xFetch(creds: Creds, method: string, url: string, init: { json?: unknown; form?: FormData } = {}): Promise<Response> {
  const headers: Record<string, string> = { authorization: oauth1Header(method, url, creds) };
  if (init.json !== undefined) headers["content-type"] = "application/json";
  return fetch(url, { method, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.form });
}

/** 流れてくる動画を決まった大きさのかたまりに切る */
async function* chunks(stream: ReadableStream<Uint8Array>, size: number): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader();
  let buffer = new Uint8Array(size);
  let filled = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    let offset = 0;
    while (offset < value.length) {
      const n = Math.min(size - filled, value.length - offset);
      buffer.set(value.subarray(offset, offset + n), filled);
      filled += n;
      offset += n;
      if (filled === size) {
        yield buffer;
        buffer = new Uint8Array(size);
        filled = 0;
      }
    }
  }
  if (filled) yield buffer.slice(0, filled);
}

interface XProcessing {
  state: "pending" | "in_progress" | "succeeded" | "failed";
  check_after_secs?: number;
  error?: { message?: string };
}

async function publishX(input: PublishInput): Promise<string> {
  const { creds } = input;
  need(creds, ["apiKey", "apiSecret", "accessToken", "accessSecret"], "X");
  const source = await openSource(input.sourceUrl);
  const api = "https://api.x.com/2";

  const init = await xFetch(creds, "POST", `${api}/media/upload/initialize`, {
    json: { media_type: "video/mp4", media_category: "tweet_video", total_bytes: source.size || input.video.size },
  });
  if (!init.ok) await fail("X が動画を受け付けませんでした", init);
  const mediaId = ((await init.json()) as { data: { id: string } }).data.id;

  let index = 0;
  for await (const chunk of chunks(source.body, 4 * 1024 * 1024)) {
    const form = new FormData();
    form.append("segment_index", String(index++));
    form.append("media", new Blob([chunk], { type: "video/mp4" }), "video.mp4");
    const res = await xFetch(creds, "POST", `${api}/media/upload/${mediaId}/append`, { form });
    if (!res.ok) await fail("X への動画の送信に失敗しました", res);
  }

  const fin = await xFetch(creds, "POST", `${api}/media/upload/${mediaId}/finalize`);
  if (!fin.ok) await fail("X が動画を仕上げられませんでした", fin);
  let processing = ((await fin.json()) as { data: { processing_info?: XProcessing } }).data.processing_info;
  // X 側の変換が終わるまで待つ
  for (let i = 0; processing && processing.state !== "succeeded" && i < 60; i++) {
    if (processing.state === "failed") throw new UserError(`X が動画を変換できませんでした：${processing.error?.message ?? "形式か長さが合いません"}`);
    await sleep(Math.min(processing.check_after_secs ?? 3, 10) * 1000);
    const res = await xFetch(creds, "GET", `${api}/media/upload?command=STATUS&media_id=${mediaId}`);
    if (!res.ok) await fail("X の変換の確認に失敗しました", res);
    processing = ((await res.json()) as { data: { processing_info?: XProcessing } }).data.processing_info;
  }

  const tweet = await xFetch(creds, "POST", `${api}/tweets`, { json: { text: input.post.body, media: { media_ids: [mediaId] } } });
  if (!tweet.ok) await fail("X への投稿に失敗しました", tweet);
  const { data } = (await tweet.json()) as { data: { id: string } };
  return `https://x.com/i/status/${data.id}`;
}

// ---------- Instagram（リール） ----------

async function publishInstagram(input: PublishInput): Promise<string> {
  const { creds } = input;
  need(creds, ["igUserId", "accessToken"], "Instagram");
  // 「Instagram ログイン」で発行したトークン（IG で始まる）と「Facebook ログイン」のトークンで宛先が違う
  const api = creds.accessToken.startsWith("IG") ? "https://graph.instagram.com" : "https://graph.facebook.com";
  const auth = { authorization: `Bearer ${creds.accessToken}` };

  // Instagram は動画を自分で取りに来るので、期限つき URL を渡す
  const create = await fetch(`${api}/${creds.igUserId}/media`, {
    method: "POST",
    headers: auth,
    body: new URLSearchParams({ media_type: "REELS", video_url: input.sourceUrl, caption: input.post.body }),
  });
  if (!create.ok) await fail("Instagram が動画を受け付けませんでした", create);
  const containerId = ((await create.json()) as { id: string }).id;

  for (let i = 0; ; i++) {
    if (i >= 50) throw new UserError("Instagram の動画の処理が時間内に終わりませんでした。少し待ってからもう一度お試しください");
    await sleep(5000);
    const res = await fetch(`${api}/${containerId}?fields=status_code,status`, { headers: auth });
    if (!res.ok) await fail("Instagram の処理の確認に失敗しました", res);
    const state = (await res.json()) as { status_code: string; status?: string };
    if (state.status_code === "FINISHED") break;
    if (state.status_code === "ERROR" || state.status_code === "EXPIRED") {
      throw new UserError(`Instagram が動画を処理できませんでした：${state.status ?? state.status_code}（縦長 9:16・90 秒以内・MP4 が目安です）`);
    }
  }

  const publish = await fetch(`${api}/${creds.igUserId}/media_publish`, { method: "POST", headers: auth, body: new URLSearchParams({ creation_id: containerId }) });
  if (!publish.ok) await fail("Instagram への公開に失敗しました", publish);
  const mediaId = ((await publish.json()) as { id: string }).id;
  const link = await fetch(`${api}/${mediaId}?fields=permalink`, { headers: auth });
  const permalink = link.ok ? ((await link.json()) as { permalink?: string }).permalink : undefined;
  return permalink ?? "https://www.instagram.com/";
}

/** 外部サイトへ投稿して、投稿のURLを返す */
export async function publishExternal(kind: "youtube" | "x" | "instagram", input: PublishInput): Promise<string> {
  if (kind === "youtube") return publishYoutube(input);
  if (kind === "x") return publishX(input);
  return publishInstagram(input);
}
