"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KINDS, textLength, type AppState, type Post, type Site, type Video } from "@/lib/autopost/types";
import { api, card, ghost, input, primary, upload } from "./api";
import { Editor } from "./Editor";
import { ASPECTS, formatSize, formatTime, inspect, isNoop, runEdit, type Aspect, type Meta } from "./media";
import { MembersTab } from "./MembersTab";
import { SitesTab } from "./SitesTab";

type Tab = "compose" | "sites" | "members";
type Inspected = Meta & { thumb: string; frames: string[] };

/** いま扱っている動画。blob があるのは「まだ置き場に送っていない中身」があるとき（新しく選んだ・編集した） */
interface Current {
  videoId?: string;
  name: string;
  blob?: Blob;
  info?: Inspected;
}

const STATUS: Record<Post["status"], { label: string; className: string }> = {
  draft: { label: "下書き", className: "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300" },
  posting: { label: "投稿中…", className: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300" },
  posted: { label: "投稿済み", className: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" },
  failed: { label: "失敗", className: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300" },
};

function Setup({ setup }: { setup: AppState["setup"] }) {
  const items = [
    { ok: setup.db, text: "Supabase：環境変数（NEXT_PUBLIC_SUPABASE_URL・SUPABASE_SERVICE_ROLE_KEY）と、supabase/autopost.sql の実行", must: true },
    { ok: setup.secret, text: "AUTOPOST_SECRET：ログイン情報を暗号化する鍵（16 文字以上のでたらめな文字）", must: true },
    { ok: setup.ai, text: "ANTHROPIC_API_KEY：題名と本文を AI で作る鍵（なくても動きますが、文はメモの写しになります）", must: false },
  ];
  if (items.every((i) => i.ok)) return null;
  return (
    <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950/30">
      <p className="font-bold">⚙️ 使い始める前の設定（Vercel の環境変数）</p>
      <ul className="mt-2 space-y-1">
        {items.map((i) => (
          <li key={i.text} className={i.ok ? "text-neutral-500" : ""}>{i.ok ? "✅" : i.must ? "⬜" : "➖"} {i.text}</li>
        ))}
      </ul>
    </div>
  );
}

function PostCard({ post, site, video, busy, onChanged, onPublish }: { post: Post; site: Site; video?: Video; busy: boolean; onChanged: () => Promise<void>; onPublish: (post: Post) => Promise<void> }) {
  const info = KINDS[site.kind];
  const [title, setTitle] = useState(post.title);
  const [body, setBody] = useState(post.body);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  // AI で作り直したときなど、外から中身が変わったら入力欄も合わせる
  const [seen, setSeen] = useState(post);
  if (seen.title !== post.title || seen.body !== post.body) {
    setSeen(post);
    setTitle(post.title);
    setBody(post.body);
  }
  const dirty = title !== post.title || body !== post.body;
  const length = textLength(site.kind, body);
  const missing = site.rules.required.trim() && !body.includes(site.rules.required.trim());

  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const save = () => api("postSave", { id: post.id, title, body }).then(onChanged);
  const copy = (label: string, text: string) => navigator.clipboard.writeText(text).then(() => setCopied(label));
  const download = () =>
    run(async () => {
      const { url } = await api<{ url: string }>("videoUrl", { id: post.video_id });
      window.open(url, "_blank", "noopener");
    });

  return (
    <div className={card}>
      <div className="flex items-center gap-2">
        <span className="text-xl">{info.emoji}</span>
        <span className="min-w-0 flex-1 truncate font-bold">{site.name}</span>
        <span className={`rounded-full px-2 py-1 text-xs font-bold ${STATUS[post.status].className}`}>{STATUS[post.status].label}</span>
      </div>

      {info.usesTitle && (
        <label className="mt-3 block text-xs font-bold text-neutral-500">
          題名（{textLength(site.kind, title)}／{site.rules.titleMax}）
          <input value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => dirty && run(save)} className={`${input} mt-1 font-normal text-neutral-900 dark:text-neutral-100`} />
        </label>
      )}
      <label className="mt-3 block text-xs font-bold text-neutral-500">
        本文（<span className={length > site.rules.bodyMax ? "text-red-600" : ""}>{length}</span>／{site.rules.bodyMax}）
        <textarea value={body} onChange={(e) => setBody(e.target.value)} onBlur={() => dirty && run(save)} rows={Math.min(12, Math.max(4, body.split("\n").length + 1))} className={`${input} mt-1 font-normal text-neutral-900 dark:text-neutral-100`} />
      </label>
      {missing && <p className="mt-1 text-xs font-semibold text-amber-600">「必ず入れる文」が消えています。投稿するときに末尾へ足します。</p>}

      {post.status === "failed" && <p className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-red-50 p-2 text-xs font-semibold text-red-700 dark:bg-red-950/40 dark:text-red-300">{post.error}</p>}
      {error && <p className="mt-2 text-xs font-semibold text-red-600">{error}</p>}
      {post.status === "posted" && post.url && (
        <a href={post.url} target="_blank" rel="noopener noreferrer" className="mt-2 block truncate text-sm font-semibold text-fuchsia-600 underline">{post.url}</a>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {info.autoPost ? (
          <button type="button" disabled={busy || post.status === "posting" || !video?.path} onClick={() => run(async () => { if (dirty) await save(); await onPublish(post); })} className={primary}>
            {post.status === "posted" ? "🔁 もう一度投稿" : post.status === "failed" ? "🔁 やり直す" : "🚀 投稿する"}
          </button>
        ) : (
          <>
            {info.usesTitle && <button type="button" onClick={() => copy("題名", title)} className={ghost}>📋 題名{copied === "題名" ? " ✓" : ""}</button>}
            <button type="button" onClick={() => copy("本文", body)} className={ghost}>📋 本文{copied === "本文" ? " ✓" : ""}</button>
            <button type="button" onClick={download} className={ghost}>⬇️ 動画</button>
            {site.rules.postUrl && <a href={site.rules.postUrl} target="_blank" rel="noopener noreferrer" className={ghost}>↗ 投稿ページ</a>}
            {post.status !== "posted" ? (
              <button type="button" disabled={busy} onClick={() => run(() => api("postSave", { id: post.id, title, body, status: "posted" }).then(onChanged))} className={primary}>✓ 投稿済みにする</button>
            ) : (
              <button type="button" disabled={busy} onClick={() => run(() => api("postSave", { id: post.id, status: "draft" }).then(onChanged))} className={ghost}>下書きに戻す</button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function AutopostApp() {
  const [state, setState] = useState<AppState | null>(null);
  const [tab, setTab] = useState<Tab>("compose");
  const [notice, setNotice] = useState("");
  const [fatal, setFatal] = useState("");

  const [current, setCurrent] = useState<Current | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [memo, setMemo] = useState("");
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [autoAspect, setAutoAspect] = useState<Aspect>("original");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    try {
      setState(await api<AppState>("state"));
    } catch (e) {
      setFatal(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    // Google との連携から戻ってきたときの案内
    /* eslint-disable react-hooks/set-state-in-effect */
    if (params.get("tab") === "sites") setTab("sites");
    if (params.get("notice")) setNotice(params.get("notice")!);
    /* eslint-enable react-hooks/set-state-in-effect */
    if (params.size) window.history.replaceState(null, "", window.location.pathname);
    void reload();
  }, [reload]);

  // プレビュー用の URL（手元の中身があればそれ、なければ置き場から）
  useEffect(() => {
    let revoke = "";
    let cancelled = false;
    /* eslint-disable react-hooks/set-state-in-effect */
    if (current?.blob) {
      revoke = URL.createObjectURL(current.blob);
      setPreviewUrl(revoke);
    } else if (current?.videoId) {
      setPreviewUrl("");
      api<{ url: string }>("videoUrl", { id: current.videoId }).then(({ url }) => !cancelled && setPreviewUrl(url)).catch(() => {});
    } else setPreviewUrl("");
    /* eslint-enable react-hooks/set-state-in-effect */
    return () => {
      cancelled = true;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [current?.blob, current?.videoId]);

  const sites = useMemo(() => (state?.sites ?? []).filter((s) => s.enabled), [state]);
  const chosen = useMemo(() => sites.filter((s) => (picked ? picked.has(s.id) : true)), [sites, picked]);
  const video = state?.videos.find((v) => v.id === current?.videoId);
  const posts = (state?.posts ?? []).filter((p) => p.video_id === current?.videoId);
  const say = (line: string) => setLog((l) => [...l, line]);

  const pickFile = async (file: File) => {
    setError("");
    setLog([]);
    setEditing(false);
    setMemo("");
    setCurrent({ name: file.name, blob: file });
    try {
      const info = await inspect(file);
      setCurrent((c) => (c?.blob === file ? { ...c, info } : c));
    } catch (e) {
      setCurrent(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const pickVideo = (v: Video) => {
    setError("");
    setLog([]);
    setEditing(false);
    setMemo(v.memo);
    setCurrent({ videoId: v.id, name: v.name });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  /** 編集を始める。置き場にある動画は、いったん手元に取ってくる */
  const startEdit = async () => {
    if (!current) return;
    setError("");
    try {
      if (!current.blob) {
        setBusy(true);
        say("編集のために動画を読み込んでいます…");
        const { url } = await api<{ url: string }>("videoUrl", { id: current.videoId });
        const blob = await (await fetch(url)).blob();
        const info = await inspect(blob);
        setCurrent((c) => (c ? { ...c, blob, info } : c));
      }
      setEditing(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const applyEdit = async (edited: Blob) => {
    setEditing(false);
    const info = await inspect(edited);
    setCurrent((c) => (c ? { ...c, blob: edited, info, name: c.name.replace(/\.[^.]+$/, "") + ".mp4" } : c));
  };

  /** 手元の中身を置き場へ送って、動画の ID を返す */
  const ensureUploaded = async (cur: Current): Promise<string> => {
    if (!cur.blob) return cur.videoId!;
    const info = cur.info ?? (await inspect(cur.blob));
    const fields = { name: cur.name, memo, size: cur.blob.size, duration: info.duration, width: info.width, height: info.height, thumb: info.thumb, frames: info.frames };
    let id = cur.videoId;
    let target: { path: string; url: string };
    if (id) target = (await api<{ upload: typeof target }>("videoUploadUrl", { id })).upload;
    else {
      const created = await api<{ video: Video; upload: typeof target }>("videoCreate", fields);
      id = created.video.id;
      target = created.upload;
    }
    say(`置き場へ送っています…（${formatSize(cur.blob.size)}）`);
    await upload(target.url, cur.blob, () => {});
    await api("videoUpdate", { id, path: target.path, ...fields });
    setCurrent({ videoId: id, name: cur.name });
    return id;
  };

  /** 文を作る。auto なら、編集 → 送る → 文を作る → 投稿 まで続けて進む */
  const go = async (auto: boolean) => {
    if (!current) return;
    setBusy(true);
    setError("");
    setLog([]);
    try {
      let cur = current;
      if (auto && cur.blob && cur.info && autoAspect !== "original") {
        const spec = { start: 0, end: cur.info.duration, aspect: autoAspect, fit: "crop" as const, maxSide: 1080, mute: false };
        if (!isNoop(spec, cur.info)) {
          say("動画の形を整えています…");
          const edited = await runEdit(cur.blob, spec, cur.info, () => {});
          cur = { ...cur, blob: edited, info: await inspect(edited), name: cur.name.replace(/\.[^.]+$/, "") + ".mp4" };
        }
      }
      const videoId = await ensureUploaded(cur);
      if (!cur.blob && memo !== (video?.memo ?? "")) await api("videoUpdate", { id: videoId, memo });
      if (chosen.length === 0) {
        say("✅ 動画を登録しました（投稿先がまだないので、「投稿先」で足してください）");
        return;
      }
      say(`${chosen.length} 件の投稿先の題名と本文を作っています…`);
      const made = await api<{ posts: Post[]; ai: boolean }>("generate", { videoId, siteIds: chosen.map((s) => s.id) });
      say(made.ai ? "✅ 文ができました" : "✅ 仮の文を入れました（AI の鍵が未設定のため、メモの写しです）");
      if (auto) {
        for (const post of made.posts) {
          const site = chosen.find((s) => s.id === post.site_id);
          if (!site || !KINDS[site.kind].autoPost || !site.auto) continue;
          say(`${site.name} に投稿しています…`);
          const { post: done } = await api<{ post: Post }>("publish", { id: post.id });
          say(done.status === "posted" ? `✅ ${site.name} に投稿しました` : `⚠️ ${site.name}：${done.error}`);
        }
        say("おまかせが終わりました。下で結果を確かめてください");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      await reload();
      setBusy(false);
    }
  };

  const publishOne = async (post: Post) => {
    setBusy(true);
    try {
      await api("publish", { id: post.id });
    } finally {
      await reload();
      setBusy(false);
    }
  };

  const removeVideo = async (v: Video) => {
    if (!confirm(`「${v.name}」を消します。置き場の動画と、下書き・投稿の記録（会員サイトの掲載を含む）も消えます。`)) return;
    await api("videoDelete", { id: v.id }).catch((e) => setError(String(e.message ?? e)));
    if (current?.videoId === v.id) setCurrent(null);
    await reload();
  };

  if (fatal) return <main className="mx-auto max-w-2xl p-6 text-sm font-semibold text-red-600">{fatal}</main>;
  const autoCount = chosen.filter((s) => KINDS[s.kind].autoPost && s.auto).length;

  return (
    <div className="min-h-screen bg-neutral-50 pb-24 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="mx-auto max-w-2xl px-4 pt-[max(1.25rem,env(safe-area-inset-top))]">
        <Link href="/apps" className="text-xs font-semibold text-neutral-500">‹ アプリ一覧</Link>
        <h1 className="mt-1 text-2xl font-black tracking-tight">🚀 動画オート投稿</h1>
        <p className="mt-1 text-sm text-neutral-500">動画を選ぶだけで、投稿先ごとの題名と本文を作って投稿まで進めます。</p>
        <nav className="mt-4 flex gap-1 rounded-full bg-neutral-200/70 p-1 text-sm font-bold dark:bg-neutral-800">
          {([["compose", "投稿する"], ["sites", `投稿先（${state?.sites.length ?? 0}）`], ["members", `会員（${state?.members.length ?? 0}）`]] as const).map(([key, label]) => (
            <button key={key} type="button" onClick={() => setTab(key)} className={`flex-1 rounded-full px-3 py-2 ${tab === key ? "bg-white shadow dark:bg-neutral-950" : "text-neutral-500"}`}>{label}</button>
          ))}
        </nav>
      </header>

      <main className="mx-auto mt-4 max-w-2xl space-y-4 px-4">
        {notice && <button type="button" onClick={() => setNotice("")} className="w-full rounded-2xl bg-sky-100 p-3 text-left text-sm font-semibold text-sky-800 dark:bg-sky-950 dark:text-sky-200">{notice} ✕</button>}
        {!state ? (
          <p className="text-sm text-neutral-500">読み込んでいます…</p>
        ) : (
          <>
            <Setup setup={state.setup} />
            {tab === "sites" && <SitesTab sites={state.sites} onChanged={reload} />}
            {tab === "members" && <MembersTab members={state.members} hasOwnSite={state.sites.some((s) => s.kind === "own")} onChanged={reload} />}
            {tab === "compose" && (
              <>
                <section className={`${card} space-y-4`}>
                  <input ref={fileInput} type="file" accept="video/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void pickFile(f); }} />
                  {!current ? (
                    <button type="button" onClick={() => fileInput.current?.click()} className="w-full rounded-2xl border-2 border-dashed border-neutral-300 px-4 py-10 text-center dark:border-neutral-700">
                      <span className="block text-3xl">🎬</span>
                      <span className="mt-2 block font-bold">動画を選ぶ</span>
                      <span className="mt-1 block text-xs text-neutral-500">または、下の「登録した動画」から選ぶ</span>
                    </button>
                  ) : editing && current.blob && current.info ? (
                    <Editor blob={current.blob} meta={current.info} onDone={applyEdit} onCancel={() => setEditing(false)} />
                  ) : (
                    <>
                      {previewUrl && <video key={previewUrl} src={previewUrl} controls playsInline className="mx-auto max-h-[50vh] rounded-xl bg-black" />}
                      <div className="flex items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-bold">{current.name}</p>
                          <p className="text-xs text-neutral-500">
                            {(() => {
                              const m = current.info ?? video;
                              const size = current.blob?.size ?? video?.size ?? 0;
                              return m ? `${formatTime(m.duration)} ・${m.width}×${m.height} ・${formatSize(size)}` : "調べています…";
                            })()}
                            {current.blob ? " ・まだ送っていません" : ""}
                          </p>
                        </div>
                        <button type="button" disabled={busy || (!!current.blob && !current.info)} onClick={startEdit} className={ghost}>✂️ 編集</button>
                        <button type="button" disabled={busy} onClick={() => setCurrent(null)} className={ghost}>替える</button>
                      </div>
                    </>
                  )}

                  {current && !editing && (
                    <>
                      <label className="block text-sm font-semibold">
                        メモ（なくても可）
                        <textarea value={memo} onChange={(e) => setMemo(e.target.value)} rows={2} placeholder="AI に伝えたいこと。例：新メニューのスープカレー、11 月末までの限定" className={`${input} mt-1`} />
                      </label>

                      <div>
                        <p className="text-sm font-semibold">投稿先</p>
                        {sites.length === 0 ? (
                          <p className="mt-1 text-sm text-amber-600">まだありません。<button type="button" onClick={() => setTab("sites")} className="font-bold underline">投稿先を足す</button></p>
                        ) : (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {sites.map((s) => {
                              const on = chosen.includes(s);
                              return (
                                <button key={s.id} type="button" aria-pressed={on} onClick={() => { const next = new Set(chosen.map((x) => x.id)); if (on) next.delete(s.id); else next.add(s.id); setPicked(next); }} className={`rounded-full border px-3 py-1.5 text-sm font-semibold ${on ? "border-fuchsia-500 bg-fuchsia-50 text-fuchsia-700 dark:bg-fuchsia-950/40 dark:text-fuchsia-300" : "border-neutral-300 text-neutral-400 dark:border-neutral-700"}`}>
                                  {KINDS[s.kind].emoji} {s.name}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      {current.blob && (
                        <label className="block text-sm font-semibold">
                          おまかせのとき、動画の形を整える
                          <select value={autoAspect} onChange={(e) => setAutoAspect(e.target.value as Aspect)} className={`${input} mt-1`}>
                            {ASPECTS.map((a) => <option key={a.value} value={a.value}>{a.value === "original" ? "整えない（そのまま送る）" : `${a.label} に切り抜く`}</option>)}
                          </select>
                        </label>
                      )}

                      <div className="grid gap-2 sm:grid-cols-2">
                        <button type="button" disabled={busy || (!!current.blob && !current.info)} onClick={() => go(true)} className={`${primary} py-3`}>⚡ おまかせで投稿まで進む{autoCount ? `（${autoCount} 件）` : ""}</button>
                        <button type="button" disabled={busy || (!!current.blob && !current.info)} onClick={() => go(false)} className={`${ghost} py-3`}>✍️ 文だけ作って、確かめてから投稿</button>
                      </div>
                    </>
                  )}

                  {log.length > 0 && (
                    <ul className="space-y-1 rounded-xl bg-neutral-100 p-3 text-xs dark:bg-neutral-800/60">
                      {log.map((line, i) => <li key={i} className="break-words">{line}{busy && i === log.length - 1 && !line.startsWith("✅") ? " ⏳" : ""}</li>)}
                    </ul>
                  )}
                  {error && <p className="whitespace-pre-wrap text-sm font-semibold text-red-600">{error}</p>}
                </section>

                {posts.map((post) => {
                  const site = state.sites.find((s) => s.id === post.site_id);
                  return site ? <PostCard key={post.id} post={post} site={site} video={video} busy={busy} onChanged={reload} onPublish={publishOne} /> : null;
                })}

                {state.videos.length > 0 && (
                  <section>
                    <h2 className="px-1 text-sm font-bold text-neutral-500">登録した動画</h2>
                    <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
                      {state.videos.map((v) => {
                        const done = state.posts.filter((p) => p.video_id === v.id && p.status === "posted").length;
                        return (
                          <div key={v.id} className={`overflow-hidden rounded-2xl border bg-white dark:bg-neutral-900 ${current?.videoId === v.id ? "border-fuchsia-500" : "border-neutral-200 dark:border-neutral-800"}`}>
                            <button type="button" onClick={() => pickVideo(v)} className="block w-full text-left">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              {v.thumb ? <img src={v.thumb} alt="" className="aspect-video w-full bg-black object-contain" /> : <div className="aspect-video w-full bg-neutral-200 dark:bg-neutral-800" />}
                              <span className="block truncate px-2 pt-2 text-xs font-bold">{v.name}</span>
                              <span className="block px-2 text-[11px] text-neutral-500">{v.path ? `${formatTime(v.duration)} ・投稿 ${done} 件` : "⚠️ 送信が未完了"}</span>
                            </button>
                            <button type="button" onClick={() => removeVideo(v)} className="px-2 pb-2 pt-1 text-[11px] font-semibold text-red-500">消す</button>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                )}
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
