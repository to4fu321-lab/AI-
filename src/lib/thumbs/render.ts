import "server-only";
import type { Browser, HTTPRequest } from "puppeteer-core";
import { extensionOf, kindFromContentType, kindFromUrl } from "./extract";
import { assertPublicUrl } from "./safeFetch";

/**
 * 本物のブラウザ（Chromium）でページを開いて、JavaScript が描き終わった後の HTML を得る。
 *
 * 画面を JavaScript で後から描くサイトは、サーバーから届く HTML に画像がない。
 * ブラウザで開いてスクロールし、表示し終わった HTML と、
 * その間にブラウザが受け取った画像・動画の URL（通信の記録）を集める。
 *
 * - Vercel 上では @sparticuz/chromium（サーバー用に小さくした Chromium）を使う
 * - 手元で試すときは CHROMIUM_PATH にブラウザの場所を入れる
 * - ブラウザが出すすべての通信も、内部ネットワーク宛てでないか確かめる（SSRF 対策）
 */

const USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

let browserPromise: Promise<Browser> | null = null;

async function launch(): Promise<Browser> {
  const puppeteer = (await import("puppeteer-core")).default;
  const local = process.env.CHROMIUM_PATH;
  if (local) {
    return puppeteer.launch({ executablePath: local, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  }
  const chromium = (await import("@sparticuz/chromium")).default;
  // 知らないページを開くので、同一オリジンポリシーを切る設定は外す
  const args = chromium.args.filter((a) => a !== "--disable-web-security" && a !== "--allow-running-insecure-content");
  return puppeteer.launch({ executablePath: await chromium.executablePath(), args, headless: true });
}

/** ブラウザの起動は数秒かかるので、同じサーバー上では使い回す */
async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = launch().then((b) => {
      b.on("disconnected", () => (browserPromise = null));
      return b;
    });
    browserPromise.catch(() => (browserPromise = null));
  }
  return browserPromise;
}

