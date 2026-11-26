"use client";

import { useEffect, useRef, useState } from "react";
import { gofileTokenBookmarklet } from "./gofileBookmarklet";

/** 取得の設定（登録サイトと履歴に一緒に保存して、同じ条件で取り直せるようにする） */
export interface CrawlSettings {
  depth: number;
  maxPages: number;
  maxPagination: number;
  crossSite: boolean;
  /** 古い保存データにはないので省略可（なければ auto） */
  render?: "auto" | "always" | "off";
  /** 古い保存データにはないので省略可（なければ all） */
  kinds?: "all" | "video" | "image";
  /** robots.txt を守るか。古い保存データにはないので省略可（なければ守る） */
  robots?: boolean;
  /** ネット全体から探す（検索から出発）で始めたもの */
  hunt?: boolean;
  /** Gofile 探し（Gofile の中身だけ集める） */
  gofileOnly?: boolean;
  /** ファイル置き場を探すとき、集めない置き場（設定で外したもの） */
  skipHosts?: string[];
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
  if (s.kinds === "video") parts.unshift("動画のみ");
  if (s.kinds === "image") parts.unshift("画像のみ");
  if (s.maxPagination > 0) parts.push(`ページ送り${s.maxPagination}`);
  if (s.crossSite) parts.push("他サイトも");
  if (s.render === "always") parts.push("ブラウザ");
  if (s.render === "off") parts.push("ブラウザなし");
  if (s.robots === false) parts.push("robots.txt 無視");
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
  excludes,
  onAddExclude,
  onRemoveExclude,
  gofileToken,
  onGofileToken,
  appOrigin,
  incomingToken,
  now,
  onRun,
  onSave,
  onRemoveSite,
  onRemoveHistory,
  onClearHistory,
}: {
  sites: SavedSite[];
  history: HistoryEntry[];
  /** 除外リスト（取得しないサイト・URL） */
  excludes: string[];
  /** 追加できたら true（形式が正しくないときは false） */
  onAddExclude: (rule: string) => boolean;
  onRemoveExclude: (rule: string) => void;
  /** Gofile のアカウントトークン（空なら未設定） */
  gofileToken: string;
  onGofileToken: (token: string) => void;
  /** このアプリのアドレス（ブックマークレットに入れる） */
  appOrigin: string;
  /** ブックマークレットで受け取ったトークン（「＋ トークンを足す」の欄に入れる） */
  incomingToken?: string | null;
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

      <ExcludeList excludes={excludes} onAdd={onAddExclude} onRemove={onRemoveExclude} />
      <GofileSetting token={gofileToken} onChange={onGofileToken} appOrigin={appOrigin} incomingToken={incomingToken} />

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

/** Gofile のアカウントトークンの設定（Gofile がゲスト登録を断るときに使う） */
function GofileSetting({
  token,
  onChange,
  appOrigin,
  incomingToken,
}: {
  token: string;
  onChange: (token: string) => void;
  appOrigin: string;
  incomingToken?: string | null;
}) {
  const [value, setValue] = useState(token);
  const [error, setError] = useState<string | null>(null);
  const [prev, setPrev] = useState(token);
  // 保存してあった値を読み込んだら、入力欄にも反映する
  if (prev !== token) {
    setPrev(token);
    setValue(token);
  }
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    if (v && !/^[A-Za-z0-9]{10,128}$/.test(v)) {
      setError("英数字だけのトークンを貼り付けてください");
      return;
    }
    setError(null);
    onChange(v);
  };
  return (
    <details open={incomingToken ? true : undefined} className="group rounded-xl border border-neutral-200 bg-white text-xs dark:border-neutral-800 dark:bg-neutral-900">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 font-bold text-neutral-500">
        🔑 Gofile の設定 <span className="font-normal text-neutral-400">{token ? "トークン設定済み" : "未設定"}</span>
        <span className="ml-auto text-neutral-400 transition group-open:rotate-90">›</span>
      </summary>
      <div className="border-t border-neutral-100 px-3 py-2 dark:border-neutral-800">
        <p className="mb-2 text-[11px] leading-relaxed text-neutral-400">
          Gofile が「ゲスト登録を断りました」と出て読めないときに使います。gofile.io に無料登録してログインし、
          「My Profile」（プロフィール）にある「Account Token」を貼り付けてください。この端末にだけ保存され、取得のときにだけ使います。
        </p>
        <form onSubmit={save} className="flex gap-2">
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            placeholder="Account Token"
            className="min-w-0 flex-1 rounded-full border border-neutral-200 bg-neutral-50 px-3 py-1.5 text-[16px] text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-fuchsia-400 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-500"
          />
          <button type="submit" className="shrink-0 rounded-full bg-neutral-900 px-3 py-1.5 font-bold text-white dark:bg-white dark:text-neutral-900">
            保存
          </button>
        </form>
        {error && <p className="mt-1 text-[11px] text-red-500">{error}</p>}
        {token && (
          <button type="button" onClick={() => onChange("")} className="mt-1.5 text-[11px] text-neutral-400 underline hover:text-red-500">
            トークンを消す
          </button>
        )}
        <TokenBookmarklet appOrigin={appOrigin} />
        <PatrolTokens myToken={token} incomingToken={incomingToken} />
      </div>
    </details>
  );
}

