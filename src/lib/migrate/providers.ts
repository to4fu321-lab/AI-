/**
 * Gmail 以外のメール会社の、IMAP でのつなぎ方（画面とサーバーの両方で使う。秘密は入っていない）。
 * サーバー名や手順は、各社の公式の案内で確かめたものだけを書く（確かめた日と出どころを添える）。
 * ここにないドメインは、利用者にサーバー名を入れてもらう
 */
export interface MailProvider {
  id: string;
  name: string;
  /** このメール会社のアドレスか（@ より後ろで見分ける） */
  match: RegExp;
  /** IMAP サーバー（ポート 993・暗号化あり） */
  host?: string;
  /** ログインに使う名前：address＝メールアドレスそのもの／local＝@ より前／ask＝アドレスとは別の ID を、利用者に入れてもらう */
  user?: "address" | "local" | "ask";
  /** user が ask のとき、入力欄に出す名前（「d アカウントの ID」など） */
  userLabel?: string;
  /** パスワードの欄に出す名前（ログイン用のパスワードとは別の、メール専用のパスワードを使う会社が多い） */
  passwordLabel?: string;
  /** つなぐ前に知っておいてほしい注意（画面にそのまま出す） */
  caution?: string;
  /** つなぐ前に利用者にしてもらうこと（メール会社の側の設定） */
  steps?: string[];
  /** 公式の案内のページ */
  helpUrl?: string;
  /** パスワードではつなげない会社。その理由（画面にそのまま出す） */
  blocked?: string;
}