/** 同時に開くブラウザのタブ数（メモリを使うので少なめ） */
const MAX_TABS = 2;
let openTabs = 0;
const waiting: (() => void)[] = [];
async function acquireTab() {
  if (openTabs < MAX_TABS) {
    openTabs++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  openTabs++;
}
function releaseTab() {
  openTabs--;
  waiting.shift()?.();
}

export interface NetworkMedia {
  url: string;
  kind: "image" | "video";
  /** その通信を出したページ（iframe の中のプレーヤーなら、そのプレーヤーのページ） */
  referer?: string;
}

export interface Rendered {
  html: string;
  finalUrl: string;
  /** 表示中にブラウザが受け取った画像・動画 */
  network: NetworkMedia[];
  /** ページの中の iframe（外部の動画プレーヤーなど）の、表示後の HTML */
  frames: { url: string; html: string }[];
  /** ページ本体の HTTP ステータス（403 などなら、ブラウザでも断られている） */
  status: number;
  /** 表示中にサイトから渡された Cookie（年齢確認の結果など）。以降の普通の読み込みでも使う */
  cookies: { name: string; value: string; domain: string }[];
}

export interface RenderOptions {
  /** 動画を探すときは、再生ボタンを押して動画の読み込みを始めさせる */
  play?: boolean;
}

const MAX_FRAMES = 5;
const MAX_FRAME_HTML = 1.5 * 1024 * 1024;

/**
 * ページ（と iframe の中）で、動画を再生させる。
 * - <video> は音を消して play()
 * - よくある動画プレーヤーの再生ボタンを、最大 3 個まで押す
 * 別のページへ移動するリンクは押さない（移動自体も止めてある）
 * ビルド時の変換の影響を受けないよう、ブラウザに渡すコードは文字列で持つ
 */
const PRESS_PLAY = `(() => {
  for (const v of Array.from(document.querySelectorAll("video"))) {
    v.muted = true;
    const p = v.play();
    if (p && p.catch) p.catch(() => {});
  }
  const selectors = [
    ".vjs-big-play-button", ".jw-display-icon-container", ".jw-icon-display", ".plyr__control--overlaid",
    ".fp-play", ".mejs__overlay-button", ".dplayer-mobile-play", ".art-control-play",
    "[class*='play-button']", "[class*='playbutton']", "[class*='btn-play']", "[class*='play-btn']",
    "button[aria-label*='play' i]", "button[aria-label*='再生']", "button[title*='play' i]", "[class*='play']",
  ];
  let clicked = 0;
  // 名前に手がかりのない独自プレーヤー：「▶」「再生」「Play」と書かれたボタンや、
  // プレーヤーらしい部品（id・class に player / video）の中のボタンも押す
  const labelled = Array.from(document.querySelectorAll("button, [role=button], a[href^='#'], a[href^='javascript'], div[onclick], span[onclick]"))
    .filter((el) => /^\s*(▶|►|⏵|▷|再生|再生する|play|play video|watch)\s*$/i.test((el.innerText || el.getAttribute("aria-label") || el.title || "").trim()));
  const inPlayer = Array.from(document.querySelectorAll("[id*='player' i] button, [class*='player' i] button, [id*='video' i] button, [class*='video' i] button"));
  for (const el of [...labelled, ...inPlayer]) {
    if (clicked >= 3) break;
    const r = el.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) continue;
    el.click();
    clicked++;
  }
  for (const sel of selectors) {
    let els = [];
    try { els = Array.from(document.querySelectorAll(sel)); } catch (e) { continue; }
    for (const el of els) {
      if (clicked >= 3) return clicked;
      const r = el.getBoundingClientRect();
      if (r.width < 10 || r.height < 10) continue;
      const a = el.closest("a[href]");
      if (a && !/^(#|javascript:)/i.test(a.getAttribute("href") || "")) continue;
      el.click();
      clicked++;
    }
  }
  return clicked;
})()`;

/**
 * 年齢確認などの入口ページで「はい・ENTER・18歳以上」のボタンを押す。
 * 年齢確認らしい文言があるページでだけ、短いラベルのボタン・リンクを 1 つ押す
 */
const PASS_GATE = `(() => {
  const text = ((document.body && document.body.innerText) || "").slice(0, 20000);
  if (!/年齢確認|年齢認証|18歳|18才|age.?verif|over 18|18 years|adults? only|18\\+|成人向け/i.test(text)) return false;
  const yes = /^(はい|yes|enter|入場|入口|入る|同意|18歳以上|18才以上|i am 18|i'm 18|i am over 18|i am at least 18|agree|i agree|accept|continue|ok$|進む)/i;
  const no = /いいえ|未満|exit|leave|退場|退出|出る|^no/i;
  const els = Array.from(document.querySelectorAll("a, button, input[type=button], input[type=submit], [role=button], [onclick]"));
  for (const el of els) {
    const img = el.querySelector ? el.querySelector("img[alt]") : null;
    const label = (el.innerText || el.value || el.getAttribute("aria-label") || (img && img.alt) || "").trim();
    if (!label || label.length > 30 || !yes.test(label) || no.test(label)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    el.click();
    return true;
  }
  return false;
})()`;

/** 動画そのものではなく、配信用に細かく切った断片（一覧に出すと大量のゴミになる） */
const isSegment = (url: string, type: string | undefined) =>
  ["ts", "m4s", "aac", "vtt", "key", "m4a"].includes(extensionOf(url)) || /mp2t|iso\.segment/i.test(type ?? "");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** タブの空き待ちの間に区切りの時刻を過ぎたときに投げる（ページは次の回に回す） */
export class RenderDeferred extends Error {}

export async function renderPage(
  url: string,
  signal: AbortSignal,
  startBy: number,
  options: RenderOptions = {},
  timeoutMs = 25000,
): Promise<Rendered> {
  await assertPublicUrl(url);
  await acquireTab();
  if (Date.now() > startBy) {
    releaseTab();
    throw new RenderDeferred("時間が足りないため次の回に回します");
  }
  const browser = await getBrowser().catch((err) => {
    releaseTab();
    throw err;
  });
  // サーバー用 Chromium は省メモリの単一プロセスで動くため、ページごとの別部屋（BrowserContext）は作れない。
  // 普通のタブで開き、閉じる前に Cookie を消す
  const page = await browser.newPage().catch((err) => {
    releaseTab();
    throw err;
  });
  const onAbort = () => void page.close().catch(() => {});
  signal.addEventListener("abort", onAbort);
  try {
    await page.setUserAgent({ userAgent: USER_AGENT });
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.setExtraHTTPHeaders({ "accept-language": "ja,en;q=0.8" });

    const network = new Map<string, NetworkMedia>();
    let status = 200;
    const hostOk = new Map<string, Promise<boolean>>();
    const isAllowed = (raw: string) => {
      let host: string;
      try {
        const u = new URL(raw);
        if (u.protocol === "data:" || u.protocol === "blob:") return Promise.resolve(true);
        if (u.protocol !== "http:" && u.protocol !== "https:") return Promise.resolve(false);
        host = `${u.protocol}//${u.host}`;
      } catch {
        return Promise.resolve(false);
      }
      let ok = hostOk.get(host);
      if (!ok) {
        ok = assertPublicUrl(raw).then(
          () => true,
          () => false,
        );
        hostOk.set(host, ok);
      }
      return ok;
    };

    /** 最初の表示が終わったら true。その後のページ移動（再生ボタンのつもりがリンクだった等）は止める */
    let loaded = false;
    const frameUrlOf = (req: HTTPRequest) => {
      const f = req.frame();
      const u = f?.url();
      return u && /^https?:/.test(u) ? u : undefined;
    };
    // 広告などで新しいウィンドウが開いたらすぐ閉じる
    page.on("popup", (p) => void p?.close().catch(() => {}));

    await page.setRequestInterception(true);
    page.on("request", (req: HTTPRequest) => {
      void (async () => {
        const reqUrl = req.url();
        if (!(await isAllowed(reqUrl))) return req.abort("blockedbyclient").catch(() => {});
        if (loaded && req.isNavigationRequest() && req.frame() === page.mainFrame()) {
          return req.abort("aborted").catch(() => {});
        }
        const type = req.resourceType();
        // 動画本体やフォントは読まない（URL だけ記録する）。通信量と時間の節約
        if (type === "media") {
          if (!reqUrl.startsWith("blob:") && !isSegment(reqUrl, undefined)) {
            network.set(reqUrl, { url: reqUrl, kind: kindFromUrl(reqUrl) === "image" ? "image" : "video", referer: frameUrlOf(req) });
          }
          return req.abort("aborted").catch(() => {});
        }
        if (type === "font") return req.abort("aborted").catch(() => {});
        return req.continue().catch(() => {});
      })();
    });
    page.on("response", (res) => {
      const resUrl = res.url();
      if (!/^https?:/.test(resUrl)) return;
      const headers = res.headers();
      const req = res.request();
      if (req.isNavigationRequest() && req.frame() === page.mainFrame() && res.status() >= 200 && (res.status() < 300 || res.status() >= 400)) {
        status = res.status();
      }
      if (res.status() >= 400) return;
      const type = headers["content-type"];
      if (isSegment(resUrl, type)) return;
      // 種類の名乗りが違っていても、プレーヤーが読み込んだ .m3u8 / .mp4 は動画として記録する
      const fetched = req.resourceType() === "xhr" || req.resourceType() === "fetch";
      const kind = kindFromContentType(type ?? null) ?? (fetched && kindFromUrl(resUrl) === "video" ? "video" : null);
      if (!kind) return;
      // アイコンなどの小さな画像（1.5KB 未満）は除く
      const size = Number(headers["content-length"]);
      if (kind === "image" && Number.isFinite(size) && size > 0 && size < 1500) return;
      network.set(resUrl, { url: resUrl, kind, referer: frameUrlOf(res.request()) });
    });

    await page.goto(url, { waitUntil: "networkidle2", timeout: timeoutMs }).catch(async (err) => {
      // 時間切れでも、そこまでに描けた分は使う
      if (!(err instanceof Error && err.name === "TimeoutError")) throw err;
    });
    // 年齢確認などの入口ページなら「はい」を押して先へ進む
    if (!signal.aborted && (await page.evaluate(PASS_GATE).catch(() => false))) {
      await sleep(500);
      await page.waitForNetworkIdle({ idleTime: 600, timeout: 8000 }).catch(() => {});
    }
    // 下までスクロールして、遅延読み込みの画像を出させる
    for (let i = 0; i < 8 && !signal.aborted; i++) {
      const atBottom = await page.evaluate(() => {
        window.scrollBy(0, window.innerHeight * 1.5);
        return window.innerHeight + window.scrollY >= document.body.scrollHeight - 10;
      });
      await sleep(350);
      if (atBottom) break;
    }
    await page.waitForNetworkIdle({ idleTime: 600, timeout: 5000 }).catch(() => {});
    loaded = true;

    // 再生ボタンを押して、動画の読み込みを始めさせる（読み込まれた動画の URL は通信の記録に残る）
    if (options.play && !signal.aborted) {
      let pressed = 0;
      for (const frame of page.frames()) {
        pressed += Number(await frame.evaluate(PRESS_PLAY).catch(() => 0)) || 0;
      }
      if (pressed > 0 || network.size === 0) {
        await page.waitForNetworkIdle({ idleTime: 800, timeout: 6000 }).catch(() => {});
      }
    }

    const html = await page.content();
    const frames: { url: string; html: string }[] = [];
    for (const f of page.frames()) {
      if (f === page.mainFrame() || frames.length >= MAX_FRAMES) continue;
      const frameUrl = f.url();
      if (!/^https?:/.test(frameUrl)) continue;
      const frameHtml = await f.content().catch(() => "");
      if (frameHtml) frames.push({ url: frameUrl, html: frameHtml.slice(0, MAX_FRAME_HTML) });
    }
    const cookies = await browser
      .cookies()
      .then((list) => list.slice(0, 100).map((c) => ({ name: c.name, value: c.value, domain: c.domain.replace(/^\./, "") })))
      .catch(() => []);
    return { html, finalUrl: page.url(), network: [...network.values()], frames, status, cookies };
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      const cdp = await page.createCDPSession();
      await cdp.send("Network.clearBrowserCookies");
    } catch {
      /* ignore */
    }
    await page.close().catch(() => {});
    releaseTab();
  }
}