function TokenBookmarklet({ appOrigin }: { appOrigin: string }) {
  const [copied, setCopied] = useState(false);
  if (!appOrigin) return null;
  const code = gofileTokenBookmarklet(appOrigin);
  return (
    <details className="mt-3 border-t border-neutral-100 pt-2 dark:border-neutral-800">
      <summary className="cursor-pointer font-bold text-neutral-500">⚡ トークンを楽に入れる（ブックマークレット）</summary>
      <ol className="mt-1.5 list-decimal space-y-1 pl-5 text-[11px] leading-relaxed text-neutral-400">
        <li>下の「コードをコピー」を押す</li>
        <li>
          何かのページをブックマークに追加し、そのブックマークを編集して、名前を「サムネ収集にトークンを送る」、URL を貼り付けたコードに書き換える
          （iPhone の Safari：ブックマーク → 編集 → 追加したブックマークをタップ）
        </li>
        <li>
          <a href="https://gofile.io/" target="_blank" rel="noopener noreferrer" className="underline">
            gofile.io
          </a>
          を開いて、表示されるまで待つ（開くだけでゲストのアカウントができます。ログインしていれば自分のアカウント）
        </li>
        <li>そのページ（できれば「My Profile」）でブックマーク「サムネ収集にトークンを送る」を押す → このアプリが開いて、トークンが入ります</li>
        <li>「見つけられませんでした」と出たら、My Profile の「API token」の横のコピーボタンを押してから、出てきた欄に貼り付けます</li>
      </ol>
      <div className="mt-1.5 flex gap-2">
        <button
          type="button"
          onClick={() =>
            void navigator.clipboard?.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2500);
            })
          }
          className="rounded-full bg-neutral-900 px-3 py-1 font-bold text-white dark:bg-white dark:text-neutral-900"
        >
          {copied ? "コピーしました ✓" : "コードをコピー"}
        </button>
      </div>
      <textarea readOnly value={code} rows={2} aria-label="ブックマークに入れるコード" className="mt-1.5 w-full rounded-md border border-neutral-200 bg-neutral-50 p-1.5 font-mono text-[10px] text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900" />
    </details>
  );
}

type PatrolToken = { tag: string; label: string; tail: string; badAt: number | null };

/**
 * 自動巡回で使う Gofile のトークン（利用者ごとに 1 つずつ、最大 5 つ）。
 * 巡回は上から順に使い、トークンが断られたら（無効・期限切れ）次のトークンに自動で切り替える
 */