// どれも 2026-11-27 に、各社の公式の案内で確かめた（確かめられなかった会社は載せていない。利用者にサーバー名を入れてもらう）
export const PROVIDERS: MailProvider[] = [
  {
    // https://support.yahoo-net.jp/PccMail/s/article/H000007321 ／ https://whatsnewmail.yahoo.co.jp/yahoo/20261006a.html
    id: "yahoo-jp",
    name: "Yahoo!メール",
    match: /^(?:yahoo\.co\.jp|ymail\.ne\.jp)$/,
    host: "imap.mail.yahoo.co.jp",
    user: "address",
    passwordLabel: "Yahoo! JAPAN ID のパスワード",
    steps: [
      "Yahoo!メールの「設定」→「IMAP/POP/SMTPアクセス」を開く",
      "「Yahoo! JAPAN公式サービス以外からのアクセス」を「許可する」に、IMAP を「利用する」にして保存する（2026 年 10 月から、先にパスワードの変更を求められます）",
      "つながらないときは、「海外からのアクセス制限」を「無効」にする（このサービスのサーバーが、海外からのアクセスと判定されることがあります）",
    ],
    caution:
      "Yahoo!メールには、メール専用のパスワードがありません。預かるのは、Yahoo! JAPAN ID そのもののパスワードになります。LINEヤフーの規約には、パスワードをほかの人に渡すことを禁じる定めがあります。ご自身の判断でつないでください。まちがったパスワードが続くと、ID が一時的に止められることがあります。",
    helpUrl: "https://support.yahoo-net.jp/PccMail/s/article/H000007321",
  },
  {
    // https://support.ntt.com/ocn-business/support/detail/pid21000001uk9/
    id: "ocn",
    name: "OCN メール",
    match: /(?:^|\.)ocn\.ne\.jp$/,
    host: "imap.ocn.ne.jp",
    user: "address",
    passwordLabel: "メールパスワード",
    steps: ["パスワードは「メールパスワード」を使います（OCN 会員登録証に書いてあるもの。インターネット接続用のパスワードとは別です）"],
  },
  {
    // https://mail.nifty.com/cs/mail-faq/detail/200326000044/ ／ https://mail.nifty.com/cs/mail-info/detail/sg-2nwnbi/
    id: "nifty",
    name: "@nifty メール",
    match: /^nifty\.com$/,
    host: "imap.nifty.com",
    user: "address",
    passwordLabel: "メールパスワード",
    steps: [
      "@nifty の「メールソフト接続許可（IMAP）」で「IMAP接続を許可する」を選び、「許可中」になっていることを確かめる（2026 年 9 月 30 日から、新しく IMAP を使うときに必要です）",
      "パスワードは「メールパスワード」を使います（@nifty のログイン用のパスワードとは別です）",
    ],
    helpUrl: "https://mail.nifty.com/cs/mail-info/detail/sg-2nwnbi/",
  },
  {
    // https://faq.support.biglobe.ne.jp/faq_detail.html?faq_id=13046
    id: "biglobe",
    name: "BIGLOBE メール",
    match: /(?:^|\.)biglobe\.ne\.jp$/,
    host: "mail.biglobe.ne.jp",
    user: "address",
    passwordLabel: "BIGLOBE パスワード",
    steps: ["パスワードは「BIGLOBE パスワード（メールパスワード）」を使います（接続用のパスワードとは別です）", "2026 年 6 月にパスワードが初期化された方は、新しいパスワードを使ってください"],
    helpUrl: "https://faq.support.biglobe.ne.jp/faq_detail.html?faq_id=13046",
  },
  {
    // https://support.so-net.ne.jp/fa/faq/web/knowledge1687.html ／ https://www.so-net.ne.jp/option/mail/imap/price.html
    id: "so-net",
    name: "So-net メール",
    match: /(?:^|\.)so-net\.ne\.jp$/,
    host: "imap.so-net.ne.jp",
    user: "address",
    passwordLabel: "メールアドレスパスワード",
    steps: ["So-net のメールを IMAP で読むには、有料のオプション「IMAPサービス」（月 88 円）の申し込みが要ります", "パスワードは「メールアドレスパスワード」を使います（マイページのログイン用とは別です）"],
    helpUrl: "https://www.so-net.ne.jp/option/mail/imap/price.html",
  },
  {
    // https://www.docomo.ne.jp/service/docomo_mail/other/set_up/index.html ／ https://www.docomo.ne.jp/service/docomo_mail/other/security/index.html
    id: "docomo",
    name: "ドコモメール",
    match: /^docomo\.ne\.jp$/,
    host: "imap.spmode.ne.jp",
    user: "ask",
    userLabel: "d アカウントの ID（IMAP 用 ID）",
    passwordLabel: "IMAP 専用パスワード",
    steps: [
      "My docomo の「メール設定」→「d アカウントの利用設定」で、「d アカウントでドコモメールを利用する」にする（ドコモの回線につないだ状態で行います。Wi-Fi では設定できません）",
      "「IMAP 用 ID・パスワードの確認」に出る、IMAP 専用パスワード（10 文字）を使います",
      "つなぐと、いつもと違う場所からのログインとして、ドコモから SMS が届くことがあります",
    ],
    helpUrl: "https://www.docomo.ne.jp/service/docomo_mail/other/set_up/index.html",
  },
  {
    // https://www.softbank.jp/mobile/service/mail-address-portability/mms/
    id: "softbank-mms",
    name: "ソフトバンクのメール（S!メール）",
    match: /^softbank\.ne\.jp$/,
    host: "imap.softbank.ne.jp",
    user: "address",
    passwordLabel: "My SoftBank に出るパスワード",
    steps: ["My SoftBank の「メール管理」→「S!メール(MMS)」→「設定情報」に出るパスワードを使います"],
    helpUrl: "https://www.softbank.jp/mobile/service/mail-address-portability/mms/",
  },
  {
    // https://www.softbank.jp/mobile/support/mail/setting/iphone/sslsecurity/
    id: "softbank-i",
    name: "ソフトバンクのメール（Eメール(i)）",
    match: /^i\.softbank\.jp$/,
    host: "imap.softbank.jp",
    user: "address",
    passwordLabel: "My SoftBank で発行したパスワード",
    steps: ["My SoftBank で発行した、メール用のパスワードを使います"],
    helpUrl: "https://www.softbank.jp/mobile/support/mail/setting/iphone/sslsecurity/",
  },
  {
    // https://support.apple.com/ja-jp/102525 ／ https://support.apple.com/ja-jp/102654
    id: "icloud",
    name: "iCloud メール",
    match: /^(?:icloud|me|mac)\.com$/,
    host: "imap.mail.me.com",
    user: "local",
    passwordLabel: "アプリ用パスワード",
    steps: [
      "account.apple.com の「サインインとセキュリティ」→「アプリ用パスワード」で、アプリ用パスワードを作る（2 ファクタ認証が必要です）",
      "作ったアプリ用パスワードを、下に入れます（Apple Account のパスワードそのものは、使えません）",
    ],
    helpUrl: "https://support.apple.com/ja-jp/102654",
  },
  {
    // https://www.au.com/mobile/service/email/other/ （サーバー名は、ログインした画面にだけ出る）
    id: "au",
    name: "au メール",
    match: /^(?:au\.com|ezweb\.ne\.jp)$/,
    user: "ask",
    userLabel: "設定情報に出るユーザー名",
    passwordLabel: "設定情報に出るパスワード",
    steps: [
      "au の「メール設定情報を取得する」の画面を開き、出てきたサーバー名・ユーザー名・パスワードを下に入れます",
      "その画面を開き直すと、パスワードが新しくなり、前のものは使えなくなります（そのときは、つなぎ直してください）",
    ],
    helpUrl: "https://www.au.com/mobile/service/email/other/",
  },
  {
    // https://support.microsoft.com/en-us/topic/c5d65390-9676-4763-b41f-d7986499a90d
    id: "outlook",
    name: "Outlook.com（Hotmail）",
    match: /^(?:outlook\.(?:com|jp)|hotmail\.(?:com|co\.jp)|live\.(?:com|jp)|msn\.com)$/,
    blocked: "Outlook.com・Hotmail は、Microsoft の決まりで、パスワードではつなげません（2024 年 9 月から）。対応は準備中です。",
  },
];

/** アドレスから、メール会社を見分ける（分からなければ null） */
export function providerFor(email: string): MailProvider | null {
  const domain = email.trim().toLowerCase().split("@")[1] ?? "";
  if (!domain) return null;
  return PROVIDERS.find((p) => p.match.test(domain)) ?? null;
}
