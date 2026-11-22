import { guardApi } from "@/lib/access/locks";
import { extensionOf, kindFromContentType } from "@/lib/thumbs/extract";
import { checkMedia } from "@/lib/thumbs/probe";
import { CookieJar, FetchBlockedError, safeFetch } from "@/lib/thumbs/safeFetch";
import { isVagueType, looksLikePlaylist, mediaMime, readHead } from "@/lib/thumbs/sniff";

export const runtime = "nodejs";
export const maxDuration = 300;

/** 配信形式（HLS）の目次ファイルとして読む大きさの上限 */
const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;

/**
 * GET /api/thumbs/media?url=<メディア>&ref=<見つかったページ>&dl=1
 *
 * 画像・動画をサーバー経由で中継する。
 * - 直リンク禁止（Referer チェック）のサイトでも表示・再生できるよう、元ページを Referer に付ける。
 *   断られたら、動画のあるサイト自身を Referer にして、それでも駄目なら Referer なしで試す
 * - dl=1 のときは Content-Disposition: attachment を付けて「保存」させる
 *   （別ドメインのファイルは <a download> だけでは保存できないため）
 * - Range ヘッダーを転送するので、動画のシーク（途中から再生）もできる
 * - 配信形式（HLS）の目次ファイルは、中に書かれた URL をこの中継経由に書き換えて返す
 *   （目次から呼ばれる断片・鍵は part=1 付きで届く）
 * 画像・動画以外（HTML など）は中継しない（何でも取ってくる踏み台にしないため）。
 * サーバーが名乗る種類が当てにならないときは、ファイルの先頭の中身で確かめる。
 */