/**
 * 本物のブラウザで画像・動画の URL を開き、見られるか確かめる。
 * こちらのサーバーからの読み込みは断る（403 など）が、ブラウザなら通すサイトのため。
 * 返事が届いたらすぐ閉じる（動画全体は読まない）
 */
export async function checkInBrowser(url: string, referer: string | undefined, signal: AbortSignal): Promise<boolean> {
  await assertPublicUrl(url);
  await acquireTab();
  let page: import("puppeteer-core").Page | null = null;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    const onAbort = () => void page?.close().catch(() => {});
    signal.addEventListener("abort", onAbort, { once: true });
    await page.setUserAgent({ userAgent: USER_AGENT });
    await page.setExtraHTTPHeaders({ "accept-language": "ja,en;q=0.8" });
    // 先に動画のあったページを開く（ページを開いたときに渡される Cookie がないと、動画を断るサイトがあるため）
    if (referer) {
      await assertPublicUrl(referer);
      await page.goto(referer, { waitUntil: "domcontentloaded", timeout: 12000 }).catch(() => null);
    }
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 12000, referer }).catch(() => null);
    signal.removeEventListener("abort", onAbort);
    if (!res) return false;
    const status = res.status();
    const type = res.headers()["content-type"] ?? "";
    return (status === 200 || status === 206) && !/html|json|text\//i.test(type);
  } catch {
    return false;
  } finally {
    await page?.close().catch(() => {});
    releaseTab();
  }
}