function PatrolTokens({ myToken, incomingToken }: { myToken: string; incomingToken?: string | null }) {
  const [tokens, setTokens] = useState<PatrolToken[] | null>(null);
  const [max, setMax] = useState(5);
  const [label, setLabel] = useState("");
  /** 一覧に直接足すトークン（この端末の設定とは別に、何個でも続けて足せる） */
  const [newLabel, setNewLabel] = useState("");
  const [newToken, setNewToken] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const addRef = useRef<HTMLFormElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  // ブックマークレットで受け取ったトークンを「＋ トークンを足す」に入れて、そこまで画面を動かす
  const [filledFrom, setFilledFrom] = useState<string | null>(null);
  if (incomingToken && incomingToken !== filledFrom) {
    setFilledFrom(incomingToken);
    setNewToken(incomingToken);
  }
  useEffect(() => {
    if (!incomingToken || !tokens) return;
    addRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    nameRef.current?.focus({ preventScroll: true });
  }, [incomingToken, tokens]);
  useEffect(() => {
    const load = () =>
      void fetch("/api/thumbs/gofile-tokens")
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { configured?: boolean; max?: number; tokens?: PatrolToken[] } | null) => {
          if (!d?.configured) return;
          setTokens(d.tokens ?? []);
          if (d.max) setMax(d.max);
        })
        .catch(() => {});
    load();
    // ほかの場所（ブックマークレットのお知らせ）で足したら、読み直す
    window.addEventListener("thumbs-gofile-tokens", load);
    return () => window.removeEventListener("thumbs-gofile-tokens", load);
  }, []);
  if (!tokens) return null;
  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    setNote(null);
    const res = await fetch("/api/thumbs/gofile-tokens", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const d = (res ? await res.json().catch(() => null) : null) as { tokens?: PatrolToken[]; error?: string } | null;
    if (d?.tokens) setTokens(d.tokens);
    if (!res?.ok) setNote(d?.error ?? "保存できませんでした");
    setBusy(false);
    return !!res?.ok;
  };
  const mine = myToken ? tokens.find((t) => t.tail === myToken.slice(-4)) : undefined;
  return (
    <div className="mt-3 border-t border-neutral-100 pt-2 dark:border-neutral-800">
      <p className="font-bold text-neutral-500">🔁 自動巡回で使うトークン（{tokens.length}/{max}）</p>
      <p className="mb-1.5 text-[11px] leading-relaxed text-neutral-400">
        利用者ごとに 1 つずつ足せます。巡回は上から順に使い、トークンが断られたら（無効・期限切れ）次のトークンに自動で切り替えます。
        Gofile がサーバー全体を「聞きすぎ」で止めたときは、どのトークンでも同じなので、切り替えずに待ちます。
      </p>
      {tokens.length === 0 && <p className="text-[11px] text-neutral-400">まだありません（ゲストとして読みます）</p>}
      <ul className="space-y-1">
        {tokens.map((t, i) => (
          <li key={t.tag} className="flex items-center gap-2 text-[11px]">
            <span className="w-4 text-neutral-400">{i + 1}.</span>
            <span className="font-semibold">{t.label}</span>
            <span className="font-mono text-neutral-400">…{t.tail}</span>
            {t.badAt ? (
              <span className="text-red-500" title={`${new Date(t.badAt).toLocaleString("ja-JP")} に断られました`}>
                ⚠ 無効になっています（入れ直してください）
              </span>
            ) : (
              <span className="text-emerald-600 dark:text-emerald-400">使えます</span>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => confirm(`「${t.label}」のトークンを巡回から外しますか？`) && void post({ action: "remove", tag: t.tag })}
              className="ml-auto text-neutral-400 underline hover:text-red-500"
            >
              外す
            </button>
          </li>
        ))}
      </ul>
      {myToken && !mine && tokens.length < max && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void post({ action: "add", label, token: myToken });
          }}
          className="mt-2 flex gap-2"
        >
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="名前（例：自分・Aさん）"
            maxLength={30}
            className="min-w-0 flex-1 rounded-full border border-neutral-200 bg-neutral-50 px-3 py-1.5 text-[16px] text-neutral-900 outline-none placeholder:text-neutral-400 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
          />
          <button type="submit" disabled={busy} className="shrink-0 rounded-full bg-sky-600 px-3 py-1.5 font-bold text-white disabled:opacity-60">
            上のトークンを巡回にも使う
          </button>
        </form>
      )}
      {myToken && mine && <p className="mt-1.5 text-[11px] text-neutral-400">上のトークンは「{mine.label}」として巡回に入っています</p>}
      {tokens.length < max && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const t = newToken.trim();
            if (!/^[A-Za-z0-9]{10,128}$/.test(t)) return setNote("英数字だけのトークンを貼り付けてください");
            if (await post({ action: "add", label: newLabel, token: t })) {
              setNewToken("");
              setNewLabel("");
            }
          }}
          ref={addRef}
          className={`mt-2 space-y-1.5 rounded-lg p-2 ${newToken && newToken === incomingToken ? "bg-sky-50 ring-2 ring-sky-400 dark:bg-sky-950" : "bg-neutral-50 dark:bg-neutral-950"}`}
        >
          <p className="text-[11px] font-semibold text-neutral-500">＋ トークンを足す（ほかの人のぶんも、ここから続けて足せます）</p>
          <div className="flex gap-2">
            <input
              ref={nameRef}
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="名前"
              maxLength={30}
              className="w-24 shrink-0 rounded-full border border-neutral-200 bg-white px-3 py-1.5 text-[16px] text-neutral-900 outline-none placeholder:text-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
            />
            <input
              value={newToken}
              onChange={(e) => setNewToken(e.target.value)}
              placeholder="トークンを貼り付け"
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-full border border-neutral-200 bg-white px-3 py-1.5 text-[16px] text-neutral-900 outline-none placeholder:text-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
            />
          </div>
          <button type="submit" disabled={busy || !newToken.trim()} className="rounded-full bg-sky-600 px-3 py-1.5 font-bold text-white disabled:opacity-50">
            巡回に足す
          </button>
        </form>
      )}
      {note && <p className="mt-1 text-[11px] text-red-500">{note}</p>}
    </div>
  );
}

