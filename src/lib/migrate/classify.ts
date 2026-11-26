/**
 * メール 1 通を、ヘッダだけ（件名・Gmail の分類ラベル・配信停止ヘッダなど）から分類する。
 * 通信もデータベースも使わない（画面・サーバー・あとで作る MCP のどこからでも同じ結果になる）。
 * 本文は見ない。
 *
 * 分類の決まりを変えたら RULES_VERSION を上げる（どの決まりで数えた結果かを、あとで見分けるため）。
 */
export const RULES_VERSION = 2;

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

/**
 * 件名を、比べやすい形にそろえる：全角の英数字・記号を半角に、大文字を小文字に、空白の並びを 1 つに。
 * 「ＯＴＰ」「セキュリティ コード」「Ｐａｓｓｗｏｒｄ」のような書き方の違いで、見落とさないようにする
 */
export function normalizeSubject(subject: string): string {
  return subject
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^(\s*(fwd?|fw|転送)\s*[:：]\s*)+/, "")
    .trim();
}

// 広告によくある言い回し。これがあれば、ほかの言葉（「ログイン」「登録」「注文」など）が入っていても広告として扱う
const AD =
  /キャンペーン|セール|特集|クーポン|お得|プレゼント|当たる|ポイント.{0,6}倍|\d+\s*ポイント|ボーナス|受付中|新作|新商品|新登場|登場!|登場！|開催|セミナー|ウェビナー|おすすめ|オススメ|ご紹介|本日限り|期間限定|今だけ|今なら|お早めに|コレクション|メールマガジン|メルマガ|\d+\s*(%|円)\s*(off|オフ|引)|半額|\bdeals?\b|\bsale\b|\bsave \d|\bfree shipping\b|\bships free\b|\bdiscounts?\b|\bwebinar\b|\bsponsored\b|\btry it free\b|\b\d+% off\b|black friday|today only|this (week|weekend)\b/;

// 認証コード・ワンタイムパスワード
const AUTH =
  /認証\s?(コード|番号|キー)|確認\s?(コード|番号)|セキュリティ\s?コード|ワンタイム|本人確認|pin\s?コード|ログイン用|[2二]\s?(段階|要素)認証|(コード|code)\s*(は|[:：])|\bguard\b.{0,4}コード|(verification|confirmation|security|login|sign[- ]?in|launch|access|auth(entication)?) code|code de v[ée]rification|is your .{0,40}code|your .{0,30} code\b|enter this code|\botp\b|one[- ]?time (pass(word|code)?|code|pin)|\bpasscode\b|two[- ]?factor|\b2fa\b|two[- ]?step verification|verify your device|(login|sign[- ]?in|magic) link|^sign in to \w/;
// 2 段階認証の「設定が変わった」という知らせは、コードではなくセキュリティの通知
const AUTH_SETTING_CHANGED = /[2二]\s?(段階|要素)認証.{0,10}(有効|無効|解除|変更|オン|オフ|設定されました|設定が完了)|two[- ]?(factor|step).{0,30}(enabled|disabled|turned (on|off))/;
const PASSWORD =
  /パスワード.{0,16}(再設定|リセット|変更|再発行|初期化|更新|お忘れ|設定|有効期限)|(再設定|リセット).{0,6}パスワード|password\s?再設定|暗証番号.{0,8}(変更|再設定)|(reset|change|update|forg[oe]t|create|set|new).{0,16}password|password.{0,16}(reset|changed|updated|recovery|expir)/;
