"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CrawlEvent, MediaItem } from "@/lib/thumbs/types";

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
}

type Filter = "all" | "image" | "video";

const STORAGE_KEY = "thumbs:v1";
const MAX_ITEMS = 3000;

export function proxyUrl(item: Pick<MediaItem, "src" | "pageUrl">, opts: { download?: boolean; name?: string } = {}) {
  const p = new URLSearchParams({ url: item.src, ref: item.pageUrl });
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
  const [maxPages, setMaxPages] = useState(30);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [jobFilter, setJobFilter] = useState<string | null>(null);
  const [viewer, setViewer] = useState<number | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const controllers = useRef(new Map<string, AbortController>());
  const loaded = useRef(false);

  // --- 前回の一覧を復元 / 保存（ブラウザの localStorage） ---
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
      // サーバー描画と食い違わないよう、保存データの復元は表示後に 1 回だけ行う
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (saved?.items) setItems(saved.items);
      if (saved?.jobs) setJobs(saved.jobs.map((j: Job) => (j.status === "running" ? { ...j, status: "stopped" } : j)));
    } catch {
      /* ignore */
    }
    loaded.current = true;
  }, []);
  useEffect(() => {
    if (!loaded.current) return;
    const t = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ items: items.slice(0, MAX_ITEMS), jobs }));
      } catch {
        /* 容量オーバーなどは無視 */
      }
    }, 500);
    return () => clearTimeout(t);
  }, [items, jobs]);

  const updateJob = useCallback((id: string, patch: Partial<Job> | ((j: Job) => Partial<Job>)) => {
    setJobs((list) => list.map((j) => (j.id === id ? { ...j, ...(typeof patch === "function" ? patch(j) : patch) } : j)));
  }, []);

  const startJob = useCallback(
    async (url: string) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const controller = new AbortController();
      controllers.current.set(id, controller);
      setJobs((list) => [{ id, url, status: "running", pages: 0, errors: 0 }, ...list]);

      try {
        const res = await fetch("/api/thumbs/crawl", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url, depth, maxPages }),
          signal: controller.signal,
        });
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
            if (event.type === "page") updateJob(id, (j) => ({ pages: j.pages + 1 }));
            else if (event.type === "error") updateJob(id, (j) => ({ errors: j.errors + 1, message: event.message }));
            else if (event.type === "done") updateJob(id, { status: "done", truncated: event.truncated });
            else if (event.type === "media") {
              setItems((list) => {
                const known = new Set(list.map((i) => i.id));
                const fresh = event.items.filter((i) => !known.has(i.id)).map((i) => ({ ...i, jobId: id }));
                return fresh.length ? [...list, ...fresh].slice(-MAX_ITEMS) : list;
              });
            }
          }
        }
        updateJob(id, (j) => (j.status === "running" ? { status: "done" } : {}));
      } catch (err) {
        if (controller.signal.aborted) updateJob(id, { status: "stopped" });
        else updateJob(id, { status: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        controllers.current.delete(id);
      }
    },
    [depth, maxPages, updateJob],
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
              下の階層
              <select
                value={depth}
                onChange={(e) => setDepth(Number(e.target.value))}
                className="rounded-md border border-neutral-200 bg-white px-1.5 py-1 dark:border-neutral-700 dark:bg-neutral-900"
              >
                <option value={0}>辿らない</option>
                <option value={1}>1階層</option>
                <option value={2}>2階層</option>
                <option value={3}>3階層</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              最大
              <select
                value={maxPages}
                onChange={(e) => setMaxPages(Number(e.target.value))}
                className="rounded-md border border-neutral-200 bg-white px-1.5 py-1 dark:border-neutral-700 dark:bg-neutral-900"
              >
                {[10, 30, 60, 100].map((n) => (
                  <option key={n} value={n}>
                    {n}ページ
                  </option>
                ))}
              </select>
            </label>
            {running && <span className="animate-pulse font-semibold text-fuchsia-500">取得中…</span>}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4">
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
        <li>・「下の階層」を選ぶと、入力したページより下のページもリンクを辿って集めます</li>
        <li>・🎬 は動画、🖼 は画像。タップで再生・拡大、ダウンロードもできます</li>
        <li>・一覧はこの端末のブラウザに保存されます</li>
      </ul>
    </div>
  );
}

function JobRow({
  job,
  found,
  active,
  onSelect,
  onStop,
  onRemove,
}: {
  job: Job;
  found: number;
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
      </button>
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
 * まず元サイトから直接読み込み（referrerPolicy=no-referrer で直リンク制限を避ける）、
 * 失敗したらサーバー中継で再挑戦、それもダメなら一覧から外す。
 */
function Thumb({ item, onOpen, onBroken }: { item: Item; onOpen: () => void; onBroken: (id: string) => void }) {
  const imageSrc = item.kind === "image" ? item.src : item.thumb;
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const video = isVideoLike(item);

  const onError = () => {
    if (attempt === 0) setAttempt(1);
    else if (item.kind === "image") onBroken(item.id);
    else setFailed(true);
  };

  let media: React.ReactNode;
  if (imageSrc && !failed) {
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
  } else if (item.kind === "video" && !isHls(item) && !failed) {
    // ポスター画像がない動画は、動画の冒頭フレームをサムネイル代わりにする
    const src = attempt === 0 ? item.src : proxyUrl(item);
    media = (
      <video
        src={`${src}#t=0.5`}
        preload="metadata"
        muted
        playsInline
        onError={onError}
        className="pointer-events-none h-full w-full object-cover"
      />
    );
  } else {
    media = (
      <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-gradient-to-br from-neutral-700 to-neutral-900 text-white">
        <span className="text-2xl">🎬</span>
      </div>
    );
  }

  return (
    <button
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
}: {
  items: Item[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const item = items[index];
  const [useProxy, setUseProxy] = useState(false);
  const touch = useRef<{ x: number; y: number } | null>(null);

  const go = useCallback(
    (delta: number) => {
      const next = index + delta;
      if (next >= 0 && next < items.length) {
        setUseProxy(false);
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
        poster={item.thumb}
        controls
        autoPlay
        playsInline
        onError={() => !useProxy && !isHls(item) && setUseProxy(true)}
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
