/**
 * メール 1 通を、ヘッダだけ（件名・Gmail の分類ラベル・配信停止ヘッダなど）から分類する。
 * 通信もデータベースも使わない（画面・サーバー・あとで作る MCP のどこからでも同じ結果になる）。
 * 本文は見ない。
 *
 * 分類の決まりを変えたら RULES_VERSION を上げる（どの決まりで数えた結果かを、あとで見分けるため）。
 */
export const RULES_VERSION = 1;

/**
 * - auth     … 認証コード・ワンタイムパスワード（このアドレスが 2 段階認証の受け取り先になっている）
 * - security … ログイン通知・セキュリティの警告
 * - password … パスワードの再設定・変更
 * - signup   … 登録・メールアドレスの確認
 * - billing  … 支払い・注文・予約
 * - notice   … そのほかの、この人あてのお知らせ
 * - promo    … 広告・一斉配信
 */
export type Kind = "auth" | "security" | "password" | "signup" | "billing" | "notice" | "promo";

export const KINDS: Kind[] = ["auth", "security", "password", "signup", "billing", "notice", "promo"];
/** このアドレスでログイン・本人確認をしている、と言える種類 */
export const LOGIN_KINDS: Kind[] = ["auth", "security", "password"];

export interface MailFacts {
  subject: string;
  /** Gmail の分類ラベル（CATEGORY_PROMOTIONS など）。Gmail 以外では空 */
  labels?: string[];
  /** List-Unsubscribe ヘッダがある（配信停止できる＝一斉配信の印） */
  listUnsubscribe?: boolean;
  /** Precedence ヘッダの値（bulk・list なら一斉配信） */
  precedence?: string;
}

// ログイン・本人確認にかかわる 3 種類は、広告の印が付いていても優先する（広告がこの言い回しを使うことは、ほぼない）
const AUTH =
  /認証コード|確認コード|認証番号|確認番号|セキュリティコード|ワンタイム|本人確認コード|ログインコード|サインインコード|[2２二]\s*(段階|要素)認証|verification code|security code|login code|sign[- ]?in code|one[- ]?time (pass(word|code)?|code|pin)|\botp\b|passcode|two[- ]?(factor|step)|\b2fa\b/i;
const PASSWORD =
  /パスワード.{0,12}(再設定|リセット|変更|再発行|初期化|更新)|(再設定|リセット).{0,6}パスワード|暗証番号.{0,8}(変更|再設定)|(reset|change|update|forgot).{0,12}password|password.{0,12}(reset|changed|updated|recovery)/i;
const SECURITY =
  /ログイン.{0,6}(通知|お知らせ|がありました|しました|されました|を検出|を確認|履歴|アラート)|新しい.{0,6}(端末|デバイス|ブラウザ|ログイン|サインイン)|サインイン.{0,6}(通知|がありました|しました|を検出|アラート)|不正(な)?(ログイン|アクセス|利用)|セキュリティ.{0,4}(通知|警告|アラート|上の|に関する)|アカウントへの(アクセス|ログイン)|new (sign[- ]?in|log[- ]?in|device|browser)|(sign[- ]?in|log[- ]?in) (attempt|alert|detected|notification|from)|security (alert|notice|notification|warning)|unusual (activity|sign|log)|suspicious/i;
const BILLING =
  /領収書?|ご請求|請求(額|金額|書|のお知らせ|が確定)|ご注文|注文.{0,4}(確認|内容|完了|受付|番号)|購入.{0,4}(完了|ありがとう|明細|内容|手続)|決済.{0,4}(完了|のお知らせ|確認)|お支払い?|支払.{0,4}(完了|確認|明細)|発送.{0,4}(しました|のお知らせ|完了|通知)|ご予約|予約.{0,4}(確認|完了|内容|受付)|ご利用(明細|料金|代金)|receipt|invoice|order (confirm|number|#|received|placed)|your order|payment (received|confirm|receipt|successful|failed)|billing|has shipped|subscription (renew|confirm|receipt)/i;
const SIGNUP =
  /(会員|アカウント|ユーザー|仮|本|新規|利用)登録|登録.{0,4}(完了|確認|ありがとう|のご案内|手続|受付)|ようこそ|メールアドレス.{0,6}(確認|認証|変更|登録)|アカウント.{0,6}(作成|開設|確認|有効|登録)|welcome to|verify your (e-?mail|account|address)|confirm your (e-?mail|account|registration|address)|activate your|account (created|confirmation|activation)|registration|thanks for (signing|joining|registering)|finish (setting|signing)|complete your (registration|sign)/i;

const BULK_PRECEDENCE = /^(bulk|list|junk)$/i;

/** メール 1 通の種類を決める */
export function classify(m: MailFacts): Kind {
  const s = m.subject;
  if (AUTH.test(s)) return "auth";
  if (PASSWORD.test(s)) return "password";
  if (SECURITY.test(s)) return "security";
  // Gmail が「プロモーション」に入れたものは広告（件名に「登録」「注文」と入っていても）
  if (m.labels?.includes("CATEGORY_PROMOTIONS")) return "promo";
  if (BILLING.test(s)) return "billing";
  if (SIGNUP.test(s)) return "signup";
  if (m.listUnsubscribe || (m.precedence && BULK_PRECEDENCE.test(m.precedence.trim())) || m.labels?.includes("CATEGORY_SOCIAL")) return "promo";
  return "notice";
}
