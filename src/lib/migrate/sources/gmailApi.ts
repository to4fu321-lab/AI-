import "server-only";
import { UserError } from "../db";
import { accessToken, RECONNECT } from "../gmail";
import { clean, decodeHeader, GMAIL_QUERY_ACCOUNT, GMAIL_QUERY_PROMO, PROMO_SAMPLE, PROMO_SAMPLE_WINDOW } from "../parse";
import { RetryLater, type Batch, type Cursor, type Header, type MailSource } from "./types";

/**
 * Gmail を、読むだけの権限（gmail.readonly）の API で読む。
 *
 * 使える量には上限がある：1 人あたり 1 分に 6,000 単位。一覧を 1 回取ると 5 単位、ヘッダを 1 通読むと 20 単位
 * （https://developers.google.com/workspace/gmail/api/reference/quota 2026-11 時点）。
 * そこで 1 秒に 4 通（1 分に約 4,800 単位）で読む。遅いが、進めるのはサーバーの裏なので、使う人は待たなくてよい
 */

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const PER_SECOND = 4;
/** 一覧を 1 回に取る数（1 かたまり。読み終えるたびに続きの場所を保存する） */
const PAGE = 50;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 相手のサーバー側の失敗（5xx）。少し待てば直ることも、その 1 通だけがずっと読めないこともある */
class ServerError extends Error {}

async function call(token: string, path: string): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
    if (res.ok) return res.json();
    const body = await res.text().catch(() => "");
    const limited = res.status === 429 || (res.status === 403 && /rateLimit|quota/i.test(body));
    if ((limited || res.status >= 500) && attempt < 2) {
      await sleep((limited ? 4000 : 800) * 2 ** attempt);
      continue;
    }
    if (limited) throw new RetryLater(`Gmail が混み合っています（HTTP ${res.status}）`);
    if (res.status >= 500) throw new ServerError(`HTTP ${res.status}`);
    if (res.status === 401) throw new UserError(RECONNECT);
    if (res.status === 403) throw new UserError("Gmail を読む許可がありません。Google Cloud で Gmail API を有効にしたか、つなぐときに「メールの閲覧」を許可したか確かめてください");
    if (res.status === 400 && path.includes("pageToken=")) throw new UserError("続きの場所が古くなりました。「数え直す」を押してから、もう一度調べてください");
    throw new Error(`Gmail の読み取りに失敗しました（HTTP ${res.status}）`);
  }
}

async function readHeader(token: string, id: string): Promise<Header | null> {
  const m = (await call(token, `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Delivered-To&metadataHeaders=List-Unsubscribe&metadataHeaders=Precedence&fields=internalDate,labelIds,payload/headers`).catch((e) => {
    if (e instanceof UserError || e instanceof RetryLater) throw e;
    // その 1 通だけ読めない（消された・相手の側で失敗し続ける）ときは、飛ばして先へ進む。全体は止めない
    return null;
  })) as { internalDate?: string; labelIds?: string[]; payload?: { headers?: { name: string; value: string }[] } } | null;
  if (!m) return null;
  const h = (name: string) => m.payload?.headers?.find((x) => x.name.toLowerCase() === name)?.value ?? "";
  return {
    id,
    from: h("from"),
    to: h("delivered-to"),
    subject: clean(decodeHeader(h("subject")), 120),
    at: Number(m.internalDate) || 0,
    // 分類に使うのは Gmail の分類ラベルだけ（利用者が付けたラベルの名前は受け取らない）
    labels: (m.labelIds ?? []).filter((l) => l.startsWith("CATEGORY_")),
    listUnsubscribe: !!h("list-unsubscribe"),
    precedence: h("precedence").slice(0, 20),
  };
}

/** 続きの場所 */
interface GmailCursor {
  /** いま読んでいる段（なければ 1 段目） */
  phase?: "promo";
  /** 2 段目で、今回読んだ通数 */
  promoRead?: number;
  /** 次に読むページ（あれば途中） */
  pageToken?: string;
  /** 今回の調べを始めた時刻（秒） */
  startedAt?: number;
  /** この時刻より後のメールだけ読む（前回読み終えた所。秒） */
  after?: number;
}

export const gmailApi: MailSource = {
  async open(box, cursor) {
    const token = await accessToken(box);
    let state: GmailCursor = { ...(cursor as GmailCursor) };
    return {
      async next(): Promise<Batch> {
        const startedAt = state.startedAt ?? Math.floor(Date.now() / 1000);
        const promo = state.phase === "promo";
        // 2 回目以降は、前回より後に届いた分だけ。初めての 2 段目は、直近の分だけ
        const q = (promo ? GMAIL_QUERY_PROMO : GMAIL_QUERY_ACCOUNT) + (state.after ? ` after:${state.after}` : promo ? ` ${PROMO_SAMPLE_WINDOW}` : "");
        // 一覧が取れないときは、先へ進めない。しばらく置いて、同じ所からやり直す
        const list = (await call(token, `/messages?${new URLSearchParams({ q, maxResults: String(PAGE), fields: "messages/id,nextPageToken", ...(state.pageToken ? { pageToken: state.pageToken } : {}) })}`).catch((e) => {
          throw e instanceof ServerError ? new RetryLater(e.message) : e;
        })) as {
          messages?: { id: string }[];
          nextPageToken?: string;
        };
        const ids = (list.messages ?? []).map((m) => m.id);
        const headers: Header[] = [];
        for (let i = 0; i < ids.length; i += PER_SECOND) {
          const started = Date.now();
          const got = await Promise.all(ids.slice(i, i + PER_SECOND).map((id) => readHeader(token, id)));
          headers.push(...got.filter((h): h is Header => !!h));
          if (i + PER_SECOND < ids.length) await sleep(Math.max(0, 1000 - (Date.now() - started)));
        }
        const promoRead = (state.promoRead ?? 0) + (promo ? ids.length : 0);
        const more = !!list.nextPageToken && !(promo && promoRead >= PROMO_SAMPLE);
        let done = false;
        if (more) state = { ...state, startedAt, pageToken: list.nextPageToken, ...(promo ? { promoRead } : {}) };
        else if (!promo) state = { after: state.after, startedAt, phase: "promo", promoRead: 0 };
        else {
          // 読み終えたら、次回は今回の開始より後だけ読む
          state = { after: startedAt };
          done = true;
        }
        return { headers, read: ids.length, cursor: state as Cursor, remaining: null, done };
      },
      async close() {},
    };
  },
};
