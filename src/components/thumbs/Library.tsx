"use client";

/** 取得の設定（登録サイトと履歴に一緒に保存して、同じ条件で取り直せるようにする） */
export interface CrawlSettings {
  depth: number;
  maxPages: number;
  maxPagination: number;
  crossSite: boolean;
  /** 古い保存データにはないので省略可（なければ auto） */
  render?: "auto" | "always" | "off";
}

export interface HistoryEntry {
  url: string;
  /** 最後に取得した日時（ミリ秒） */
  at: number;
  pages: number;
  found: number;
  settings: CrawlSettings;
}

export interface SavedSite {
  url: string;
  settings: CrawlSettings;
}

export const MAX_SITES = 5;
export const MAX_HISTORY = 50;

export function describeSettings(s: CrawlSettings): string {
  const parts = [s.depth === 0 ? "このページのみ" : `${s.depth}階層`];
  if (s.maxPagination > 0) parts.push(`ページ送り${s.maxPagination}`);
  if (s.crossSite) parts.push("他サイトも");
  if (s.render === "always") parts.push("ブラウザ");
  if (s.render === "off") parts.push("ブラウザなし");
  return parts.join("・");
}

const short = (url: string) => url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");

function timeAgo(at: number, now: number): string {
  const min = Math.round((now - at) / 60000);
  if (min < 1) return "たった今";
  if (min < 60) return `${min}分前`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}時間前`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}日前`;
  return new Date(at).toLocaleDateString("ja-JP");
}

export function Library({
  sites,
  history,
  now,
  onRun,
  onSave,
  onRemoveSite,
  onRemoveHistory,
  onClearHistory,
}: {
  sites: SavedSite[];
  history: HistoryEntry[];
  /** 「〇分前」の基準時刻（描画のたびに変わらないよう親から渡す） */
  now: number;
  onRun: (url: string, settings: CrawlSettings) => void;
  onSave: (url: string, settings: CrawlSettings) => void;
  onRemoveSite: (url: string) => void;
  onRemoveHistory: (url: string) => void;
  onClearHistory: () => void;
}) {
  const savedUrls = new Set(sites.map((s) => s.url));
  const full = sites.length >= MAX_SITES;

  return (
    <div className="mt-3 space-y-2">
      <section>
        <h2 className="mb-1.5 flex items-center gap-1.5 text-xs font-bold text-neutral-500">
          ⭐ 登録サイト
          <span className="font-normal text-neutral-400">
            {sites.length}/{MAX_SITES}
          </span>
        </h2>
        {sites.length === 0 ? (
          <p className="text-[11px] text-neutral-400">よく使う URL は、下の一覧や履歴の ☆ で登録できます（5 個まで）</p>
        ) : (
          <ul className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {sites.map((site) => (
              <li
                key={site.url}
                className="flex shrink-0 items-center rounded-full border border-amber-300 bg-amber-50 text-xs dark:border-amber-700 dark:bg-amber-950/40"
              >
                <button
                  type="button"
                  onClick={() => onRun(site.url, site.settings)}
                  className="max-w-[14rem] py-1.5 pl-3 pr-1 text-left"
                  title={`${site.url}（${describeSettings(site.settings)}）で取得`}
                >
                  <span className="block truncate font-semibold">▶ {short(site.url)}</span>
                  <span className="block truncate text-[10px] text-neutral-500">{describeSettings(site.settings)}</span>
                </button>
                <button
                  type="button"
                  onClick={() => onRemoveSite(site.url)}
                  aria-label="登録を外す"
                  className="px-2.5 py-1.5 text-neutral-400 hover:text-red-500"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {history.length > 0 && (
        <details className="group rounded-xl border border-neutral-200 bg-white text-xs dark:border-neutral-800 dark:bg-neutral-900">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 font-bold text-neutral-500">
            🕘 履歴 <span className="font-normal text-neutral-400">{history.length}件</span>
            <span className="ml-auto text-neutral-400 transition group-open:rotate-90">›</span>
          </summary>
          <ul className="max-h-72 divide-y divide-neutral-100 overflow-y-auto border-t border-neutral-100 dark:divide-neutral-800 dark:border-neutral-800">
            {history.map((h) => {
              const saved = savedUrls.has(h.url);
              return (
                <li key={h.url} className="flex items-center gap-1 px-3 py-1.5">
                  <button
                    type="button"
                    onClick={() => onRun(h.url, h.settings)}
                    className="min-w-0 flex-1 text-left"
                    title="同じ設定でもう一度取得"
                  >
                    <span className="block truncate font-semibold">{short(h.url)}</span>
                    <span className="block truncate text-[10px] text-neutral-400">
                      {timeAgo(h.at, now)} ・ {h.pages}ページ ・ {h.found}件 ・ {describeSettings(h.settings)}
                    </span>
                  </button>
                  <button
                    type="button"
                    disabled={saved || full}
                    onClick={() => onSave(h.url, h.settings)}
                    aria-label={saved ? "登録済み" : "登録する"}
                    title={saved ? "登録済み" : full ? "登録は5個までです" : "登録する"}
                    className={`px-1.5 text-base ${saved ? "text-amber-400" : "text-neutral-300 hover:text-amber-400 disabled:opacity-40"}`}
                  >
                    {saved ? "★" : "☆"}
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemoveHistory(h.url)}
                    aria-label="履歴から消す"
                    className="px-1.5 text-neutral-300 hover:text-red-500"
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="border-t border-neutral-100 px-3 py-1.5 text-right dark:border-neutral-800">
            <button type="button" onClick={onClearHistory} className="text-[11px] text-neutral-400 hover:text-red-500">
              履歴をすべて消す
            </button>
          </div>
        </details>
      )}
    </div>
  );
}
