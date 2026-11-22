/**
 * 広告・計測の通信を見分ける。
 *
 * 動画サイトの多くは、本編の前に広告動画を流したり、再生ボタンの上に「押すと広告が開く透明な板」を置いたりする。
 * ブラウザで開くときに広告の通信を最初から止めておくと、
 *   - プレーヤーは広告を飛ばして本編を読み込む（広告の読み込みに失敗したら本編に進む作りが普通）
 *   - 広告動画を本編と間違えて一覧に出さない
 *   - 読み込みが速くなる
 * 画像・動画の一覧からも、広告の配信元のものは外す。
 */

/** 広告・計測の配信元（このドメインとその下のサブドメイン） */
const AD_HOSTS = [
  // 世界の大手
  "doubleclick.net", "googlesyndication.com", "googleadservices.com", "google-analytics.com", "googletagmanager.com",
  "googletagservices.com", "adservice.google.com", "imasdk.googleapis.com", "adnxs.com", "adsrvr.org", "amazon-adsystem.com",
  "criteo.com", "criteo.net", "taboola.com", "outbrain.com", "rubiconproject.com", "pubmatic.com", "openx.net", "casalemedia.com",
  "smartadserver.com", "adform.net", "moatads.com", "scorecardresearch.com", "quantserve.com", "mgid.com", "revcontent.com",
  "zedo.com", "bidgear.com", "yieldmo.com", "teads.tv", "spotxchange.com", "springserve.com", "innovid.com", "serving-sys.com",
  "hotjar.com", "clarity.ms",
  // ポップアップ・成人向けサイトで多い広告
  "exoclick.com", "exosrv.com", "exdynsrv.com", "juicyads.com", "trafficjunky.net", "trafficjunky.com", "trafficstars.com",
  "tsyndicate.com", "popads.net", "popcash.net", "propellerads.com", "propellerclick.com", "adsterra.com", "hilltopads.net",
  "a-ads.com", "adcash.com", "clickadu.com", "onclickads.net", "onclkds.com", "ero-advertising.com", "adspyglass.com",
  "realsrv.com", "magsrv.com", "adtng.com", "admaven.com", "ad-maven.com", "highperformanceformat.com", "trafficfactory.biz",
  "xlivrdr.com", "dtscout.com", "histats.com", "mc.yandex.ru",
  // 日本の広告
  "i-mobile.co.jp", "nend.net", "microad.jp", "microad.net", "fluct.jp", "adingo.jp", "zucks.net", "gmossp-sp.jp", "ad-stir.com",
  "impact-ad.jp", "logly.co.jp", "popin.cc", "yads.c.yimg.jp", "ladsp.com", "socdm.com", "adlantis.jp", "amoad.com",
  "ad-generation.jp", "uncn.jp", "genieesspv.jp", "geniee.co.jp", "j.zucks.net.zimg.jp", "a8.net", "valuecommerce.com",
  "moshimo.com", "accesstrade.net", "afi-b.com",
];

const HOST_SET = new Set(AD_HOSTS);

/** 広告の動画を返す仕組み（VAST・VPAID・VMAP）や、広告用の決まったパス */
const AD_PATH_RE =
  /(?:^|[/._-])(?:vast|vpaid|vmap)(?:\.xml|\.php|[/?_]|$)|[?&](?:vast|vmap|ad_?tag(?:_?url)?)=|\/pagead\/|\/adserver|\/prebid|\/popunder|\/pop_?up\.js/i;

/** その URL が広告・計測の通信か */
export function isAdUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  const labels = host.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    if (HOST_SET.has(labels.slice(i).join("."))) return true;
  }
  return AD_PATH_RE.test(u.pathname + u.search);
}
