"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CrawlEvent, CrawlState, MediaItem } from "@/lib/thumbs/types";
import { getVideoThumb, peekVideoThumb } from "./videoThumb";
import { isItemExcluded, MAX_EXCLUDES, normalizeRule } from "@/lib/thumbs/exclude";
import { Library, MAX_HISTORY, MAX_SITES, type CrawlSettings, type HistoryEntry, type SavedSite } from "./Library";

/** 一覧の 1 件。どの入力 URL（ジョブ）から見つかったかを覚えておく */
type Item = MediaItem & { jobId: string };

interface Job {
  id: string;
  url: string;
  status: "running" | "done" | "error" | "stopped";
  pages: number;
  errors: number;
  message?: string;
  truncated?: boolean;
  /** 取れなかった理由などの補足 */
  note?: string;
  settings?: CrawlSettings;
  /** 最後に受け取った途中経過。止まったときは「続きから」でここから再開する */
  resume?: CrawlState;
}

type Filter = "all" | "image" | "video";

const STORAGE_KEY = "thumbs:v1";
/** 履歴と登録サイトは「すべて消す」をしても残すので、別の場所に保存する */
const LIBRARY_KEY = "thumbs:library:v1";
const MAX_ITEMS = 5000;

class ServerError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
  }
}

/** ブラウザの英語のエラーを、何が起きたかわかる日本語にする */
function describeError(err: unknown): string {
  if (err instanceof ServerError) {
    return err.status === 504
      ? "サーバーの処理が時間切れになりました。もう一度お試しください"
      : `サーバーでエラーが起きました（HTTP ${err.status}）`;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/load failed|failed to fetch|networkerror|network|stream cut|terminated|aborted/i.test(message)) {
    return "通信が切れました（アプリの切り替え・画面オフ・電波・サーバーの時間切れなど）。再接続も失敗しました";
  }
  return message;
}

export function proxyUrl(
  item: Pick<MediaItem, "src" | "pageUrl" | "referer">,
  opts: { download?: boolean; name?: string } = {},
) {
  // iframe の中のプレーヤーで見つけた動画は、そのプレーヤーのページを Referer にしないと断られることがある
  const p = new URLSearchParams({ url: item.src, ref: item.referer ?? item.pageUrl });
  if (opts.download) p.set("dl", "1");
  if (opts.name) p.set("name", opts.name);
  return `/api/thumbs/media?${p}`;
}

