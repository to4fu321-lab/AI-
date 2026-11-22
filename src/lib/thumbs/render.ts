import "server-only";
import type { Browser, Frame, HTTPRequest, HTTPResponse, Page } from "puppeteer-core";
import { isAdUrl } from "./adblock";
import { extensionOf, kindFromContentType, kindFromUrl } from "./extract";
import { assertPublicUrl } from "./safeFetch";
import { findTweetIds } from "./twitter";

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
 *
 * 動画を探すときは、人が見るときと同じ手順を踏む：
 *   1. 広告・計測の通信は最初から止める（広告動画を飛ばして本編が読み込まれる。新しいウィンドウの広告も開かせない）
 *   2. 年齢確認・「広告をスキップ」「動画へ進む」などの入口・中間ページを、待ち時間（カウントダウン）を待って先へ進む
 *   3. 画面を覆う広告の板を取り除き、再生ボタン・サムネイル・プレーヤーの真ん中を「本物の指のタップ」で押す
 *      （1 回目のタップは広告に取られることが多いので、動画が読み込まれるまで最大 3 回押し直す）
 *   4. その間にブラウザが受け取った動画の URL を集める（本体は読まない）
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
  /** URL からは形式がわからないもの（拡張子のない HLS の目次など）の形式 */
  format?: string;
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
  /**
   * 表示中にページが読み込んだデータ（JSON・HTML の断片）の中にあった X の投稿の番号。
   * 「もっと見る」・下までスクロールで一覧を足すサイトは、投稿のリンクがここにしかない
   */
  tweets: string[];
  /** captureJson に合った返事の中身 */
  json: { url: string; data: unknown }[];
  /** 表示中にサイトから渡された Cookie（年齢確認の結果など）。以降の普通の読み込みでも使う */
  cookies: { name: string; value: string; domain: string }[];
}

export interface RenderOptions {
  /** 動画を探すときは、再生ボタンを押して動画の読み込みを始めさせる */
  play?: boolean;
  /**
   * この形の URL の返事（JSON）を中身ごと取っておく。
   * ページ自身のスクリプトが受け取ったデータ（Gofile のファイル一覧など）を、そのまま使うため
   */
  captureJson?: RegExp;
}

const MAX_FRAMES = 5;
const MAX_FRAME_HTML = 1.5 * 1024 * 1024;

/**
 * 新しいページを開く前に仕込む。広告が新しいウィンドウ（ポップアップ・ポップアンダー）を開こうとしても、
 * 何も開かずに「開いたふり」だけ返す（開いたウィンドウを確かめる広告スクリプトが止まらないように）
 */
const BEFORE_LOAD = `(() => {
  try {
    const fake = { closed: false, close() { this.closed = true; }, focus() {}, blur() {}, postMessage() {}, location: { href: "" }, document: { write() {}, close() {} } };
    Object.defineProperty(window, "open", { value: () => fake, configurable: true });
  } catch (e) {}
})()`;

/** <video> を音を消して再生させる（読み込みを始めさせる） */
const PLAY_VIDEOS = `(() => {
  for (const v of Array.from(document.querySelectorAll("video"))) {
    try {
      v.muted = true;
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
    } catch (e) {}
  }
})()`;

/**
 * 画面を覆っている広告の板（全面を覆う固定表示の要素）を取り除く。
 * プレーヤー自体（動画・iframe を中に持つもの、名前に player / video を含むもの）は残す
 */
const REMOVE_OVERLAYS = `(() => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const playerish = /player|video|vjs|jwplayer|jw-|plyr|dplayer|artplayer|flowplayer|fp-|mejs|clappr|fluid_/i;
  let removed = 0;
  for (const el of Array.from(document.querySelectorAll("body *"))) {
    if (removed >= 20) break;
    const cs = getComputedStyle(el);
    if (cs.position !== "fixed" && !(cs.position === "absolute" && Number(cs.zIndex) >= 1000)) continue;
    const r = el.getBoundingClientRect();
    if (r.width * r.height < vw * vh * 0.4) continue;
    if (el.querySelector("video, audio, canvas") || playerish.test((el.id || "") + " " + (typeof el.className === "string" ? el.className : ""))) continue;
    const frames = Array.from(el.querySelectorAll("iframe"));
    if (frames.some((f) => f.getBoundingClientRect().width > 300 && !/ad|banner|pop/i.test(f.src + f.id + f.className))) continue;
    const z = Number(cs.zIndex) || 0;
    const text = (el.innerText || "").trim();
    const adLike = z >= 100 || Number(cs.opacity) < 0.1 || el.querySelector("a[target=_blank]") || text.length < 400;
    if (!adLike) continue;
    el.remove();
    removed++;
  }
  // 広告を出している間、画面のスクロールを止めているサイトがあるので戻す
  if (removed) {
    document.documentElement.style.overflow = "auto";
    if (document.body) document.body.style.overflow = "auto";
  }
  return removed;
})()`;

