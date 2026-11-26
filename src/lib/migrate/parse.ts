
import { getDomain } from "tldts";

/**
 * メールのヘッダ（差出人・件名）から、サービスを見分けるための部品。
 * ここは通信もデータベースも使わない（そのまま試せる）。
 */

/**
 * 外から届いた文字を、保存しても安全な形にする。
 * - 壊れた文字（絵文字の片割れなど）と制御文字（NUL など）を取り除く。そのままデータベースへ渡すと、1 通のせいで書き込みが止まり続ける
 * - 長さは「文字」の単位で切る（絵文字の途中で切らない）
 */
export function clean(text: string, max: number): string {
  const safe = text.toWellFormed().replace(/[\u0000-\u001f\u007f-\u009f\ufffd\ufeff\u200b-\u200f\u2028-\u202e]/g, " ").replace(/\s+/g, " ").trim();
  return Array.from(safe).slice(0, max).join("");
}

/** 文字コードの別名（TextDecoder が知らない呼び名を、知っている呼び名へ） */
const CHARSET_ALIAS: Record<string, string> = { cp932: "shift_jis", "windows-31j": "shift_jis", ms932: "shift_jis", "x-sjis": "shift_jis", cp1252: "windows-1252" };

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
        const name = charset.split("*")[0].toLowerCase();
        return new TextDecoder(CHARSET_ALIAS[name] ?? name).decode(bytes);
      } catch {
        return whole;
      }
    });
}

/** 「表示名 <a@example.com>」を分ける */
export function parseFrom(value: string): { name: string; address: string } | null {
  // アドレスは、符号化を戻す前の生の値から取り出す。表示名の中に、にせのアドレス（符号化して隠したものを含む）を
  // 書かれても、それを差出人として拾わないため。表示名の引用符の中も、アドレス探しからは外す
  const raw = value.trim();
  const bare = raw.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/=\?[^?]+\?[bBqQ]\?[^?]*\?=/g, "");
  // 差出人が複数書かれているときは、最初の 1 つ
  const bracket = /<([^<>\s]+@[^<>\s]+)>/.exec(bare);
  const address = (bracket ? bracket[1] : /[^\s<>",;]+@[^\s<>",;]+/.exec(bare)?.[0] ?? "").toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(address) || address.length > 254) return null;
  const at = raw.lastIndexOf("<" + (bracket ? bracket[1] : "\u0000"));
  const name = decodeHeader(bracket && at >= 0 ? raw.slice(0, at) : "").trim().replace(/^"(.*)"$/, "$1").replace(/\\"/g, '"');
  return { name: clean(name, 80), address };
}

/**
 * 保存する件名から、番号や合言葉になりうる部分を伏せる（認証コード・注文番号・会員番号・URL などを、データベースに残さないため）。
 * 分類は伏せる前の件名で済ませてから、保存する直前にこれを通す。
 * - URL は丸ごと伏せる
 * - 英字と数字が混ざった 5 文字以上の語（A1B2C3・X7K-9Q2 など）を伏せる
 * - 数字 3 桁以上の並び（間に空白・ハイフンが入るものも）を伏せる。ただし「2026年」のような年は残す
 */
export function maskSecrets(subject: string): string {
  return subject
    .normalize("NFKC")
    .replace(/https?:\/\/\S+/gi, "＊＊＊＊")
    .replace(/[a-z0-9]+(?:-[a-z0-9]+)*/gi, (m) => (/[a-z]/i.test(m) && /\d/.test(m) && m.replace(/-/g, "").length >= 5 ? "＊＊＊＊" : m))
    .replace(/\d{3,}(?:[ -]\d{2,})*/g, (m, offset: number, whole: string) => (/^\d{4}$/.test(m) && /^\s?年/.test(whole.slice(offset + m.length)) ? m : "＊＊＊＊"));
}

/** メールアドレスから、サービスの単位になるドメインを取り出す（mail.shop.example.co.jp → example.co.jp） */
export function serviceDomain(address: string): string | null {
  const host = address.slice(address.lastIndexOf("@") + 1).replace(/\.$/, "").toLowerCase();
  // 公開されている「ドメインの区切り」の一覧で決める（example.co.jp・city.sapporo.jp・user.github.io を、それぞれ別の持ち主として扱う）
  return getDomain(host, { allowPrivateDomains: true });
}

/** 個人どうしのやり取りに使うメール（サービスではないので数えない） */
const PERSONAL = new Set([
  "gmail.com", "googlemail.com", "yahoo.co.jp", "yahoo.com", "ymail.com", "icloud.com", "me.com", "mac.com",
  "outlook.com", "outlook.jp", "hotmail.com", "hotmail.co.jp", "live.jp", "live.com", "msn.com", "aol.com",
  "docomo.ne.jp", "ezweb.ne.jp", "au.com", "softbank.ne.jp", "i.softbank.jp", "nifty.com", "proton.me", "protonmail.com",
]);

/** メール会社や携帯会社が、自分のドメインから送ってくる案内（これは個人どうしのやり取りではない） */
const ROBOT = /^(no-?reply|do-?not-?reply|info|information|notice|notification|support|account|security|auto|mailer|admin|news|service|alert)s?\b/;

export function isPersonalDomain(address: string): boolean {
  const at = address.lastIndexOf("@");
  return PERSONAL.has(address.slice(at + 1)) && !ROBOT.test(address.slice(0, at));
}

/** IMAP で受け取った生のヘッダから、分類に使う材料を取り出す */
export function readRawHeaders(raw: string): { from: string; subject: string; to: string; listUnsubscribe: boolean; precedence: string } {
  // 折り返された行（次の行が空白で始まる）を 1 行に戻す
  const text = raw.replace(/\r?\n[ \t]+/g, " ");
  const get = (name: string) => new RegExp(`^${name}:[ \\t]*(.*)$`, "im").exec(text)?.[1]?.trim() ?? "";
  return { from: get("from"), subject: clean(decodeHeader(get("subject")), 120), to: get("delivered-to"), listUnsubscribe: !!get("list-unsubscribe"), precedence: get("precedence").slice(0, 20) };
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
  "subject:ロック subject:本人確認 subject:引き落とし subject:チャージ subject:発送 subject:locked subject:alert " +
  'subject:receipt subject:order subject:invoice subject:payment subject:subscription subject:"sign in" subject:"log in" subject:login subject:"sign up"';
export const GMAIL_QUERY_ACCOUNT = `-in:chats -category:promotions -category:social {${SUBJECT_WORDS}}`;
export const GMAIL_QUERY_PROMO = "-in:chats category:promotions";
/**
 * 1 段目と 2 段目のあいだに読む段（RECENT）：直近 1 年に届いた全部のメール（広告とソーシャルを除く）。
 * 件名に手がかりが無いサービスも拾い、「このアドレスに、最近なにが届いているか」を取りこぼさないため。
 * 迷惑メールとゴミ箱は、Gmail の検索がもともと外す（なりすましが多いので、台帳には入れない）
 */
export const GMAIL_QUERY_RECENT = "-in:chats -category:promotions -category:social";
export const RECENT_WINDOW = "newer_than:1y";
/** RECENT の段で、1 回の調べで読む数の上限 */
export const RECENT_MAX = 10_000;
/** 2 段目で読む数の上限（1 回の調べで）。広告の多い差出人を見つけるには、新しい方から数百通で足りる */
export const PROMO_SAMPLE = 300;
/** 2 段目を初めて読むとき、どこまでさかのぼるか */
export const PROMO_SAMPLE_WINDOW = "newer_than:1y";
