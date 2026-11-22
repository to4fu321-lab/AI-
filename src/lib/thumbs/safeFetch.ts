import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * 外部 URL を取りに行くための fetch。
 *
 * 「好きな URL をサーバーに取りに行かせる」機能は、そのままだとサーバー内部のネットワーク
 * （127.0.0.1 やクラウドのメタデータ 169.254.169.254 など）を覗く踏み台にされてしまう（SSRF）。
 * そこで、接続先がプライベートなアドレスでないことを確かめ、リダイレクトも 1 回ずつ検査する。
 */

export class FetchBlockedError extends Error {}

const USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

/** 開発中にローカルのテストサイトを読みたいときだけ THUMBS_ALLOW_PRIVATE=1 にする */
const allowPrivate = () => process.env.THUMBS_ALLOW_PRIVATE === "1";

function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // リンクローカル（クラウドのメタデータ）
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIP(ip: string): boolean {
  if (isIP(ip) === 4) return isPrivateIPv4(ip);
  const v6 = ip.toLowerCase();
  if (v6 === "::" || v6 === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return isPrivateIPv4(mapped[1]);
  // URL を通すと ::ffff:192.168.1.1 は ::ffff:c0a8:101 の形に正規化される
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isPrivateIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v6);
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchBlockedError("URL の形式が正しくありません");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FetchBlockedError("http または https の URL を入力してください");
  }
  if (url.username || url.password) throw new FetchBlockedError("ID・パスワード付きの URL は使えません");
  if (allowPrivate()) return url;

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new FetchBlockedError("内部ネットワークのアドレスには接続できません");
  }
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addresses.length === 0) throw new FetchBlockedError("サイトが見つかりませんでした（URL を確認してください）");
  if (addresses.some(isPrivateIP)) throw new FetchBlockedError("内部ネットワークのアドレスには接続できません");
  return url;
}

export interface SafeFetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  method?: "GET" | "HEAD";
  /** サイトから渡された Cookie を覚えておき、次の通信で返す（Cookie がないと先へ進めないサイト用） */
  jar?: CookieJar;
  /**
   * true なら、時間切れは「返事が届くまで」だけに使う。
   * 動画の中継のように、返事が届いたあと長い時間かけて中身を流すときに使う
   * （そうしないと、時間切れで中身が途中で切れる）
   */
  streamBody?: boolean;
}

/**
 * Cookie の入れ物（クロール 1 回分）。
 * 「最初のアクセスで Cookie を渡し、持っていなければ同じページへ送り返す」サイトや、
 * 年齢確認の結果を Cookie で覚えるサイトを読み進められるようにする。
 */
export class CookieJar {
  /** ドメイン → （名前 → 値） */
  private store = new Map<string, Map<string, string>>();

  constructor(saved?: [string, string][]) {
    for (const [domain, line] of saved ?? []) {
      const map = new Map<string, string>();
      for (const part of line.split("; ")) {
        const i = part.indexOf("=");
        if (i > 0) map.set(part.slice(0, i), part.slice(i + 1));
      }
      if (map.size) this.store.set(domain, map);
    }
  }

  /** 返事の Set-Cookie を覚える */
  remember(url: URL, res: Response) {
    const lines = res.headers.getSetCookie?.() ?? [];
    for (const line of lines.slice(0, 30)) {
      const [pair, ...attrs] = line.split(";");
      const i = pair.indexOf("=");
      if (i <= 0) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (!name || value.length > 2000) continue;
      // Domain 属性は、そのサイト自身の親ドメインのときだけ受け入れる
      let domain = url.hostname;
      for (const a of attrs) {
        const m = /^\s*domain\s*=\s*\.?([\w.-]+)\s*$/i.exec(a);
        const d = m?.[1].toLowerCase();
        // 「.co.jp」のような広すぎる指定は受け入れない（3 文字以下の区切りだけでできたドメインは除く）
        const tooBroad = !!d && d.split(".").every((label) => label.length <= 3);
        if (d && d.includes(".") && !tooBroad && (url.hostname === d || url.hostname.endsWith(`.${d}`))) domain = d;
      }
      let map = this.store.get(domain);
      if (!map) {
        if (this.store.size >= 50) continue;
        map = new Map();
        this.store.set(domain, map);
      }
      const expired = attrs.some((a) => /^\s*max-age\s*=\s*(0|-\d+)\s*$/i.test(a)) || value === "" || value === "deleted";
      if (expired) map.delete(name);
      else if (map.size < 40 || map.has(name)) map.set(name, value);
    }
  }

  /** ブラウザで開いたときに渡された Cookie を覚える */
  put(domain: string, name: string, value: string) {
    if (!domain || !name || value.length > 2000) return;
    let map = this.store.get(domain);
    if (!map) {
      if (this.store.size >= 50) return;
      map = new Map();
      this.store.set(domain, map);
    }
    if (map.size < 40 || map.has(name)) map.set(name, value);
  }

  /** その URL へ送る Cookie ヘッダー（なければ undefined） */
  headerFor(url: URL): string | undefined {
    const parts: string[] = [];
    for (const [domain, map] of this.store) {
      if (url.hostname !== domain && !url.hostname.endsWith(`.${domain}`)) continue;
      for (const [name, value] of map) parts.push(`${name}=${value}`);
    }
    return parts.length ? parts.join("; ") : undefined;
  }

  /** 続きの回へ渡せる形にする */
  toJSON(): [string, string][] {
    return [...this.store].map(([domain, map]) => [domain, [...map].map(([n, v]) => `${n}=${v}`).join("; ")] as [string, string]);
  }
}

/** リダイレクトを手動で辿り、毎回接続先を検査する fetch。最終的な URL も返す。 */
export async function safeFetch(raw: string, opts: SafeFetchOptions = {}): Promise<{ res: Response; url: string }> {
  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
    opts.timeoutMs ?? 15000,
  );
  (timer as { unref?: () => void }).unref?.();
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout.signal]) : timeout.signal;
  let current = raw;
  try {
    for (let hop = 0; hop <= 8; hop++) {
      const url = await assertPublicUrl(current);
      const cookie = opts.jar?.headerFor(url);
      const res = await fetch(url, {
        method: opts.method ?? "GET",
        redirect: "manual",
        signal,
        headers: {
          "user-agent": USER_AGENT,
          "accept-language": "ja,en;q=0.8",
          ...(cookie ? { cookie } : {}),
          ...opts.headers,
        },
      });
      opts.jar?.remember(url, res);
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        current = new URL(location, url).toString();
        continue;
      }
      if (opts.streamBody) clearTimeout(timer);
      return { res, url: url.toString() };
    }
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
  clearTimeout(timer);
  throw new FetchBlockedError("リダイレクトが多すぎます");
}
