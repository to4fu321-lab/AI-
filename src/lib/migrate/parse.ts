import type { Signal } from "./types";

/**
 * メールのヘッダ（差出人・件名）から、サービスを見分けるための部品。
 * ここは通信もデータベースも使わない（そのまま試せる）。
 */

/** 件名が MIME 形式（=?UTF-8?B?...?=）のままだったときに読める形へ戻す */
export function decodeHeader(value: string): string {
  if (!value.includes("=?")) return value;
  return value
    .replace(/(\?=)\s+(=\?)/g, "$1$2")
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (whole, charset: string, enc: string, text: string) => {
      try {
        const bytes =
          enc.toLowerCase() === "b"
            ? Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
            : Uint8Array.from(
                text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))),
                (c) => c.charCodeAt(0),
              );
        return new TextDecoder(charset.split("*")[0].toLowerCase()).decode(bytes);
      } catch {
        return whole;
      }
    });
}

/** 「表示名 <a@example.com>」を分ける */
export function parseFrom(value: string): { name: string; address: string } | null {
  const v = decodeHeader(value).trim();
  const m = /<([^<>\s]+@[^<>\s]+)>\s*$/.exec(v);
  const address = (m ? m[1] : /[^\s<>"]+@[^\s<>"]+/.exec(v)?.[0] ?? "").toLowerCase();
  if (!address.includes("@")) return null;
  const name = (m ? v.slice(0, m.index) : "").trim().replace(/^"(.*)"$/, "$1").replace(/\\"/g, '"').trim();
  return { name: name.slice(0, 80), address };
}

/** 国別ドメインの手前に入る区分（example.co.jp の co など） */
const SECOND = new Set(["co", "ne", "or", "ac", "go", "ed", "gr", "ad", "lg", "com", "net", "org", "edu", "gov"]);

/** メールアドレスから、サービスの単位になるドメインを取り出す（mail.shop.example.co.jp → example.co.jp） */
export function serviceDomain(address: string): string | null {
  const host = address.slice(address.lastIndexOf("@") + 1).replace(/\.$/, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null;
  const parts = host.split(".");
  const tld = parts[parts.length - 1];
  const keep = tld.length === 2 && parts.length >= 3 && SECOND.has(parts[parts.length - 2]) ? 3 : 2;
  return parts.slice(-keep).join(".");
}

/** 個人どうしのやり取りに使うメール（サービスではないので数えない） */
const PERSONAL = new Set([
  "gmail.com", "googlemail.com", "yahoo.co.jp", "yahoo.com", "ymail.com", "icloud.com", "me.com", "mac.com",
  "outlook.com", "outlook.jp", "hotmail.com", "hotmail.co.jp", "live.jp", "live.com", "msn.com", "aol.com",
  "docomo.ne.jp", "ezweb.ne.jp", "au.com", "softbank.ne.jp", "i.softbank.jp", "nifty.com", "proton.me", "protonmail.com",
]);

export function isPersonalDomain(address: string): boolean {
  return PERSONAL.has(address.slice(address.lastIndexOf("@") + 1));
}

const SIGNALS: [Signal, RegExp][] = [
  ["password", /パスワード|暗証|password|passcode|reset your/i],
  ["security", /ログイン|サインイン|セキュリティ|不正|二段階|2段階|認証コード|確認コード|ワンタイム|sign[- ]?in|log[- ]?in|security|verification code|one[- ]time|new device/i],
  ["signup", /登録|ようこそ|会員|アカウント|メールアドレス.*(確認|認証)|本人確認|welcome|verify|confirm your|activate|account|registration|sign[- ]?up/i],
  ["billing", /領収|請求|注文|購入|決済|支払|お届け|発送|予約|receipt|invoice|order|payment|subscription|billing|shipped/i],
];

/** 件名から、どんな種類のお知らせかを見分ける（当てはまらなければ空） */
export function signalsOf(subject: string): Signal[] {
  return SIGNALS.filter(([, re]) => re.test(subject)).map(([s]) => s);
}

/** Gmail の検索に渡す絞り込み（アカウントに関係しそうなメールだけを読む） */
export const GMAIL_QUERY =
  "-in:chats {subject:登録 subject:確認 subject:認証 subject:ようこそ subject:パスワード subject:アカウント subject:会員 subject:ログイン subject:領収 subject:注文 subject:請求 subject:購入 subject:予約 " +
  "subject:welcome subject:verify subject:confirm subject:password subject:account subject:activate subject:security subject:receipt subject:order subject:invoice subject:payment subject:subscription " +
  'subject:"sign in" subject:"log in" subject:"sign up"}';