export async function GET(request: Request) {
  const denied = await guardApi(request, "/api/thumbs/media");
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const target = params.get("url") ?? "";
  const ref = params.get("ref");
  const download = params.get("dl") === "1";
  /** HLS の目次から呼ばれた断片・鍵・下位の目次 */
  const part = params.get("part") === "1";
  const referer = ref && /^https?:\/\//.test(ref) ? ref : undefined;
  // ck：ファイルを読むときに送る Cookie（Gofile のゲスト用の合言葉など）。書かれたドメイン宛てにだけ送る
  const ck = params.get("ck") ?? undefined;
  const jar = CookieJar.withItemCookie(undefined, ck);

  // check=1：中継せず、リンクが生きているかだけ答える（画面が、保存済みの一覧のリンク切れを外すために使う）
  if (params.get("check") === "1") {
    const k = params.get("kind");
    const kind = k === "embed" || k === "image" ? k : "video";
    let alive: string;
    try {
      alive = (await checkMedia({ kind, src: target, referer, pageUrl: referer ?? target, cookie: ck }, request.signal)).result;
    } catch {
      alive = "unknown";
    }
    return Response.json({ alive }, { headers: { "cache-control": "no-store" } });
  }

  const range = request.headers.get("range");
  // 目次ファイルは全体が必要なので、部分取得はしない
  const forwardRange = range && extensionOf(target) !== "m3u8" ? range : null;

  let upstream: Response;
  let finalUrl: string;
  try {
    ({ res: upstream, url: finalUrl } = await fetchUpstream(target, referer, forwardRange, request.signal, jar));
    if (upstream.status === 206 && /mpegurl/i.test(upstream.headers.get("content-type") ?? "")) {
      await upstream.body?.cancel();
      ({ res: upstream, url: finalUrl } = await fetchUpstream(target, referer, null, request.signal, jar));
    }
  } catch (err) {
    const message = err instanceof FetchBlockedError ? err.message : "取得できませんでした";
    return new Response(message, { status: 400 });
  }
  if (!upstream.ok && upstream.status !== 206) {
    await upstream.body?.cancel();
    return new Response(`元のサイトがエラーを返しました（HTTP ${upstream.status}）`, { status: 502 });
  }

  const type = upstream.headers.get("content-type");
  const out = new Headers();
  out.set("x-content-type-options", "nosniff");
  // SVG などにスクリプトが仕込まれていても、このドメインで実行させない
  out.set("content-security-policy", "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox");

  // --- 配信形式（HLS）の目次ファイル ---
  const maybePlaylist = /mpegurl/i.test(type ?? "") || extensionOf(finalUrl) === "m3u8" || extensionOf(target) === "m3u8";
  if (maybePlaylist && upstream.status === 200) {
    const bytes = await readHead(upstream, MAX_PLAYLIST_BYTES);
    if (!looksLikePlaylist(bytes)) return new Response("配信の目次ファイルではありませんでした", { status: 415 });
    out.set("content-type", "application/vnd.apple.mpegurl");
    out.set("cache-control", "no-store");
    return new Response(rewritePlaylist(new TextDecoder().decode(bytes), finalUrl, referer, ck), { status: 200, headers: out });
  }

  // サーバーが中身をはっきり名乗っていれば、それを使う。
  // 「ダウンロード用」（force-download・octet-stream など）や名乗りがないときは、ファイルの先頭の中身で決める
  let kind = isVagueType(type) ? null : kindFromContentType(type);
  if (!kind && !part) {
    const sniffed = await sniffMime(target, referer, request.signal, jar);
    if (sniffed && /mpegurl/i.test(sniffed) && upstream.status === 200) {
      // 拡張子も種類の名乗りもない配信の目次（.txt・.jpg などに見せかけたもの）。中の URL を中継経由に書き換える
      const bytes = await readHead(upstream, MAX_PLAYLIST_BYTES);
      if (looksLikePlaylist(bytes)) {
        out.set("content-type", "application/vnd.apple.mpegurl");
        out.set("cache-control", "no-store");
        return new Response(rewritePlaylist(new TextDecoder().decode(bytes), finalUrl, referer, ck), { status: 200, headers: out });
      }
    }
    if (sniffed) {
      kind = sniffed.startsWith("image/") ? "image" : "video";
      out.set("content-type", sniffed);
    }
  }
  if (kind && out.has("content-type")) {
    // 先頭の中身から種類を決めた
  } else if (!kind && part) {
    // 目次から呼ばれた断片・暗号の鍵。HTML でなければ、種類を「ただのデータ」にして通す
    if (/html/i.test(type ?? "")) {
      await upstream.body?.cancel();
      return new Response("中継できない種類です", { status: 415 });
    }
    // 種類を名乗らない小さな返事は、下位の目次かもしれない。目次なら中の URL を書き換える
    const size = Number(upstream.headers.get("content-length"));
    if (upstream.status === 200 && (!type || /^text\//i.test(type)) && !(size > MAX_PLAYLIST_BYTES)) {
      const bytes = await readHead(upstream, MAX_PLAYLIST_BYTES);
      const playlist = looksLikePlaylist(bytes);
      out.set("content-type", playlist ? "application/vnd.apple.mpegurl" : "application/octet-stream");
      out.set("cache-control", "no-store");
      const data = playlist ? rewritePlaylist(new TextDecoder().decode(bytes), finalUrl, referer, ck) : (bytes as Uint8Array<ArrayBuffer>);
      return new Response(data, { status: 200, headers: out });
    }
    kind = "video";
    out.set("content-type", "application/octet-stream");
  } else if (!kind) {
    await upstream.body?.cancel();
    return new Response("画像・動画ではないため中継できません", { status: 415 });
  } else {
    // 「中身の種類」を正しく名乗る。iPhone の Safari は video/mp4 などでないと再生しない
    // （元のサーバーが application/octet-stream などで返すことがある）
    out.set("content-type", properType(type, finalUrl, kind));
  }

  // 圧縮して送られてきたものは、ここで元に戻っているので大きさが変わっている
  const encoded = !!upstream.headers.get("content-encoding");
  for (const name of ["content-length", "content-range", "accept-ranges", "last-modified", "etag"]) {
    const v = upstream.headers.get(name);
    if (v && !(encoded && name !== "last-modified")) out.set(name, v);
  }

  let body: ReadableStream<Uint8Array> | null = upstream.body;
  let status = upstream.status;
  const wanted = parseRange(range);
  if (upstream.status === 206) {
    out.set("accept-ranges", "bytes");
  } else if (wanted && upstream.status === 200) {
    // 元のサーバーが部分取得（Range）に対応していないとき、こちらで切り出して 206 で返す。
    // Safari は Range に 206 で答えないと動画を再生しない
    let total = encoded ? NaN : Number(upstream.headers.get("content-length"));
    if (!(total > 0) && !download && kind === "video") {
      // 全体の大きさを名乗らないサーバー。Safari は大きさがわからないと再生しないので、一度最後まで読んで数える（覚えておく）
      total = (await measureLength(target, referer, request.signal, jar)) ?? NaN;
    }
    if (Number.isFinite(total) && total > 0 && body) {
      const start = wanted.suffix !== undefined ? Math.max(0, total - wanted.suffix) : wanted.start;
      const end = Math.min(wanted.end ?? total - 1, total - 1);
      if (start > end || start >= total) {
        await upstream.body?.cancel();
        return new Response(null, { status: 416, headers: { "content-range": `bytes */${total}` } });
      }
      body = sliceStream(body, start, end);
      status = 206;
      out.set("content-range", `bytes ${start}-${end}/${total}`);
      out.set("content-length", String(end - start + 1));
      out.set("accept-ranges", "bytes");
    } else {
      // 全体の大きさがわからないと切り出せない。部分取得できるふりはしない
      out.delete("accept-ranges");
    }
  } else if (!out.has("accept-ranges") && out.has("content-length")) {
    // 全体の大きさがわかっていれば、上の切り出しで部分取得に答えられる
    out.set("accept-ranges", "bytes");
  }
  out.set("cache-control", "public, max-age=3600");
  if (download) {
    const name = fileNameFor(finalUrl, type, params.get("name"));
    out.set(
      "content-disposition",
      `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    );
  }
  return new Response(body, { status, headers: out });
}

/** 読み込みに成功したか（部分取得の 206 も成功） */
const okStatus = (s: number) => (s >= 200 && s < 300) || s === 206;

/**
 * 元のサイトから取ってくる。うまくいかなければ、やり方を変えて試し直す：
 * - Referer：見つけたページ → 動画のあるサイト自身 → 名乗らない
 * - 部分取得（Range）：ダウンロード用の仕組み（download.php など）には、部分取得を頼むとエラーを返すものがある。
 *   その場合は部分取得を頼まずに読み直す（必要な部分は呼ぶ側で切り出す）
 */
async function fetchUpstream(target: string, referer: string | undefined, range: string | null, signal: AbortSignal, jar?: CookieJar) {
  let own: string | undefined;
  try {
    own = `${new URL(target).origin}/`;
  } catch {
    /* URL の形式エラーは safeFetch が知らせる */
  }
  const referers = [...new Set([referer, own, undefined])];
  const ranges = range ? [range, null] : [null];
  let last: { res: Response; url: string } | undefined;
  for (const refererToTry of referers) {
    for (const rangeToTry of ranges) {
      await last?.res.body?.cancel().catch(() => {});
      const headers: Record<string, string> = { accept: "image/*,video/*,*/*;q=0.5" };
      if (rangeToTry) headers.range = rangeToTry;
      if (refererToTry) headers.referer = refererToTry;
      // 時間切れは「返事が届くまで」だけ。中身は時間をかけて流してよい（大きな動画が途中で切れないように）
      last = await safeFetch(target, { headers, timeoutMs: 30000, signal, streamBody: true, jar });
      if (okStatus(last.res.status)) return last;
      // ファイルがない（404・410）なら、やり方を変えても同じ
      if (last.res.status === 404 || last.res.status === 410) return last;
    }
  }
  return last!;
}

/** 全体の大きさを名乗らない動画の、数えた大きさ（同じサーバーが動いている間は覚えておく） */
const lengthCache = new Map<string, Promise<number | null>>();
/** 数えるのは 1 GB まで・2 分まで */
const MAX_MEASURE_BYTES = 1024 * 1024 * 1024;

function measureLength(target: string, referer: string | undefined, signal: AbortSignal, jar?: CookieJar): Promise<number | null> {
  let job = lengthCache.get(target);
  if (!job) {
    job = (async () => {
      try {
        const limit = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
        const { res } = await fetchUpstream(target, referer, null, limit, jar);
        if (!okStatus(res.status) || !res.body) return null;
        const reader = res.body.getReader();
        let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return size;
          size += value.byteLength;
          if (size > MAX_MEASURE_BYTES) {
            await reader.cancel().catch(() => {});
            return null;
          }
        }
      } catch {
        return null;
      }
    })();
    lengthCache.set(target, job);
    void job.then((n) => n === null && lengthCache.delete(target));
    if (lengthCache.size > 500) lengthCache.delete(lengthCache.keys().next().value!);
  }
  return job;
}

/** 先頭の中身から決めた種類（同じサーバーが動いている間は覚えておく） */
const sniffCache = new Map<string, string | null>();

async function sniffMime(target: string, referer: string | undefined, signal: AbortSignal, jar?: CookieJar): Promise<string | null> {
  const known = sniffCache.get(target);
  if (known !== undefined) return known;
  let mime: string | null = null;
  try {
    const { res } = await fetchUpstream(target, referer, "bytes=0-511", signal, jar);
    if (okStatus(res.status)) mime = mediaMime(await readHead(res, 512));
    else await res.body?.cancel().catch(() => {});
  } catch {
    return null;
  }
  sniffCache.set(target, mime);
  if (sniffCache.size > 2000) sniffCache.delete(sniffCache.keys().next().value!);
  return mime;
}

/**
 * HLS の目次に書かれた URL（断片・下位の目次・暗号の鍵）を、この中継経由の URL に書き換える。
 * こうしておくと、プレーヤーが目次の先を読みに行くときも、同じ Referer で中継される
 */
function rewritePlaylist(text: string, baseUrl: string, referer: string | undefined, ck?: string): string {
  const via = (raw: string): string => {
    try {
      const abs = new URL(raw.trim(), baseUrl);
      if (abs.protocol !== "http:" && abs.protocol !== "https:") return raw;
      const p = new URLSearchParams({ url: abs.toString() });
      if (referer) p.set("ref", referer);
      if (ck) p.set("ck", ck);
      p.set("part", "1");
      return `/api/thumbs/media?${p}`;
    } catch {
      return raw;
    }
  };
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (!line.trim()) return line;
      if (line.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (_, uri: string) => `URI="${via(uri)}"`);
      return via(line);
    })
    .join("\n");
}

const MIME_BY_EXT: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  ogv: "video/ogg",
  ts: "video/mp2t",
  m3u8: "application/vnd.apple.mpegurl",
  mpd: "application/dash+xml",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  heic: "image/heic",
};

/** 元のサーバーが名乗った種類が曖昧（octet-stream など）なら、拡張子から正しい種類にする */
function properType(type: string | null, url: string, kind: "image" | "video"): string {
  const t = (type ?? "").split(";")[0].trim().toLowerCase();
  if (t && t !== "application/octet-stream" && t !== "binary/octet-stream" && t !== "application/binary" && t !== "text/plain") {
    return type!;
  }
  const ext = extensionOf(url);
  return MIME_BY_EXT[ext] ?? (kind === "video" ? "video/mp4" : "image/jpeg");
}

/** Range ヘッダー（1 区間だけ）を読む。bytes=100-、bytes=100-199、bytes=-500 */
function parseRange(range: string | null): { start: number; end?: number; suffix?: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec((range ?? "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") return { start: 0, suffix: Number(m[2]) };
  return { start: Number(m[1]), end: m[2] === "" ? undefined : Number(m[2]) };
}

/** 流れてくるデータの start〜end バイト目だけを通す */
function sliceStream(source: ReadableStream<Uint8Array>, start: number, end: number): ReadableStream<Uint8Array> {
  let offset = 0;
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        const chunkStart = offset;
        offset += value.byteLength;
        if (offset <= start) continue;
        const from = Math.max(0, start - chunkStart);
        const to = Math.min(value.byteLength, end - chunkStart + 1);
        if (to > from) controller.enqueue(value.subarray(from, to));
        if (offset > end) {
          controller.close();
          await reader.cancel().catch(() => {});
        }
        return;
      }
    },
    cancel() {
      void reader.cancel().catch(() => {});
    },
  });
}

const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "image/heic": "heic",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "application/vnd.apple.mpegurl": "m3u8",
  "application/x-mpegurl": "m3u8",
};

function fileNameFor(url: string, type: string | null, requested: string | null): string {
  const fromUrl = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
  let name = (requested || fromUrl || "media").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 120);
  const ext = EXT_BY_TYPE[(type ?? "").split(";")[0].trim().toLowerCase()];
  if (ext && !name.toLowerCase().endsWith(`.${ext}`) && !/\.[a-z0-9]{2,4}$/i.test(name)) name += `.${ext}`;
  return name;
}