const isHls = (item: MediaItem) => /\.m3u8(\?|$)/i.test(item.src) || item.format === "M3U8";
const isVideoLike = (item: MediaItem) => item.kind !== "image";

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function ThumbsApp() {
  const [input, setInput] = useState("");
  const [depth, setDepth] = useState(1);
  const [maxPages, setMaxPages] = useState(100);
  const [maxPagination, setMaxPagination] = useState(50);
  const [crossSite, setCrossSite] = useState(false);
  const [render, setRender] = useState<"auto" | "always" | "off">("auto");
  const [kinds, setKinds] = useState<"all" | "video" | "image">("all");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [jobFilter, setJobFilter] = useState<string | null>(null);
  const [viewer, setViewer] = useState<number | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [sites, setSites] = useState<SavedSite[]>([]);
  const [excludes, setExcludes] = useState<string[]>([]);
  const [now, setNow] = useState(0);
  const controllers = useRef(new Map<string, AbortController>());
  // 取得中にリストを変えても、次の通信から最新のリストが使われるよう ref にも持つ
  const excludesRef = useRef<string[]>([]);
  useEffect(() => {
    excludesRef.current = excludes;
  }, [excludes]);
  const loaded = useRef(false);

  // --- 前回の一覧を復元 / 保存（ブラウザの localStorage） ---
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
      // サーバー描画と食い違わないよう、保存データの復元は表示後に 1 回だけ行う
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (saved?.items) setItems(saved.items);
      if (saved?.jobs) setJobs(saved.jobs.map((j: Job) => (j.status === "running" ? { ...j, status: "stopped" } : j)));
      const library = JSON.parse(localStorage.getItem(LIBRARY_KEY) ?? "null");
      if (Array.isArray(library?.history)) setHistory(library.history);
      if (Array.isArray(library?.sites)) setSites(library.sites.slice(0, MAX_SITES));
      if (Array.isArray(library?.excludes)) setExcludes(library.excludes.slice(0, MAX_EXCLUDES));
    } catch {
      /* ignore */
    }
    setNow(Date.now());
    loaded.current = true;
  }, []);
  // 一覧の保存。変化が続く間は 0.5 秒待ってまとめて保存し、画面が隠れる（アプリ切り替え・閉じる）ときはすぐ保存する
  const latest = useRef({ items, jobs });
  const dirty = useRef(false);
  const saveNow = useCallback(() => {
    if (!loaded.current || !dirty.current) return;
    dirty.current = false;
    try {
      // 途中経過は大きいので、新しい 5 件のジョブ分だけ保存する
      let kept = 0;
      const slimJobs = latest.current.jobs.map((j) => (j.resume && kept++ < 5 ? j : { ...j, resume: undefined }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ items: latest.current.items.slice(0, MAX_ITEMS), jobs: slimJobs }));
    } catch {
      /* 容量オーバーなどは無視 */
    }
  }, []);
  useEffect(() => {
    if (!loaded.current) return;
    latest.current = { items, jobs };
    dirty.current = true;
    const t = setTimeout(saveNow, 500);
    return () => clearTimeout(t);
  }, [items, jobs, saveNow]);
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") saveNow();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", saveNow);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", saveNow);
    };
  }, [saveNow]);
  useEffect(() => {
    if (!loaded.current) return;
    try {
      localStorage.setItem(LIBRARY_KEY, JSON.stringify({ history, sites, excludes }));
    } catch {
      /* ignore */
    }
  }, [history, sites, excludes]);

  /** 履歴の先頭に入れる（同じ URL があれば置き換え） */
  const recordHistory = useCallback((entry: HistoryEntry) => {
    setHistory((list) => [entry, ...list.filter((h) => h.url !== entry.url)].slice(0, MAX_HISTORY));
  }, []);

  const updateJob = useCallback((id: string, patch: Partial<Job> | ((j: Job) => Partial<Job>)) => {
    setJobs((list) => list.map((j) => (j.id === id ? { ...j, ...(typeof patch === "function" ? patch(j) : patch) } : j)));
  }, []);

  const startJob = useCallback(
    async (url: string, override?: CrawlSettings, existing?: { job: Job; found: number }) => {
      let settings: CrawlSettings = existing?.job.settings ?? override ?? { depth, maxPages, maxPagination, crossSite, render, kinds };
      // ページ数の上限で打ち切ったものを続けるときは、同じページ数だけ上限を足す
      if (existing?.job.truncated && existing.job.resume) {
        settings = { ...settings, maxPages: Math.min(1000, existing.job.resume.pages + settings.maxPages) };
      }
      const id = existing?.job.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const controller = new AbortController();
      controllers.current.set(id, controller);
      if (existing) {
        updateJob(id, { status: "running", message: undefined, note: undefined, truncated: false, settings });
      } else {
        setJobs((list) => [{ id, url, status: "running", pages: 0, errors: 0, settings }, ...list]);
      }
      let pageCount = existing?.job.pages ?? 0;
      let foundCount = existing?.found ?? 0;
      const startedAt = Date.now();
      recordHistory({ url, at: startedAt, pages: pageCount, found: foundCount, settings });

      try {
        // サーバーは 1 回に動ける時間に上限があるので、「続き」が返ってきたら送り返して再開してもらう。
        // 通信が途中で切れたら、同じところから最大 3 回までやり直す
        let current: CrawlState | undefined = existing?.job.resume;
        /** 届いた中で一番新しい途中経過（再接続はここから） */
        let latest: CrawlState | undefined = current;
        let retries = 0;
        for (;;) {
          let next: CrawlState | undefined;
          let finished = false;
          try {
            const res = await fetch("/api/thumbs/crawl", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ url, ...settings, exclude: excludesRef.current, resume: current }),
              signal: controller.signal,
            });
            if (res.status >= 500) throw new ServerError(res.status);
            if (!res.ok || !res.body) {
              const data = await res.json().catch(() => ({}));
              updateJob(id, { status: "error", message: data.error ?? `エラー（HTTP ${res.status}）` });
              return;
            }
            // ストリームを 1 行ずつ読み、届いたものからすぐ画面に追加する
            const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
            let buffer = "";
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += value;
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";
              for (const line of lines) {
                if (!line.trim()) continue;
                const event = JSON.parse(line) as CrawlEvent;
                if (event.type === "page") {
                  pageCount++;
                  updateJob(id, (j) => ({ pages: j.pages + 1 }));
                } else if (event.type === "error") updateJob(id, (j) => ({ errors: j.errors + 1, message: event.message }));
                else if (event.type === "done") {
                  finished = true;
                  updateJob(id, { status: "done", truncated: event.truncated, resume: event.state });
                } else if (event.type === "continue" || event.type === "checkpoint") {
                  if (event.type === "continue") next = event.state;
                  latest = event.state;
                  updateJob(id, { resume: event.state });
                }
                else if (event.type === "note") updateJob(id, { note: event.message });
                else if (event.type === "media") {
                  foundCount += event.items.length;
                  setItems((list) => {
                    const known = new Set(list.map((i) => i.id));
                    const fresh = event.items
                      .filter((i) => !known.has(i.id) && !isItemExcluded(i, excludesRef.current))
                      .map((i) => ({ ...i, jobId: id }));
                    return fresh.length ? [...list, ...fresh].slice(-MAX_ITEMS) : list;
                  });
                }
              }
            }
            // 「終わり」も「続き」も届かずに切れた＝途中で通信が切れた
            if (!finished && !next) throw new Error("stream cut");
          } catch (err) {
            if (controller.signal.aborted) throw err;
            if (retries >= 3) throw err;
            retries++;
            updateJob(id, { message: `通信が切れたので再接続しています（${retries}/3）` });
            await new Promise((r) => setTimeout(r, 2000 * retries));
            current = latest;
            continue; // 最後の途中経過からやり直す（重複した画像は一覧に二重に入らない）
          }
          if (retries) updateJob(id, { message: undefined });
          retries = 0;
          if (!next || controller.signal.aborted) break;
          current = next;
        }
        updateJob(id, (j) => (j.status === "running" ? { status: "done" } : {}));
      } catch (err) {
        if (controller.signal.aborted) updateJob(id, { status: "stopped" });
        else updateJob(id, { status: "error", message: describeError(err) });
      } finally {
        controllers.current.delete(id);
        recordHistory({ url, at: startedAt, pages: pageCount, found: foundCount, settings });
      }
    },
    [depth, maxPages, maxPagination, crossSite, render, kinds, updateJob, recordHistory],
  );

  const resumeJob = useCallback(
    (job: Job) => {
      if (controllers.current.has(job.id)) return;
      void startJob(job.url, job.settings, { job, found: items.filter((i) => i.jobId === job.id).length });
    },
    [startJob, items],
  );

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // 改行・スペース区切りで複数 URL をまとめて入れられる
    const urls = input
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (/^https?:\/\//i.test(s) ? s : `https://${s}`));
    const valid = urls.filter((u) => {
      try {
        new URL(u);
        return true;
      } catch {
        return false;
      }
    });
    if (!valid.length) {
      setFormError("URL を入力してください（例: https://example.com/gallery/）");
      return;
    }
    setFormError(null);
    setInput("");
    for (const u of valid) void startJob(u);
  };

  /** 除外リストに追加し、すでに一覧にある該当の画像・動画も消す */
  const addExclude = useCallback((input: string): boolean => {
    const rule = normalizeRule(input);
    if (!rule) return false;
    setExcludes((list) => (list.includes(rule) ? list : [...list, rule].slice(-MAX_EXCLUDES)));
    setItems((list) => list.filter((i) => !isItemExcluded(i, [rule])));
    return true;
  }, []);
  const removeExclude = (rule: string) => setExcludes((list) => list.filter((r) => r !== rule));

  const saveSite = (url: string, settings: CrawlSettings) => {
    setSites((list) => (list.some((s) => s.url === url) || list.length >= MAX_SITES ? list : [...list, { url, settings }]));
  };
  const removeSite = (url: string) => setSites((list) => list.filter((s) => s.url !== url));

  const stopJob = (id: string) => controllers.current.get(id)?.abort();
  const removeJob = (id: string) => {
    stopJob(id);
    setJobs((l) => l.filter((j) => j.id !== id));
    setItems((l) => l.filter((i) => i.jobId !== id));
    if (jobFilter === id) setJobFilter(null);
  };
  const clearAll = () => {
    if (!confirm("一覧をすべて消しますか？")) return;
    controllers.current.forEach((c) => c.abort());
    setJobs([]);
    setItems([]);
    setJobFilter(null);
  };

  const hideItem = useCallback((id: string) => setItems((l) => l.filter((i) => i.id !== id)), []);

  const visible = useMemo(
    () =>
      items.filter(
        (i) =>
          (filter === "all" || (filter === "image" ? i.kind === "image" : i.kind !== "image")) &&
          (!jobFilter || i.jobId === jobFilter),
      ),
    [items, filter, jobFilter],
  );
  const counts = useMemo(() => {
    const scoped = jobFilter ? items.filter((i) => i.jobId === jobFilter) : items;
    const video = scoped.filter(isVideoLike).length;
    return { all: scoped.length, image: scoped.length - video, video };
  }, [items, jobFilter]);

  const running = jobs.some((j) => j.status === "running");
  const foundByJob = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of items) m.set(i.jobId, (m.get(i.jobId) ?? 0) + 1);
    return m;
  }, [items]);

  return (
    <div className="min-h-screen bg-neutral-50 pb-16 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="sticky top-0 z-30 border-b border-neutral-200 bg-white/90 backdrop-blur-md dark:border-neutral-800 dark:bg-neutral-950/90">
        <div className="mx-auto max-w-6xl px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
          <div className="mb-2 flex items-center justify-between">
            <h1 className="flex items-center gap-2 text-lg font-black tracking-tight">
              <Link href="/apps" aria-label="アプリ一覧へ" className="text-sm font-semibold text-neutral-400">
                ‹ アプリ
              </Link>
              <span>
                <span className="mr-1">🖼️</span>サムネ収集
              </span>
            </h1>
            {items.length > 0 && (
              <button type="button" onClick={clearAll} className="text-xs font-semibold text-neutral-400 hover:text-red-500">
                すべて消す
              </button>
            )}
          </div>
          <form onSubmit={onSubmit} className="flex gap-2">
            <input
              type="url"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="https://example.com/gallery/"
              className="min-w-0 flex-1 rounded-full border border-neutral-200 bg-neutral-50 px-4 py-2.5 text-[16px] outline-none focus:border-fuchsia-400 focus:bg-white dark:border-neutral-700 dark:bg-neutral-900"
            />
            <button
              type="submit"
              className="shrink-0 rounded-full bg-fuchsia-500 px-5 py-2.5 text-sm font-bold text-white shadow-sm shadow-fuchsia-500/30 active:scale-95"
            >
              取得
            </button>
          </form>
          {formError && <p className="mt-1.5 text-xs text-red-500">{formError}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-500">
            <label className="flex items-center gap-1.5">
              取得する種類
              <select value={kinds} onChange={(e) => setKinds(e.target.value as "all" | "video" | "image")} className="rounded-md border border-neutral-200 bg-white px-1.5 py-1 dark:border-neutral-700 dark:bg-neutral-900">
                <option value="all">すべて</option>
                <option value="video">動画のみ</option>
                <option value="image">画像のみ</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              下の階層
              <select value={depth} onChange={(e) => setDepth(Number(e.target.value))} className="rounded-md border border-neutral-200 bg-white px-1.5 py-1 dark:border-neutral-700 dark:bg-neutral-900">
                {[0, 1, 2, 3, 5, 10, 15, 20].map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? "辿らない" : `${n}階層`}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              ページ送り
              <select value={maxPagination} onChange={(e) => setMaxPagination(Number(e.target.value))} className="rounded-md border border-neutral-200 bg-white px-1.5 py-1 dark:border-neutral-700 dark:bg-neutral-900">
                {[0, 10, 30, 50].map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? "しない" : `${n}ページまで`}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              全体で最大
              <select value={maxPages} onChange={(e) => setMaxPages(Number(e.target.value))} className="rounded-md border border-neutral-200 bg-white px-1.5 py-1 dark:border-neutral-700 dark:bg-neutral-900">
                {[30, 100, 300, 1000].map((n) => (
                  <option key={n} value={n}>
                    {n}ページ
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              ブラウザで開く
              <select value={render} onChange={(e) => setRender(e.target.value as "auto" | "always" | "off")} className="rounded-md border border-neutral-200 bg-white px-1.5 py-1 dark:border-neutral-700 dark:bg-neutral-900">
                <option value="auto">自動</option>
                <option value="always">常に（遅い）</option>
                <option value="off">使わない</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={crossSite}
                onChange={(e) => setCrossSite(e.target.checked)}
                className="h-4 w-4 accent-fuchsia-500"
              />
              別のサイトへのリンクも辿る
            </label>
            {running && <span className="animate-pulse font-semibold text-fuchsia-500">取得中…</span>}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4">
        <Library
          sites={sites}
          history={history}
          excludes={excludes}
          onAddExclude={addExclude}
          onRemoveExclude={removeExclude}
          now={now}
          onRun={(url, settings) => void startJob(url, settings)}
          onSave={saveSite}
          onRemoveSite={removeSite}
          onRemoveHistory={(url) => setHistory((list) => list.filter((h) => h.url !== url))}
          onClearHistory={() => confirm("履歴をすべて消しますか？") && setHistory([])}
        />
        {jobs.length > 0 && (
          <ul className="mt-3 flex flex-col gap-1.5">
            {jobs.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                found={foundByJob.get(job.id) ?? 0}
                active={jobFilter === job.id}
                onSelect={() => setJobFilter(jobFilter === job.id ? null : job.id)}
                onStop={() => stopJob(job.id)}
                onResume={() => resumeJob(job)}
                saved={sites.some((s) => s.url === job.url)}
                canSave={sites.length < MAX_SITES}
                onSave={() => saveSite(job.url, job.settings ?? { depth, maxPages, maxPagination, crossSite, render, kinds })}
                onRemove={() => removeJob(job.id)}
              />
            ))}
          </ul>
        )}

        {items.length > 0 && (
          <div className="mt-3 flex gap-2 py-1">
            {(
              [
                ["all", "すべて"],
                ["image", "🖼 画像"],
                ["video", "🎬 動画"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                className={`rounded-full px-3.5 py-1.5 text-xs font-bold transition ${
                  filter === value
                    ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
                    : "bg-neutral-200/70 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                }`}
              >
                {label} <span className="opacity-60">{counts[value]}</span>
              </button>
            ))}
          </div>
        )}

        {items.length === 0 && jobs.length === 0 && <EmptyState />}

        <ul className="mt-2 grid grid-cols-3 gap-1.5 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
          {visible.map((item, index) => (
            <li key={item.id}>
              <Thumb item={item} onOpen={() => setViewer(index)} onBroken={hideItem} />
            </li>
          ))}
        </ul>
        {items.length > 0 && visible.length === 0 && (
          <p className="mt-10 text-center text-sm text-neutral-400">この条件に合うものはありません</p>
        )}
      </main>

      {viewer !== null && visible[viewer] && (
        <Viewer
          items={visible}
          index={viewer}
          onIndex={setViewer}
          onClose={() => setViewer(null)}
          onExclude={(host) => {
            if (!confirm(`${host} を除外リストに追加して、一覧から消しますか？\n（次からこのサイトは取得しません）`)) return;
            setViewer(null);
            addExclude(host);
          }}
        />
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mx-auto mt-12 max-w-md text-center text-sm leading-relaxed text-neutral-500">
      <p className="text-4xl">🔎</p>
      <p className="mt-3 font-semibold text-neutral-700 dark:text-neutral-300">URL を入れると、その先の画像・動画のサムネイルを集めます</p>
      <ul className="mt-4 space-y-1.5 text-left text-xs">
        <li>・続けて別の URL を入れると、一覧にどんどん追加されます（改行区切りでまとめて入力も可）</li>
        <li>・「下の階層」を選ぶと、入力したページより下のページもリンクを辿って集めます（最大20階層）</li>
        <li>・「ページ送り」で、2ページ目・次へ などの続きのページも集めます（最大50ページ）</li>
        <li>・「別のサイトへのリンクも辿る」にすると、リンク先の別サイトからも集めます</li>
        <li>・JavaScript で画像を後から出すサイトは、自動でブラウザで開いて集めます（少し時間がかかります）</li>
        <li>・取得した URL は履歴に残り、よく使うサイトは ☆ で 5 個まで登録できます</li>
        <li>・🎬 は動画、🖼 は画像。タップで再生・拡大、ダウンロードもできます</li>
        <li>・サムネイルのない動画は、動画から 1 コマ取り出してサムネイルを作ります（この端末に保存）</li>
        <li>・一覧はこの端末のブラウザに保存されます</li>
      </ul>
    </div>
  );
}

function JobRow({
  job,
  onResume,
  found,
  saved,
  canSave,
  onSave,
  active,
  onSelect,
  onStop,
  onRemove,
}: {
  job: Job;
  onResume: () => void;
  found: number;
  saved: boolean;
  canSave: boolean;
  onSave: () => void;
  active: boolean;
  onSelect: () => void;
  onStop: () => void;
  onRemove: () => void;
}) {
  const status =
    job.status === "running"
      ? `取得中… ${job.pages}ページ`
      : job.status === "error"
        ? job.message ?? "エラー"
        : job.status === "stopped"
          ? `停止（${job.pages}ページ）`
          : `${job.pages}ページ${job.truncated ? "（上限で打ち切り）" : ""}`;
  return (
    <li
      className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-xs transition ${
        active
          ? "border-fuchsia-400 bg-fuchsia-50 dark:bg-fuchsia-950/30"
          : "border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900"
      }`}
    >
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${
          job.status === "running" ? "animate-pulse bg-fuchsia-500" : job.status === "error" ? "bg-red-500" : "bg-emerald-500"
        }`}
      />
      <button type="button" onClick={onSelect} className="min-w-0 flex-1 text-left" title="この URL の結果だけ表示">
        <span className="block truncate font-semibold">{job.url.replace(/^https?:\/\//, "")}</span>
        <span className={`block truncate ${job.status === "error" ? "text-red-500" : "text-neutral-400"}`}>
          {status} ・ {found}件
        </span>
        {job.note && <span className="block truncate text-amber-600 dark:text-amber-400">⚠ {job.note}</span>}
      </button>
      <button
        type="button"
        onClick={onSave}
        disabled={saved || !canSave}
        aria-label={saved ? "登録済み" : "このサイトを登録"}
        title={saved ? "登録済み" : canSave ? "このサイトを登録" : "登録は5個までです"}
        className={`shrink-0 px-1 text-base ${saved ? "text-amber-400" : "text-neutral-300 hover:text-amber-400 disabled:opacity-40"}`}
      >
        {saved ? "★" : "☆"}
      </button>
      {(job.status === "stopped" || job.status === "error" || (job.status === "done" && job.truncated && job.resume)) && (
        <button
          type="button"
          onClick={onResume}
          className="shrink-0 rounded-full bg-fuchsia-500 px-2.5 py-1 font-semibold text-white"
          title={job.resume ? "止まったところから再開" : "最初からやり直す"}
        >
          ▶ {job.resume ? "続きから" : "やり直す"}
        </button>
      )}
      {job.status === "running" ? (
        <button type="button" onClick={onStop} className="shrink-0 rounded-full bg-neutral-100 px-2.5 py-1 font-semibold dark:bg-neutral-800">
          停止
        </button>
      ) : (
        <button type="button" onClick={onRemove} aria-label="削除" className="shrink-0 px-1.5 text-base text-neutral-400 hover:text-red-500">
          ×
        </button>
      )}
    </li>
  );
}

/**
 * サムネイル 1 枚。
 * - 画像・サムネイルは、まず元サイトから直接読み込み（referrerPolicy=no-referrer で直リンク制限を避ける）、
 *   失敗したらサーバー中継で再挑戦。画像がそれでも駄目なら一覧から外す
 * - サムネイルのない動画（または読み込めなかった動画）は、画面に見えたら動画から 1 コマ取り出して作る
 */
function Thumb({ item, onOpen, onBroken }: { item: Item; onOpen: () => void; onBroken: (id: string) => void }) {
  const imageSrc = item.kind === "image" ? item.src : item.thumb;
  const [attempt, setAttempt] = useState(0);
  const [imgFailed, setImgFailed] = useState(false);
  const [captured, setCaptured] = useState<string | null | undefined>(() => peekVideoThumb(item.src));
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const video = isVideoLike(item);
  const needCapture = item.kind === "video" && !isHls(item) && (!imageSrc || imgFailed) && captured === undefined;
  const proxied = proxyUrl(item);

  // 画面に入ったら（少し手前から）作り始める。一度見えたら覚えておく
  useEffect(() => {
    if (!needCapture || visible) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [needCapture, visible]);

  useEffect(() => {
    if (!needCapture || !visible) return;
    let alive = true;
    void getVideoThumb(item.src, proxied).then((result) => {
      if (alive) setCaptured(result);
    });
    return () => {
      alive = false;
    };
  }, [needCapture, visible, item.src, proxied]);

  const onError = () => {
    if (attempt === 0) setAttempt(1);
    else if (item.kind === "image") onBroken(item.id);
    else setImgFailed(true);
  };

  let media: React.ReactNode;
  if (imageSrc && !imgFailed) {
    const src = attempt === 0 ? imageSrc : proxyUrl({ src: imageSrc, pageUrl: item.pageUrl });
    media = (
      // eslint-disable-next-line @next/next/no-img-element -- 外部サイトの任意の画像を出すため next/image は使わない
      <img
        src={src}
        alt={item.title ?? ""}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={onError}
        onLoad={(e) => {
          const img = e.currentTarget;
          // アイコンなどの小さすぎる画像は一覧から外す
          if (item.kind === "image" && img.naturalWidth < 48 && img.naturalHeight < 48) onBroken(item.id);
        }}
        className="h-full w-full object-cover"
      />
    );
  } else if (captured) {
    // eslint-disable-next-line @next/next/no-img-element -- 端末の中で作った画像（data URL）
    media = <img src={captured} alt={item.title ?? ""} className="h-full w-full object-cover" />;
  } else {
    media = (
      <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-gradient-to-br from-neutral-700 to-neutral-900 text-white">
        <span className={`text-2xl ${needCapture ? "animate-pulse" : ""}`}>🎬</span>
        {needCapture && <span className="text-[9px] opacity-60">サムネ作成中</span>}
      </div>
    );
  }

  return (
    <button
      ref={ref}
      type="button"
      onClick={onOpen}
      className="group relative block aspect-square w-full overflow-hidden rounded-lg bg-neutral-200 active:scale-[0.97] dark:bg-neutral-800"
    >
      {media}
      <span
        className={`absolute left-1 top-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold text-white shadow ${
          video ? "bg-red-500/90" : "bg-sky-500/90"
        }`}
      >
        {video ? "🎬 動画" : "🖼 画像"}
      </span>
      {item.format && (
        <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1 py-0.5 text-[9px] font-semibold text-white">
          {item.format}
        </span>
      )}
      {video && (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-sm">▶</span>
        </span>
      )}
    </button>
  );
}

function Viewer({
  items,
  index,
  onIndex,
  onClose,
  onExclude,
}: {
  items: Item[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  onExclude: (host: string) => void;
}) {
  const item = items[index];
  const [useProxy, setUseProxy] = useState(false);
  /** 再生・表示できなかった理由（サーバー経由でも駄目だったとき、調べて出す） */
  const [playError, setPlayError] = useState<string | null>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);

  const go = useCallback(
    (delta: number) => {
      const next = index + delta;
      if (next >= 0 && next < items.length) {
        setUseProxy(false);
        setPlayError(null);
        onIndex(next);
      }
    },
    [index, items.length, onIndex],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [go, onClose]);

  const direct = item.src;
  const src = useProxy ? proxyUrl(item) : direct;
  const canDownload = item.kind !== "embed" && !isHls(item);
  const fileName = decodeURIComponent(new URL(item.src).pathname.split("/").pop() || "") || undefined;

  /** 直接もサーバー経由も駄目だったとき、サーバー経由で少しだけ取りに行って理由を調べる */
  const diagnose = async () => {
    try {
      const res = await fetch(proxyUrl(item), { headers: { range: "bytes=0-1" } });
      if (!res.ok) {
        const text = (await res.text().catch(() => "")).slice(0, 120);
        const expired = /HTTP (403|404|410)/.test(text);
        setPlayError(
          `再生できませんでした：${text || `HTTP ${res.status}`}` +
            (expired ? "\n期限付きの URL だった可能性があります。もう一度取得し直すと再生できることがあります。" : ""),
        );
      } else {
        const type = res.headers.get("content-type") ?? "不明";
        setPlayError(`動画のデータは届いていますが、この端末では再生できない形式です（${type}）。「動画を直接開く」か「ダウンロード」を試してください。`);
      }
    } catch {
      setPlayError("通信できませんでした。電波の状態を確認してください。");
    }
  };

  let body: React.ReactNode;
  if (item.kind === "embed") {
    body = (
      <iframe
        key={item.id}
        src={`${item.src}${item.src.includes("?") ? "&" : "?"}autoplay=1&playsinline=1`}
        title={item.title ?? "動画"}
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        allowFullScreen
        className="aspect-video w-full max-w-4xl rounded-lg bg-black"
      />
    );
  } else if (item.kind === "video") {
    body = (
      <video
        key={`${item.id}-${useProxy}`}
        src={src}
        poster={item.thumb ?? peekVideoThumb(item.src) ?? undefined}
        controls
        autoPlay
        playsInline
        onError={() => {
          // まず元サイトから直接 → 駄目ならサーバー経由 → それも駄目なら理由を調べて表示
          if (!useProxy && !isHls(item)) setUseProxy(true);
          else void diagnose();
        }}
        className="max-h-full max-w-full rounded-lg bg-black"
      />
    );
  } else {
    body = (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        key={`${item.id}-${useProxy}`}
        src={src}
        alt={item.title ?? ""}
        referrerPolicy="no-referrer"
        onError={() => !useProxy && setUseProxy(true)}
        className="max-h-full max-w-full object-contain"
      />
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black text-white"
      role="dialog"
      aria-modal="true"
      onTouchStart={(e) => (touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY })}
      onTouchEnd={(e) => {
        if (!touch.current) return;
        const dx = e.changedTouches[0].clientX - touch.current.x;
        const dy = e.changedTouches[0].clientY - touch.current.y;
        touch.current = null;
        // 横スワイプで前後、下スワイプで閉じる
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
        else if (dy > 100 && Math.abs(dy) > Math.abs(dx) * 1.5) onClose();
      }}
    >
      <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))] text-xs">
        <span className="rounded-md bg-white/10 px-2 py-1 font-semibold">
          {item.kind === "image" ? "🖼 画像" : "🎬 動画"}
          {item.format ? ` ・ ${item.format}` : ""}
        </span>
        <span className="opacity-60">
          {index + 1} / {items.length}
        </span>
        <button type="button" onClick={onClose} aria-label="閉じる" className="h-9 w-9 rounded-full bg-white/10 text-lg">
          ×
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center px-2">
        {body}
        {index > 0 && (
          <button
            type="button"
            onClick={() => go(-1)}
            aria-label="前へ"
            className="absolute left-2 top-1/2 hidden h-10 w-10 -translate-y-1/2 rounded-full bg-white/10 sm:block"
          >
            ‹
          </button>
        )}
        {index < items.length - 1 && (
          <button
            type="button"
            onClick={() => go(1)}
            aria-label="次へ"
            className="absolute right-2 top-1/2 hidden h-10 w-10 -translate-y-1/2 rounded-full bg-white/10 sm:block"
          >
            ›
          </button>
        )}
      </div>

      <div className="space-y-2 px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
        {playError && (
          <div className="whitespace-pre-line rounded-lg bg-red-500/20 px-3 py-2 text-xs text-red-200">
            ⚠ {playError}
            <a href={item.src} target="_blank" rel="noopener noreferrer" className="mt-1 block font-semibold underline">
              ▶ 動画を直接開く
            </a>
          </div>
        )}
        {item.title && <p className="line-clamp-2 text-sm">{item.title}</p>}
        <p className="truncate text-[11px] opacity-50">{hostOf(item.pageUrl)}</p>
        <div className="flex gap-2">
          {canDownload ? (
            <a
              href={proxyUrl(item, { download: true, name: fileName })}
              download={fileName ?? true}
              className="flex-1 rounded-full bg-fuchsia-500 py-2.5 text-center text-sm font-bold"
            >
              ⬇ ダウンロード
            </a>
          ) : (
            <span className="flex-1 rounded-full bg-white/10 py-2.5 text-center text-xs opacity-70">
              {item.kind === "embed" ? "埋め込み動画は保存できません" : "配信形式（HLS）のため保存できません"}
            </span>
          )}
          <button
            type="button"
            onClick={() => onExclude(hostOf(item.pageUrl))}
            className="rounded-full bg-white/10 px-3 py-2.5 text-sm font-semibold"
            title="このサイトを除外リストに追加"
          >
            🚫 除外
          </button>
          <a
            href={item.pageUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full bg-white/10 px-4 py-2.5 text-sm font-semibold"
          >
            元ページ
          </a>
        </div>
      </div>
    </div>
  );
}
