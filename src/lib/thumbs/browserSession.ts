import "server-only";
import type { HTTPRequest, Page } from "puppeteer-core";
import { getBrowser } from "./render";
import { assertPublicUrl, thumbsLog } from "./safeFetch";

/**
 * ブラウザのページを 1 枚開いたままにして、その中から読み込む（サイトごと）。
 *
 * - Cloudflare などが、このアプリのサーバーからの普通の読み込みを断るサイト（「人間か確かめる」ページを返す）。
 *   本物のブラウザなら確認を通れるので、通ったページの中から同じサイトのほかのページを読む。
 *   ページを 1 枚ずつ表示し直す（1 枚 30 秒）より、ずっと速い（1 枚 1 秒以下）
 * - Gofile のように、サイト自身のスクリプトが作る合言葉がないと答えない API。
 *   サイトのページの中で、サイト自身のスクリプトに合言葉を作らせて問い合わせる
 */

interface Session {
  page: Page;
  at: number;
}

const sessions = new Map<string, Promise<Session | null>>();
/** 開いたままにするページの数（メモリを使うので 2 枚まで） */
const MAX_SESSIONS = 2;
/** 使われなくなってから閉じるまでの時間 */
const IDLE_MS = 45000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function closeSession(origin: string) {
  const s = sessions.get(origin);
  sessions.delete(origin);
  const session = await s?.catch(() => null);
  await session?.page.close().catch(() => {});
}

function scheduleClose(origin: string, session: Session) {
  const timer = setTimeout(() => {
    if (Date.now() - session.at >= IDLE_MS - 100) void closeSession(origin);
    else scheduleClose(origin, session);
  }, IDLE_MS);
  (timer as { unref?: () => void }).unref?.();
}

/** 「人間か確かめる」ページ（Cloudflare など）が出ている間は true */
const CHALLENGE = `(() => {
  const t = document.title || "";
  return /just a moment|attention required|checking your browser|しばらくお待ちください|お待ちください/i.test(t)
    || !!document.querySelector("#challenge-form, #challenge-running, #cf-challenge-running, .cf-browser-verification, script[src*='challenge-platform']") && (document.body?.innerText || "").length < 600;
})()`;

async function openSession(origin: string, startUrl: string, signal: AbortSignal, plainBrowser: boolean): Promise<Session | null> {
  const began = Date.now();
  let page: Page | null = null;
  try {
    await assertPublicUrl(startUrl);
    const browser = await getBrowser();
    page = await browser.newPage();
    // 「HeadlessChrome」と名乗ると自動アクセスと判定されやすいので、普通の Chrome の名前にする
    const ua = (await browser.userAgent()).replace(/Headless/gi, "");
    await page.setUserAgent({ userAgent: ua });
    await page.setExtraHTTPHeaders({ "accept-language": "ja,en;q=0.8" });
    if (!plainBrowser) await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    // ブラウザが出す通信も、内部ネットワーク宛てでないか確かめる。画像・動画・フォントは読まない（速さのため）
    const hostOk = new Map<string, Promise<boolean>>();
    await page.setRequestInterception(true);
    page.on("request", (req: HTTPRequest) => {
      void (async () => {
        const u = req.url();
        if (!/^https?:/.test(u)) return req.continue().catch(() => {});
        let host: string;
        try {
          host = new URL(u).host;
        } catch {
          return req.abort("blockedbyclient").catch(() => {});
        }
        let ok = hostOk.get(host);
        if (!ok) {
          ok = assertPublicUrl(u).then(
            () => true,
            () => false,
          );
          hostOk.set(host, ok);
        }
        if (!(await ok)) return req.abort("blockedbyclient").catch(() => {});
        const type = req.resourceType();
        if (type === "media" || type === "font" || (type === "image" && !/challenge|turnstile|captcha/i.test(u))) return req.abort("aborted").catch(() => {});
        return req.continue().catch(() => {});
      })();
    });
    page.on("popup", (p) => void p?.close().catch(() => {}));
    const res = await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null);
    // 「人間か確かめる」ページが出ていたら、通り抜けるまで待つ（最大 20 秒）
    const until = Date.now() + 20000;
    let challenged = false;
    while (Date.now() < until && !signal.aborted) {
      const waiting = await page.evaluate(CHALLENGE).catch(() => true);
      if (!waiting) break;
      challenged = true;
      await sleep(700);
    }
    const stuck = await page.evaluate(CHALLENGE).catch(() => true);
    const title = await page.title().catch(() => "");
    thumbsLog(
      `session ${stuck ? "確認を通れず" : "開いた"} ${Date.now() - began}ms HTTP ${res?.status() ?? "-"}${challenged ? "（確認あり）" : ""} 題名「${title.slice(0, 40)}」 ${startUrl.slice(0, 90)}`,
    );
    if (stuck) {
      await page.close().catch(() => {});
      return null;
    }
    const session = { page, at: Date.now() };
    scheduleClose(origin, session);
    return session;
  } catch (err) {
    thumbsLog(`session 失敗 ${Date.now() - began}ms ${err instanceof Error ? err.message.slice(0, 120) : String(err)} ${startUrl.slice(0, 90)}`);
    await page?.close().catch(() => {});
    return null;
  }
}

