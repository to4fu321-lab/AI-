/**
 * 除外リスト（取得しないサイト・URL）。画面とサーバーの両方で使う。
 *
 * 書き方は 2 通り：
 *   - ドメインだけ（例: example.com）     … そのサイトと、その下のサブドメイン全部
 *   - パス付き（例: example.com/ads/）    … その URL で始まるものだけ
 * 「https://」や「www.」は付けても付けなくても同じ扱い。
 */

export const MAX_EXCLUDES = 100;

/** 入力を比べやすい形にそろえる（無効なら null） */
export function normalizeRule(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").replace(/[?#].*$/, "");
  const [host, ...rest] = s.split("/");
  if (!/^[a-z0-9.-]+(:\d+)?$/.test(host) || !(host.includes(".") || host.startsWith("localhost"))) return null;
  const path = rest.join("/");
  return path ? `${host}/${path}` : host;
}

function bareUrl(url: string): { host: string; hostname: string; full: string } | null {
  try {
    const u = new URL(url);
    const host = u.host.toLowerCase().replace(/^www\./, "");
    const hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    return { host, hostname, full: `${host}${u.pathname}`.toLowerCase() };
  } catch {
    return null;
  }
}

/** URL が除外リストのどれかに当たるか */
export function isExcluded(url: string, rules: readonly string[]): boolean {
  if (rules.length === 0) return false;
  const u = bareUrl(url);
  if (!u) return false;
  for (const rule of rules) {
    if (rule.includes("/")) {
      if (u.full.startsWith(rule)) return true;
    } else {
      // ポート番号付きのルールはポートまで、なしならポートに関係なく比べる
      const target = rule.includes(":") ? u.host : u.hostname;
      if (target === rule || target.endsWith(`.${rule}`)) return true;
    }
  }
  return false;
}

/** 画像・動画 1 件が除外対象か（本体の URL と、見つかったページの両方を見る） */
export function isItemExcluded(item: { src: string; pageUrl: string }, rules: readonly string[]): boolean {
  return isExcluded(item.src, rules) || isExcluded(item.pageUrl, rules);
}