/**
 * 押す候補（広告のスキップ・再生ボタン・サムネイル・プレーヤーの真ん中）に印（data-thumbs-play="番号"）を付け、数を返す。
 * 押すのはブラウザの外から「本物のタップ」で行う（スクリプトの click() は無視するプレーヤーや、
 * 人が押したかを確かめる広告・プレーヤーがあるため）
 */
const MARK_PLAY = `(() => {
  for (const el of Array.from(document.querySelectorAll("[data-thumbs-play]"))) el.removeAttribute("data-thumbs-play");
  const picked = [];
  const seen = new Set();
  const visible = (el, min) => {
    const r = el.getBoundingClientRect();
    if (r.width < min || r.height < min) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.05;
  };
  const navigates = (el) => {
    const a = el.closest && el.closest("a[href]");
    return a && !/^(#|javascript:)/i.test(a.getAttribute("href") || "");
  };
  const pick = (el) => {
    if (picked.length >= 4 || seen.has(el)) return;
    seen.add(el);
    picked.push(el);
  };
  const label = (el) => (el.innerText || el.getAttribute("aria-label") || el.title || el.value || "").trim();
  const clickable = "button, [role=button], a, div, span, input[type=button], input[type=submit]";
  // 1. 広告の「スキップ」「閉じる」
  for (const el of Array.from(document.querySelectorAll(clickable))) {
    const t = label(el);
    if (t.length <= 20 && /^(skip( ad| ads)?\\s*[›»>]*|広告をスキップ|スキップ\\s*[›»>]*|close ad|広告を閉じる)$/i.test(t) && visible(el, 8)) pick(el);
  }
  // 2. よくある動画プレーヤーの大きな再生ボタン
  const selectors = [
    ".vjs-big-play-button", ".jw-display-icon-container", ".jw-icon-display", ".plyr__control--overlaid",
    ".fp-play", ".fp-ui", ".mejs__overlay-button", ".dplayer-mobile-play", ".art-control-play", ".fluid_initial_play",
    ".ytp-large-play-button", ".play-wrapper", "[class*='big-play']", "[class*='play-button']", "[class*='playbutton']",
    "[class*='btn-play']", "[class*='play-btn']", "[class*='play_btn']", "[class*='playBtn']", "[id*='play-button']",
    "button[aria-label*='play' i]", "button[aria-label*='再生']", "button[title*='play' i]", "[class*='play-icon']",
  ];
  for (const sel of selectors) {
    let els = [];
    try { els = Array.from(document.querySelectorAll(sel)); } catch (e) { continue; }
    for (const el of els) if (visible(el, 10) && !navigates(el)) pick(el);
  }
  // 3. 「▶」「再生」「Play」と書かれたボタン
  for (const el of Array.from(document.querySelectorAll(clickable))) {
    if (/^\\s*(▶|►|⏵|▷|再生|再生する|動画を再生|play|play video|play now|watch|watch now)\\s*$/i.test(label(el)) && visible(el, 10) && !navigates(el)) pick(el);
  }
  // 4. 押すと動画に変わるサムネイル（ポスター画像）、プレーヤーの部品、大きな動画・iframe の真ん中
  const big = Array.from(document.querySelectorAll(
    "video, iframe, [class*='poster' i], [class*='thumb' i], [class*='preview' i], [class*='cover' i], [id*='player' i], [class*='player' i], [class*='video' i]"
  )).filter((el) => visible(el, 120) && !navigates(el) && !(el.tagName === "IFRAME" && /ad|banner|pop/i.test(el.src + el.id + el.className)));
  big.sort((a, b) => {
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    const score = (el, r) => r.width * r.height * (el.tagName === "VIDEO" || el.tagName === "IFRAME" ? 2 : 1);
    return score(b, rb) - score(a, ra);
  });
  for (const el of big.slice(0, 2)) pick(el);
  picked.forEach((el, i) => el.setAttribute("data-thumbs-play", String(i)));
  return picked.length;
})()`;

