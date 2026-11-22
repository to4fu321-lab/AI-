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
}

/** リダイレクトを手動で辿り、毎回接続先を検査する fetch。最終的な URL も返す。 */
export async function safeFetch(raw: string, opts: SafeFetchOptions = {}): Promise<{ res: Response; url: string }> {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 15000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  let current = raw;
  for (let hop = 0; hop <= 5; hop++) {
    const url = await assertPublicUrl(current);
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      redirect: "manual",
      signal,
      headers: {
        "user-agent": USER_AGENT,
        "accept-language": "ja,en;q=0.8",
        ...opts.headers,
      },
    });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      current = new URL(location, url).toString();
      continue;
    }
    return { res, url: url.toString() };
  }
  throw new FetchBlockedError("リダイレクトが多すぎます");
}