const SECURITY =
  /ログイン(通知|の?お知らせ)|ログイン.{0,8}(がありました|しました|されました|が.{0,12}行われました|を検出|を確認|アラート|に失敗|試行)|サインイン(通知|の?お知らせ)|サインイン.{0,8}(がありました|しました|されました|を検出|アラート|に使用|に失敗|試行)|(新しい|別の).{0,8}(端末|デバイス|ブラウザ|場所).{0,14}(ログイン|サインイン|アクセス)|不審な|不正(な)?(ログイン|アクセス|利用).{0,12}(検知|検出|可能性|疑い|がありました|されました)|セキュリティ.{0,4}(通知|警告|アラート)|アカウント.{0,10}(ロック|停止|凍結|制限|の確認|の保護|に関する重要)|メールアドレス.{0,6}(が|の|を)?変更|new (sign[- ]?in|log[- ]?in) (to|from|on|detected|attempt)|new (device|browser).{0,12}(sign|log)|was used to sign in|(sign[- ]?in|log[- ]?in) (attempt|alert|detected|notification|activity)|unusual (sign|log|activity)|suspicious (sign|log|activity)|security alert|was this you|did you (just )?sign in|account.{0,20}(locked|suspended|disabled|restricted)|(ssh key|oauth application|passkey|recovery (email|phone)).{0,30}(added|changed|removed)|recovery (email|phone) (changed|added|removed)/;
const BILLING =
  /領収書?|ご請求|請求(額|金額|書|のお知らせ|が確定)|ご注文|注文.{0,4}(確認|内容|完了|受付|番号|明細)|購入.{0,4}(完了|ありがとう|明細|内容|手続|されました)|決済.{0,4}(完了|のお知らせ|確認)|お支払い?|支払.{0,4}(完了|確認|明細)|発送.{0,4}(しました|のお知らせ|完了|通知)|ご予約|予約.{0,4}(確認|完了|内容|受付)|ご利用.{0,6}(明細|料金|代金|のお知らせ|金額)|口座振替|引き落とし|引落|自動更新|定期購入|カード.{0,4}ご利用|ご利用確認|お?振込|出金|入金|配達.{0,4}(完了|予定|のお知らせ)|お届け.{0,6}(予定|完了|のお知らせ)|(電子|e-?)\s?チケット|e-?ticket|itinerary|チャージ.{0,6}完了|\breceipt\b|\binvoice\b|order (confirm|number|#|received|placed|of)|your .{0,20}order\b|payment.{0,12}(received|confirm|receipt|successful|unsuccessful|failed|declined|method)|billing (statement|receipt|update|failed|information)|has shipped|subscription.{0,20}(renew|confirm|receipt|cancel|expir)/;
const SIGNUP =
  /(会員|アカウント|ユーザー|仮|本|新規|利用|id\s?)登録.{0,6}(完了|確認|ありがとう|のご案内|のお知らせ|手続|受付)|登録.{0,4}(完了|確認|ありがとう)|ようこそ|メールアドレス.{0,6}(確認|認証|登録)|(アカウント|id).{0,8}(作成|開設|有効化)|welcome to|verify (your )?(e-?mail|account|address)|confirm (your )?(e-?mail|account|registration|address)|activate your|account (created|confirmation|activation|is ready)|your account is ready|registration (complete|confirm)|thanks for (signing|joining|registering)|finish (setting|signing)|complete your (registration|sign)/;

const BULK_PRECEDENCE = /^(bulk|list|junk)$/i;

/** メール 1 通の種類を決める */
export function classify(m: MailFacts): Kind {
  // Gmail が「プロモーション」に入れたものは広告（件名に「ログイン」「認証」と入っていても）。本物の認証コードがここに入ることは、まずない
  if (m.labels?.includes("CATEGORY_PROMOTIONS")) return "promo";
  // 返信は、人どうしのやり取り
  if (/^\s*re\s*[:：]/i.test(m.subject)) return "notice";
  const s = normalizeSubject(m.subject);
  const bulk = !!m.listUnsubscribe || (!!m.precedence && BULK_PRECEDENCE.test(m.precedence.trim())) || !!m.labels?.includes("CATEGORY_SOCIAL");
  if (AD.test(s)) return bulk ? "promo" : "notice";
  if (PASSWORD.test(s)) return "password";
  if (AUTH_SETTING_CHANGED.test(s)) return "security";
  if (AUTH.test(s)) return "auth";
  if (SECURITY.test(s)) return "security";
  if (BILLING.test(s)) return "billing";
  if (SIGNUP.test(s)) return "signup";
  return bulk ? "promo" : "notice";
}