/**
 * 「広告をスキップ」「動画へ進む」「続ける」などの中間ページを先へ進む。
 * 押せるボタンがあれば印を付けて "click"、カウントダウン中なら "wait"、中間ページでなければ "none"
 */
const FIND_CONTINUE = `(() => {
  for (const el of Array.from(document.querySelectorAll("[data-thumbs-next]"))) el.removeAttribute("data-thumbs-next");
  const text = ((document.body && document.body.innerText) || "").slice(0, 20000);
  if (document.querySelector("video")) return "none";
  const interstitial = /skip ad|広告をスキップ|スキップして|秒後|秒お待ち|\\d+\\s*seconds?|please wait|お待ちください|リダイレクト|redirecting|continue to|get link|移動します|advertisement/i.test(text);
  if (!interstitial) return "none";
  const yes = /^(skip( ad)?|広告をスキップ|スキップ|continue|continue to (video|site|link|watch)|続ける|動画を見る|動画へ|動画ページへ|動画へ進む|再生ページへ|視聴する|今すぐ視聴|click here to (continue|watch|proceed)|get link|go to link|proceed( to video)?|次へ進む|watch video)\\s*[›»>→]*$/i;
  for (const el of Array.from(document.querySelectorAll("a, button, [role=button], input[type=button], input[type=submit], div[onclick], span[onclick]"))) {
    const t = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim();
    if (!t || t.length > 30 || !yes.test(t)) continue;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width < 8 || r.height < 8 || cs.visibility === "hidden" || cs.display === "none" || el.disabled || cs.pointerEvents === "none") continue;
    el.setAttribute("data-thumbs-next", "1");
    return "click";
  }
  return /\\d{1,2}\\s*(秒|seconds?|sec)|please wait|お待ちください/i.test(text) ? "wait" : "none";
})()`;

/** 本物のタップ（駄目ならマウスのクリック、それも駄目ならスクリプトのクリック）で押す */
async function tapElement(frame: Frame, selector: string): Promise<boolean> {
  const handle = await frame.$(selector).catch(() => null);
  if (!handle) return false;
  try {
    const within = <T,>(p: Promise<T>) => Promise.race([p, sleep(2500).then(() => Promise.reject(new Error("timeout")))]);
    try {
      await within(handle.tap());
    } catch {
      try {
        await within(handle.click({ delay: 40 }));
      } catch {
        await handle.evaluate((el) => (el as HTMLElement).click()).catch(() => {});
      }
    }
    return true;
  } finally {
    await handle.dispose().catch(() => {});
  }
}

/** ページと iframe の中で、再生ボタンなどを押す。押した数を返す */
async function pressPlay(page: Page): Promise<number> {
  let pressed = 0;
  for (const frame of page.frames()) {
    if (frame.detached || pressed >= 6) continue;
    const n = Number(await frame.evaluate(MARK_PLAY).catch(() => 0)) || 0;
    for (let i = 0; i < n && pressed < 6; i++) {
      if (await tapElement(frame, `[data-thumbs-play="${i}"]`)) {
        pressed++;
        await sleep(300);
      }
    }
  }
  for (const frame of page.frames()) if (!frame.detached) await frame.evaluate(PLAY_VIDEOS).catch(() => {});
  return pressed;
}

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

