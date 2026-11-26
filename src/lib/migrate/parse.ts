
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

/**
 * 件名の中の数字の並び（4 桁以上）を伏せる。認証コード・注文番号・会員番号などを、データベースに残さないため。
 * 分類は伏せる前の件名で済ませてから、保存する直前にこれを通す
 */
export function maskDigits(subject: string): string {
  return subject.replace(/[0-9０-９]{4,}/g, (m) => "＊".repeat(Math.min(m.length, 8)));
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

/** IMAP で受け取った生のヘッダから、分類に使う材料を取り出す */
export function readRawHeaders(raw: string): { from: string; subject: string; to: string; listUnsubscribe: boolean; precedence: string } {
  // 折り返された行（次の行が空白で始まる）を 1 行に戻す
  const text = raw.replace(/\r?\n[ \t]+/g, " ");
  const get = (name: string) => new RegExp(`^${name}:[ \\t]*(.*)$`, "im").exec(text)?.[1]?.trim() ?? "";
  return { from: get("from"), subject: decodeHeader(get("subject")).trim().slice(0, 120), to: get("delivered-to") || get("to"), listUnsubscribe: !!get("list-unsubscribe"), precedence: get("precedence").slice(0, 20) };
}

/**
 * Gmail の検索に渡す絞り込み。全部のメールを読むと遅く、上限も使うので、2 段に分けて必要な分だけ読む。
 *
 * 1 段目（ACCOUNT）：登録・ログイン・本人確認・支払いにかかわりそうな件名のメール。
 *   Gmail が「プロモーション」「ソーシャル」に分けたものは外す（件名に「会員」「登録」と入った広告を読まないため）
 * 2 段目（PROMO）：「プロモーション」に入ったメールの見本。新しい方から決まった数だけ読み、広告をたくさん送ってくる差出人を見つける
 */
const SUBJECT_WORDS =
  "subject:登録 subject:確認 subject:認証 subject:コード subject:ようこそ subject:パスワード subject:アカウント subject:ログイン subject:サインイン subject:セキュリティ subject:ワンタイム " +
  "subject:領収 subject:注文 subject:請求 subject:購入 subject:予約 subject:支払 subject:発送 " +
  "subject:welcome subject:verify subject:verification subject:confirm subject:password subject:passcode subject:code subject:account subject:activate subject:security " +
  'subject:receipt subject:order subject:invoice subject:payment subject:subscription subject:"sign in" subject:"log in" subject:login subject:"sign up"';
export const GMAIL_QUERY_ACCOUNT = `-in:chats -category:promotions -category:social {${SUBJECT_WORDS}}`;
export const GMAIL_QUERY_PROMO = "-in:chats category:promotions";
/** 2 段目で読む数の上限（1 回の調べで）。広告の多い差出人を見つけるには、新しい方から数百通で足りる */
export const PROMO_SAMPLE = 300;
/** 2 段目を初めて読むとき、どこまでさかのぼるか */
export const PROMO_SAMPLE_WINDOW = "newer_than:1y";
