import "server-only";
import dns from "node:dns";
import https from "node:https";
import net from "node:net";

/**
 * 知らない相手が指定した URL を、安全に読みに行くための部品。
 *
 * OAuth の「クライアント ID メタデータ文書」では、つなぎに来た AI 秘書が「自分の説明はこの URL にある」と名乗る。
 * その URL をこちらのサーバーが読みに行くので、悪い相手に「サーバーの内側の住所」を読ませる踏み台にされないようにする：
 * - https だけ。ポートは 443 だけ。IP アドレスの直書きや localhost は受け付けない
 * - 名前を引いた結果が、内側の住所（自分自身・社内向け・クラウドの管理用など）なら、つながない。
 *   確かめた住所にそのままつなぐ（確かめたあとで行き先をすり替えられない）
 * - 転送（リダイレクト）は追わない。大きさと時間に上限を付ける
 */

const blocked = new net.BlockList();
for (const [prefix, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(prefix, bits, "ipv4");
for (const [prefix, bits] of [
  ["::", 127], // :: と ::1
  ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16],
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) blocked.addSubnet(prefix, bits, "ipv6");

/** 外の世界の住所か（内側・特別な用途の住所なら false） */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family !== 6) return false;
  // IPv4 を IPv6 の形で書いたもの（::ffff:10.0.0.1 など）は、中の IPv4 で確かめる
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address) ?? /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (mapped) {
    const v4 = mapped[2] === undefined ? mapped[1] : [parseInt(mapped[1], 16) >> 8, parseInt(mapped[1], 16) & 255, parseInt(mapped[2], 16) >> 8, parseInt(mapped[2], 16) & 255].join(".");
    return net.isIP(v4) === 4 && !blocked.check(v4, "ipv4");
  }
  return !blocked.check(address, "ipv6");
}

/** 読みに行ってよい URL の形か（https・ポート 443・名前のホスト・パスあり・ユーザー名やかけらなし） */
export function isFetchableUrl(value: string): boolean {
  if (value.length > 512) return false;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.href !== value) return false; // 書き方の揺れ（../ や大文字のホスト）を許さない
  if (u.protocol !== "https:" || u.port || u.username || u.password || u.hash) return false;
  if (u.pathname === "/" || /(?:^|\/)\.{1,2}(?:\/|$)/.test(u.pathname)) return false;
  const host = u.hostname;
  if (net.isIP(host.replace(/^\[|\]$/g, "")) || !host.includes(".") || host.endsWith(".") || /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/i.test(host)) return false;
  return true;
}

type LookupAll = (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void;
type LookupOne = (err: NodeJS.ErrnoException | null, address: string, family: number) => void;

/** 名前を引き、どれか 1 つでも内側の住所なら断る（外の住所だけを返す） */
export function guardedLookup(resolve: typeof dns.lookup = dns.lookup) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupAll | LookupOne) => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      const list = (addresses ?? []) as dns.LookupAddress[];
      if (err || !list.length) return (callback as LookupAll)(err ?? new Error("名前を引けません"), []);
      if (!list.every((a) => isPublicAddress(a.address))) return (callback as LookupAll)(Object.assign(new Error("内側の住所にはつなぎません"), { code: "EBLOCKED" }), []);
      if (options.all) return (callback as LookupAll)(null, list);
      return (callback as LookupOne)(null, list[0].address, list[0].family);
    });
  };
}

const MAX_BYTES = 32 * 1024;
const TIMEOUT_MS = 5000;

/** 外の https の URL から JSON を 1 つ読む（読めなければ null。理由は相手に教えない） */
export function fetchPublicJson(url: string): Promise<unknown | null> {
  if (!isFetchableUrl(url)) return Promise.resolve(null);
  return new Promise((done) => {
    let settled = false;
    const finish = (value: unknown | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(value);
    };
    const req = https.request(url, { method: "GET", headers: { accept: "application/json", "user-agent": "account-migrate-oauth" }, lookup: guardedLookup() as never, agent: false }, (res) => {
      const type = String(res.headers["content-type"] ?? "").toLowerCase();
      if (res.statusCode !== 200 || !/^application\/(?:[a-z0-9.+-]*\+)?json\b/.test(type)) {
        res.destroy();
        return finish(null);
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BYTES) {
          res.destroy();
          return finish(null);
        }
        chunks.push(c);
      });
      res.on("end", () => {
        try {
          finish(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          finish(null);
        }
      });
      res.on("error", () => finish(null));
    });
    const timer = setTimeout(() => {
      req.destroy();
      finish(null);
    }, TIMEOUT_MS);
    req.on("error", () => finish(null));
    req.end();
  });
}