/** そのサイトのページを開いたままにしたものを返す（なければ開く。開けなければ null） */
export async function getSession(origin: string, startUrl: string, signal: AbortSignal, plainBrowser = false): Promise<Page | null> {
  let s = sessions.get(origin);
  if (!s) {
    // 枚数の上限を越えるなら、いちばん古いものを閉じる
    if (sessions.size >= MAX_SESSIONS) await closeSession(sessions.keys().next().value!);
    s = openSession(origin, startUrl, signal, plainBrowser);
    sessions.set(origin, s);
    void s.then((v) => !v && sessions.get(origin) === s && sessions.delete(origin));
  }
  const session = await s;
  if (!session || session.page.isClosed()) {
    sessions.delete(origin);
    return null;
  }
  session.at = Date.now();
  return session.page;
}

export function dropSession(origin: string) {
  void closeSession(origin);
}

/**
 * 開いたままのページの中から、同じサイトのページを読む（HTML の文字を返す）。
 * 読めなければ null（呼ぶ側は、ページを表示し直す方法に戻る）
 */
export async function fetchInBrowser(url: string, signal: AbortSignal): Promise<{ status: number; html: string; finalUrl: string } | null> {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }
  const began = Date.now();
  const page = await getSession(origin, url, signal);
  if (!page) return null;
  try {
    const out = (await Promise.race([
      page.evaluate(async (target: string) => {
        try {
          const res = await fetch(target, { credentials: "include", redirect: "follow", headers: { accept: "text/html,application/xhtml+xml" } });
          const type = res.headers.get("content-type") || "";
          const text = /html|xml|text|json/i.test(type) || !type ? (await res.text()).slice(0, 3_000_000) : "";
          return { status: res.status, html: text, finalUrl: res.url || target, type };
        } catch (e) {
          return { status: 0, html: "", finalUrl: target, type: String(e) };
        }
      }, url),
      sleep(15000).then(() => null),
    ])) as { status: number; html: string; finalUrl: string; type: string } | null;
    if (!out) {
      thumbsLog(`session 読み込みが時間切れ ${url.slice(0, 100)}`);
      return null;
    }
    // 返ってきたのがまた「人間か確かめる」ページなら、読めていない
    const challenged = /<title>\s*(?:Just a moment|Attention Required)/i.test(out.html) || /challenge-platform|cf-chl-/i.test(out.html.slice(0, 20000)) && out.html.length < 60000;
    thumbsLog(`session fetch ${out.status}${challenged ? "（確認ページ）" : ""} ${Date.now() - began}ms html=${out.html.length} ${url.slice(0, 100)}`);
    if (out.status === 0 || challenged) {
      // ページの中の確認が切れた。開き直せるように閉じておく
      if (challenged) dropSession(origin);
      return null;
    }
    if (new URL(out.finalUrl).origin !== origin) return null;
    return { status: out.status, html: out.html, finalUrl: out.finalUrl };
  } catch (err) {
    thumbsLog(`session fetch 失敗 ${err instanceof Error ? err.message.slice(0, 100) : String(err)} ${url.slice(0, 100)}`);
    dropSession(origin);
    return null;
  }
}