/** ダウンロードさせる返事（Content-Disposition: attachment）の、ファイル名が動画か */
const attachmentIsVideo = (disposition: string | undefined) =>
  !!disposition && /attachment|filename/i.test(disposition) && kindFromUrl(`https://x/${/filename\*?=(?:UTF-8'')?["']?([^"';]+)/i.exec(disposition)?.[1] ?? ""}`) === "video";

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
    /** 中間ページの「次へ」を押している間だけ、ページの移動を許す */
    let allowNav = false;
    const startedAt = Date.now();
    /** 再生ボタンを押し直すのは、この時刻まで（1 回の実行時間の上限を越えないように） */
    const playUntil = startedAt + timeoutMs + 20000;
    const frameUrlOf = (req: HTTPRequest) => {
      const f = req.frame();
      const u = f?.url();
      return u && /^https?:/.test(u) ? u : undefined;
    };
    const record = (m: NetworkMedia) => {
      if (isAdUrl(m.url) || (m.referer && isAdUrl(m.referer))) return;
      network.set(m.url, m);
    };
    // 広告などで新しいウィンドウ・タブが開いたらすぐ閉じる
    page.on("popup", (p) => void p?.close().catch(() => {}));
    await page.evaluateOnNewDocument(BEFORE_LOAD).catch(() => {});

    await page.setRequestInterception(true);
    page.on("request", (req: HTTPRequest) => {
      void (async () => {
        const reqUrl = req.url();
        if (!(await isAllowed(reqUrl))) return req.abort("blockedbyclient").catch(() => {});
        // 広告・計測の通信は止める（プレーヤーは広告を飛ばして本編へ進む）
        if (isAdUrl(reqUrl) && reqUrl !== url) return req.abort("blockedbyclient").catch(() => {});
        const type = req.resourceType();
        if (req.isNavigationRequest()) {
          // ダウンロードボタンなどで動画ファイルそのものへ移動しようとしたら、URL だけ記録して読まない
          if (kindFromUrl(reqUrl) === "video" && reqUrl !== url) {
            record({ url: reqUrl, kind: "video", referer: frameUrlOf(req) ?? page.url() });
            return req.abort("aborted").catch(() => {});
          }
          if (loaded && !allowNav && req.frame() === page.mainFrame()) return req.abort("aborted").catch(() => {});
        }
        // 動画本体やフォントは読まない（URL だけ記録する）。通信量と時間の節約
        if (type === "media") {
          if (!reqUrl.startsWith("blob:") && !isSegment(reqUrl, undefined)) {
            record({ url: reqUrl, kind: kindFromUrl(reqUrl) === "image" ? "image" : "video", referer: frameUrlOf(req) });
          }
          return req.abort("aborted").catch(() => {});
        }
        if (type === "font") return req.abort("aborted").catch(() => {});
        return req.continue().catch(() => {});
      })();
    });
    /** 中身を確かめている途中の返事（拡張子のない配信の目次など）。結果を返す前に待つ */
    const peeks = new Set<Promise<void>>();
    const tweets = new Set<string>();
    const captured: { url: string; data: unknown }[] = [];
    /** ページが読み込んだデータ（JSON・HTML の断片）の中の、動画の URL と X の投稿の番号を拾う */
    const scan = (res: HTTPResponse, referer: string | undefined) => {
      const job = (async () => {
        const body = await Promise.race([res.text(), sleep(3000).then(() => null)]).catch(() => null);
        if (!body) return;
        // 中身が配信の目次（拡張子のない HLS・DASH）なら、それ自体が動画
        const head = body.slice(0, 512).replace(/^\uFEFF/, "").trimStart();
        if (head.startsWith("#EXTM3U")) return record({ url: res.url(), kind: "video", format: "M3U8", referer });
        if (/<MPD[\s>]/.test(head)) return record({ url: res.url(), kind: "video", format: "MPD", referer });
        const text = body.slice(0, 2 * 1024 * 1024).replace(/\\\//g, "/");
        for (const id of findTweetIds(text, 200)) if (tweets.size < 300) tweets.add(id);
        let n = 0;
        for (const m of text.matchAll(/https?:\/\/[^\s"'<>\\()]+?\.(?:mp4|m3u8|webm|mov)(?:\?[^\s"'<>\\()]*)?(?=["'\s<>\\),]|$)/gi)) {
          if (n++ > 100) break;
          if (!isSegment(m[0], undefined)) record({ url: m[0], kind: "video", referer });
        }
      })();
      peeks.add(job);
      void job.finally(() => peeks.delete(job));
    };
    const peek = (res: HTTPResponse, resUrl: string, referer: string | undefined) => {
      const job = (async () => {
        const body = await Promise.race([res.buffer(), sleep(3000).then(() => null)]).catch(() => null);
        if (!body) return;
        const head = body.subarray(0, 64).toString("latin1").replace(/^﻿/, "").trimStart();
        if (head.startsWith("#EXTM3U")) record({ url: resUrl, kind: "video", format: "M3U8", referer });
        else if (/<MPD[\s>]/.test(body.subarray(0, 512).toString("latin1"))) record({ url: resUrl, kind: "video", format: "MPD", referer });
      })();
      peeks.add(job);
      void job.finally(() => peeks.delete(job));
    };
    page.on("response", (res) => {
      const resUrl = res.url();
      if (!/^https?:/.test(resUrl)) return;
      const headers = res.headers();
      const req = res.request();
      if (req.isNavigationRequest() && req.frame() === page.mainFrame() && res.status() >= 200 && (res.status() < 300 || res.status() >= 400)) {
        status = res.status();
      }
      if (options.captureJson?.test(resUrl) && req.method() !== "OPTIONS" && captured.length < 20) {
        const job = Promise.race([res.json(), sleep(5000).then(() => undefined)])
          .then((data) => void (data !== undefined && captured.push({ url: resUrl, data })))
          .catch(() => {});
        peeks.add(job);
        void job.finally(() => peeks.delete(job));
      }
      if (res.status() >= 400) return;
      const type = headers["content-type"];
      if (isSegment(resUrl, type)) return;
      const referer = frameUrlOf(req);
      // 種類の名乗りが違っていても、プレーヤーが読み込んだ .m3u8 / .mp4 は動画として記録する
      const fetched = req.resourceType() === "xhr" || req.resourceType() === "fetch";
      // 「ダウンロード用」として返された動画ファイル（ファイル保存サービスのダウンロードボタンの先など）
      const attachment = attachmentIsVideo(headers["content-disposition"]);
      const kind = kindFromContentType(type ?? null) ?? ((fetched && kindFromUrl(resUrl) === "video") || attachment ? "video" : null);
      if (!kind) {
        // 拡張子も種類の名乗りもない、配信の目次（HLS・DASH）を、中身の先頭で見分ける
        const size = Number(headers["content-length"]);
        if (fetched && res.status() === 200 && !(size > 2 * 1024 * 1024) && peeks.size < 40) {
          if (/json|html|text\/plain/i.test(type ?? "")) scan(res, referer);
          else if (!/javascript|css|image|font|woff|svg|protobuf|grpc/i.test(type ?? "")) peek(res, resUrl, referer);
        }
        return;
      }
      // アイコンなどの小さな画像（1.5KB 未満）は除く
      const size = Number(headers["content-length"]);
      if (kind === "image" && Number.isFinite(size) && size > 0 && size < 1500) return;
      record({ url: resUrl, kind, referer });
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
    // 「広告をスキップ」「動画へ進む」などの中間ページ。カウントダウンが終わるのを待って押す（最大 2 回・12 秒）
    if (options.play) {
      const until = Date.now() + 12000;
      let clicks = 0;
      while (!signal.aborted && clicks < 2 && Date.now() < until) {
        const state = await page.evaluate(FIND_CONTINUE).catch(() => "none");
        if (state === "none") break;
        if (state === "wait") {
          await sleep(1500);
          continue;
        }
        allowNav = true;
        const tapped = await tapElement(page.mainFrame(), "[data-thumbs-next]");
        clicks++;
        await sleep(800);
        await page.waitForNetworkIdle({ idleTime: 600, timeout: 8000 }).catch(() => {});
        allowNav = false;
        if (!tapped) break;
      }
    }
    // 下までスクロールして、遅延読み込みの画像を出させる
    for (let i = 0; i < 8 && !signal.aborted; i++) {
      const atBottom = await page
        .evaluate(() => {
          window.scrollBy(0, window.innerHeight * 1.5);
          return window.innerHeight + window.scrollY >= document.body.scrollHeight - 10;
        })
        .catch(() => true);
      await sleep(350);
      if (atBottom) break;
    }
    await page.waitForNetworkIdle({ idleTime: 600, timeout: 5000 }).catch(() => {});
    loaded = true;

    // 再生ボタンを押して、動画の読み込みを始めさせる（読み込まれた動画の URL は通信の記録に残る）。
    // 1 回目のタップは広告の板に取られることが多いので、動画が読み込まれるまで最大 3 回押し直す
    if (options.play && !signal.aborted) {
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      const videoCount = () => [...network.values()].filter((n) => n.kind === "video").length;
      for (let round = 0; round < 3 && !signal.aborted && Date.now() < playUntil; round++) {
        const before = videoCount();
        for (const frame of page.frames()) if (!frame.detached) await frame.evaluate(REMOVE_OVERLAYS).catch(() => 0);
        const pressed = await pressPlay(page);
        await page.waitForNetworkIdle({ idleTime: 800, timeout: 6000 }).catch(() => {});
        if (videoCount() > before || pressed === 0) break;
      }
    }
    if (peeks.size) await Promise.race([Promise.all([...peeks]), sleep(3000)]);

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
    return { html, finalUrl: page.url(), network: [...network.values()], frames, status, cookies, tweets: [...tweets], json: captured };
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