function ExcludeList({
  excludes,
  onAdd,
  onRemove,
}: {
  excludes: string[];
  onAdd: (rule: string) => boolean;
  onRemove: (rule: string) => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = (e: React.FormEvent) => {
    e.preventDefault();
    if (onAdd(value)) {
      setValue("");
      setError(null);
    } else {
      setError("サイト名か URL を入れてください（例: example.com / example.com/ads/）");
    }
  };
  return (
    <details className="group rounded-xl border border-neutral-200 bg-white text-xs dark:border-neutral-800 dark:bg-neutral-900">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 font-bold text-neutral-500">
        🚫 除外リスト <span className="font-normal text-neutral-400">{excludes.length}件</span>
        <span className="ml-auto text-neutral-400 transition group-open:rotate-90">›</span>
      </summary>
      <div className="border-t border-neutral-100 px-3 py-2 dark:border-neutral-800">
        <p className="mb-2 text-[11px] text-neutral-400">
          ここにあるサイトは辿らず、画像・動画も一覧に出しません。サイト名だけ（example.com）ならサイト全体、URL の一部（example.com/ads/）ならそこから下だけ。
        </p>
        <form onSubmit={add} className="flex gap-2">
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="example.com"
            className="min-w-0 flex-1 rounded-full border border-neutral-200 bg-neutral-50 px-3 py-1.5 text-[16px] text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-fuchsia-400 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-500"
          />
          <button type="submit" className="shrink-0 rounded-full bg-neutral-900 px-3 py-1.5 font-bold text-white dark:bg-white dark:text-neutral-900">
            追加
          </button>
        </form>
        {error && <p className="mt-1 text-[11px] text-red-500">{error}</p>}
        {excludes.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {excludes.map((rule) => (
              <li key={rule} className="flex items-center rounded-full bg-neutral-100 pl-2.5 dark:bg-neutral-800">
                <span className="max-w-[14rem] truncate">{rule}</span>
                <button type="button" onClick={() => onRemove(rule)} aria-label={`${rule} を除外リストから外す`} className="px-2 py-1 text-neutral-400 hover:text-red-500">
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
