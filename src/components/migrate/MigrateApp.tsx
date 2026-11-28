"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { KINDS, type Kind } from "@/lib/migrate/classify";
import { QUIET_DAYS, type Graduation } from "@/lib/migrate/graduate";
import { LEVEL_LABEL, type Level } from "@/lib/migrate/judge";
import type { Grant } from "@/lib/migrate/grants";
import { providerFor } from "@/lib/migrate/providers";
import { KIND_LABEL, STATUS_LABEL, type AppState, type Mailbox, type Service, type Status } from "@/lib/migrate/types";

/** アカウント引っ越しの API を呼ぶ（失敗したら、画面に出せる日本語の理由つきで投げる） */
async function api<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`/api/migrate/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `うまくいきませんでした（${res.status}）`);
  return json as T;
}

const input = "w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-[16px] outline-none focus:border-emerald-400 dark:border-neutral-700 dark:bg-neutral-900";
const card = "rounded-2xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900";
const primary = "rounded-full bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-40";
const ghost = "rounded-full bg-neutral-200/80 px-3 py-2 text-xs font-semibold text-neutral-700 disabled:opacity-40 dark:bg-neutral-800 dark:text-neutral-200";

const LEVELS: Level[] = ["depends", "maybe", "ads"];
const LEVEL_STYLE: Record<Level, string> = {
  depends: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200",
  maybe: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  ads: "bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300",
};
/** Google の手続きから戻ってきたときの結果（URL で受け取るのは記号だけ。文はここで決める） */
const RESULT_NOTICE: Record<string, string> = {
  login: "ログインしました。",
  connected: "メールボックスをつなぎました。「調べる」を押すと、登録済みのサービスを洗い出します。",
};
const RESULT_ERROR: Record<string, string> = {
  "not-configured": "Google Cloud の設定がまだです。",
  "login-required": "先にログインしてください。",
  "login-changed": "手続きの途中でログインが切れたか、別のアカウントに替わりました。ログインしてから、もう一度つないでください。",
  "bad-state": "手続きの確認ができませんでした。もう一度やり直してください。",
  denied: "Google で許可されませんでした。",
  "too-many": "つなげるメールボックスの数の上限に達しています。",
  "no-token-key": "合言葉を守る鍵（MIGRATE_TOKEN_KEY）の設定がまだなので、つなげません。",
  scope: "メールを読む許可（読み取りのみ）を受け取れませんでした。もう一度つないで、チェックを入れて許可してください。",
  unverified: "メールアドレスの確認が済んでいない Google アカウントでは、ログインできません。",
  failed: "うまくいきませんでした。もう一度やり直してください。",
};
const STATUSES: Status[] = ["new", "move", "skip", "done"];
/** 日本の時刻での日付（YYYY/MM/DD） */
const day = (iso: string | null) => (iso ? new Date(Date.parse(iso) + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, "/") : "");
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function MigrateApp() {
  const [state, setState] = useState<AppState | null>(null);
  const [fatal, setFatal] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Status>("new");
  const [query, setQuery] = useState("");
  const [box, setBox] = useState("");
  const [level, setLevel] = useState<Level | "">("");
  const [origin, setOrigin] = useState("");
  // 細かい一覧は、最初はしまっておく（見たい人だけ開く）
  const [showList, setShowList] = useState(false);

  const reload = useCallback(async () => {
    try {
      setState(await api<AppState>("state"));
    } catch (e) {
      setFatal(message(e));
    }
  }, []);

  useEffect(() => {
    // 読み込みと、Google の許可画面から戻ってきたときのお知らせ（URL からは消しておく）
    const start = async () => {
      setOrigin(window.location.origin);
      const p = new URLSearchParams(window.location.search);
      const result = p.get("result");
      if (result && RESULT_NOTICE[result]) setNotice(RESULT_NOTICE[result]);
      else if (result) setError(RESULT_ERROR[result] ?? RESULT_ERROR.failed);
      if (result) window.history.replaceState(null, "", window.location.pathname);
      await reload();
    };
    void start();
  }, [reload]);

  // サーバーが調べている間は、数秒ごとに進み具合を読み直す（画面を閉じても、調べるのはサーバーで続く）
  const anyScanning = !!state?.mailboxes.some((m) => m.scanning);
  useEffect(() => {
    if (!anyScanning) return;
    const timer = setInterval(() => void reload(), 3000);
    return () => clearInterval(timer);
  }, [anyScanning, reload]);

  /** つないである全部を、同時に調べ始める */
  const startAll = async () => {
    const idle = (state?.mailboxes ?? []).filter((m) => !m.scanning);
    setError("");
    const results = await Promise.allSettled(idle.map((m) => api("scan", { mailboxId: m.id })));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) setError(message(failed.reason));
    else setNotice(`${idle.length} 件のメールボックスを、同時に調べ始めました。画面を閉じても、サーバーで最後まで進みます。`);
    await reload();
  };

  const startScan = async (m: Mailbox) => {
    await act("scan", { mailboxId: m.id });
    setNotice(`${m.email} を調べ始めました。画面を閉じても、サーバーで最後まで進みます。`);
  };

  const act = async (action: string, body: Record<string, unknown>) => {
    setError("");
    try {
      await api(action, body);
    } catch (e) {
      setError(message(e));
    }
    await reload();
  };

  const update = async (s: Service, patch: Partial<Pick<Service, "status" | "login_url" | "note">>) => {
    // 先に画面を変えてから保存する（一覧が大きくても待たせない）
    setState((cur) => cur && { ...cur, services: cur.services.map((x) => (x.id === s.id ? { ...x, ...patch } : x)) });
    try {
      await api("update", { id: s.id, ...patch });
    } catch (e) {
      setError(message(e));
      await reload();
    }
  };

  const editUrl = (s: Service) => {
    const v = prompt(`「${s.name || s.domain}」で開くページ（ログインページや設定ページの URL）。空にすると ${s.domain} の先頭を開きます。`, s.login_url);
    if (v !== null) void update(s, { login_url: v.trim() });
  };

  const pool = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (state?.services ?? []).filter(
      (s) =>
        (!box || s.mailbox_id === box) &&
        // 数え直した後に 1 通も見つからなかったものは、仕分け済みでなければ出さない
        (s.count > 0 || s.status !== "new") &&
        (!level || s.judgment.level === level) &&
        (!q || `${s.name} ${s.domain} ${s.note}`.toLowerCase().includes(q)),
    );
  }, [state, query, box, level]);
  const counts = useMemo(() => Object.fromEntries(STATUSES.map((k) => [k, pool.filter((s) => s.status === k).length])) as Record<Status, number>, [pool]);
  // 頼っているものを先に、その中では通数の多い順に並べる
  const visible = pool.filter((s) => s.status === tab).sort((a, b) => LEVELS.indexOf(a.judgment.level) - LEVELS.indexOf(b.judgment.level) || b.count - a.count);
  const emailOf = useMemo(() => new Map((state?.mailboxes ?? []).map((m) => [m.id, m.email])), [state]);

  if (fatal) return <main className="mx-auto max-w-2xl p-6 text-sm font-semibold text-red-600">{fatal}</main>;
  const ready = !!state && state.setup.db && state.setup.google;

  return (
    <div className="min-h-screen bg-neutral-50 pb-24 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="mx-auto max-w-2xl px-4 pt-[max(1.25rem,env(safe-area-inset-top))]">
        <Link href="/apps" className="text-xs font-semibold text-neutral-500">‹ アプリ一覧</Link>
        <h1 className="mt-1 text-2xl font-black tracking-tight">📬 アカウント引っ越し</h1>
        <p className="mt-1 text-sm text-neutral-500">Gmail から登録済みのサービスを洗い出し、新しいメールアドレスへの変更を 1 件ずつ進めます。</p>
      </header>

      <main className="mx-auto mt-4 max-w-2xl space-y-4 px-4">
        {notice && <button type="button" onClick={() => setNotice("")} className="w-full rounded-2xl bg-sky-100 p-3 text-left text-sm font-semibold text-sky-800 dark:bg-sky-950 dark:text-sky-200">{notice} ✕</button>}
        {error && <button type="button" onClick={() => setError("")} className="w-full rounded-2xl bg-red-100 p-3 text-left text-sm font-semibold text-red-800 dark:bg-red-950 dark:text-red-200">{error} ✕</button>}

        {!state ? (
          <p className="text-sm text-neutral-500">読み込んでいます…</p>
        ) : (
          <>
            {!ready && <Setup setup={state.setup} origin={origin} />}

            {!state.user ? (
              <section className={card}>
                <h2 className="text-base font-black">ログイン</h2>
                <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-300">
                  Google アカウントでログインします。ここで受け取るのは、名前とメールアドレスだけです。メールを読む許可は、ログインのあとで、つなぎたいアドレスごとに別にお願いします。
                </p>
                {ready && (
                  <button type="button" className={`${primary} mt-3`} onClick={() => window.location.assign("/api/migrate/oauth/login")}>
                    Google でログイン
                  </button>
                )}
              </section>
            ) : (
              <>
            <p className="flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-500">
              <span className="break-all">{state.user.email} でログイン中</span>
              <button type="button" className="font-semibold underline" onClick={() => void act("logout", {})}>ログアウト</button>
            </p>

            <section className={card}>
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-base font-black">メールボックス</h2>
                {ready && (
                  <button type="button" className={primary} disabled={!state.setup.tokenKey} onClick={() => window.location.assign("/api/migrate/oauth/connect")}>
                    ＋ Gmail をつなぐ
                  </button>
                )}
              </div>
              <p className="mt-1 text-xs text-neutral-500">
                読むだけの許可でつなぎます。読むのは差出人・件名・日付などのヘッダだけで、本文は読みません。認証コードやログイン通知のメールは、件名を保存しません。それ以外の件名も、番号や URL は伏せてから記録します。
              </p>
              {ready && state.setup.tokenKey && (
                <ImapConnect
                  onDone={async (email) => {
                    setError("");
                    setNotice(`${email} をつなぎました。「調べる」を押すと、登録済みのサービスを洗い出します。`);
                    await reload();
                  }}
                />
              )}
              {!state.setup.llm && (
                <p className="mt-2 text-xs text-neutral-500">
                  AI による仕上げの分類は、まだ使えません（Vercel の環境変数 <code>ANTHROPIC_API_KEY</code> が未設定）。決まりで分類できなかったメールは「そのほかのお知らせ」のままになります。
                </p>
              )}
              {!state.setup.tokenKey && (
                <p className="mt-2 rounded-xl bg-amber-100 p-3 text-xs font-semibold text-amber-900 dark:bg-amber-950 dark:text-amber-100">
                  メールボックスをつなぐ前に、合言葉を守る鍵の設定が必要です。Vercel の環境変数 <code>MIGRATE_TOKEN_KEY</code> に、32 文字以上のでたらめな文字列を入れて、デプロイし直してください。
                </p>
              )}
              {state.mailboxes.filter((m) => !m.scanning).length > 1 && (
                <button type="button" className={`${ghost} mt-2`} onClick={() => void startAll()}>すべて同時に調べる</button>
              )}
              {state.mailboxes.length === 0 && <p className="mt-3 text-sm text-neutral-500">まだつないでいません。</p>}
              <ul className="mt-3 space-y-3">
                {state.mailboxes.map((m) => {
                  return (
                    <li key={m.id} className="rounded-xl bg-neutral-100 p-3 dark:bg-neutral-800/60">
                      <p className="break-all text-sm font-bold">{m.email}</p>
                      <p className="mt-0.5 text-xs text-neutral-500">
                        {m.scanning
                          ? `調べています…${m.remaining ? ` 残り ${m.remaining.toLocaleString()} 通` : ""}（記録 ${m.scanned.toLocaleString()} 通）。画面を閉じても続きます`
                          : m.last_scan
                            ? `${day(m.last_scan)} に調べました（記録 ${m.scanned.toLocaleString()} 通）`
                            : m.scanned
                              ? `途中まで調べました（${m.scanned.toLocaleString()} 通）`
                              : "まだ調べていません"}
                      </p>
                      {m.error && <p className="mt-1 text-xs font-semibold text-red-600 dark:text-red-400">{m.error}</p>}
                      <KindSummary kinds={m.kinds} />
                      <div className="mt-2 flex flex-wrap gap-2">
                        {m.scanning ? (
                          <button type="button" className={ghost} onClick={() => void act("stop", { mailboxId: m.id })}>止める</button>
                        ) : (
                          <>
                            <button type="button" className={primary} onClick={() => void startScan(m)}>
                              {m.last_scan ? "新しく届いた分を調べる" : m.scanned ? "続きを調べる" : "調べる"}
                            </button>
                            <button
                              type="button"
                              className={ghost}
                              onClick={() => confirm(`${m.email} の件数を空にして、最初から調べ直せるようにします（仕分け・メモは残ります）。`) && void act("reset", { mailboxId: m.id })}
                            >
                              数え直す
                            </button>
                            <button
                              type="button"
                              className={ghost}
                              onClick={() => confirm(`${m.email} とのつながりを切り、このメールボックスの一覧（仕分け・メモを含む）を消します。`) && void act("disconnect", { mailboxId: m.id })}
                            >
                              つながりを切る
                            </button>
                          </>
                        )}
                      </div>
                      <label className="mt-3 flex items-center gap-2 text-xs font-semibold text-neutral-700 dark:text-neutral-200">
                        <input type="checkbox" checked={m.retiring} onChange={(e) => void act("retire", { mailboxId: m.id, retiring: e.target.checked })} />
                        このアドレスを、やめたい（毎日 1 回、自動で見張ります）
                      </label>
                      {m.graduation && <GraduationPanel g={m.graduation} />}
                    </li>
                  );
                })}
              </ul>
            </section>

            {state.services.length > 0 && (
              <TodoPanel
                services={state.services}
                reload={reload}
                setError={setError}
                setNotice={setNotice}
                onShowMove={() => {
                  setTab("new");
                  setLevel("depends");
                  setShowList(true);
                  // 一覧が出てから、そこまで動かす
                  setTimeout(() => document.getElementById("mg-list")?.scrollIntoView({ behavior: "smooth" }), 50);
                }}
              />
            )}

            {state.services.length > 0 && !showList && (
              <button type="button" className={`${ghost} w-full`} onClick={() => setShowList(true)}>
                すべてのサービスを 1 件ずつ見る（{state.services.filter((s) => s.count > 0 || s.status !== "new").length} 件）
              </button>
            )}

            {state.services.length > 0 && showList && (
              <section id="mg-list" className="space-y-3">
                <h2 className="pt-2 text-base font-black">1 件ずつ見る</h2>
                <nav className="flex gap-1 rounded-full bg-neutral-200/70 p-1 text-xs font-bold dark:bg-neutral-800">
                  {STATUSES.map((k) => (
                    <button key={k} type="button" onClick={() => setTab(k)} className={`flex-1 rounded-full px-2 py-2 ${tab === k ? "bg-white shadow dark:bg-neutral-950" : "text-neutral-500"}`}>
                      {STATUS_LABEL[k]}（{counts[k]}）
                    </button>
                  ))}
                </nav>
                <input className={input} placeholder="サービス名・ドメインで探す" value={query} onChange={(e) => setQuery(e.target.value)} />
                <div className="flex flex-wrap items-center gap-3 text-xs text-neutral-600 dark:text-neutral-300">
                  <select className="rounded-lg border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" value={level} onChange={(e) => setLevel(e.target.value as Level | "")}>
                    <option value="">頼り具合：すべて</option>
                    {LEVELS.map((l) => (
                      <option key={l} value={l}>{LEVEL_LABEL[l]}</option>
                    ))}
                  </select>
                  {state.mailboxes.length > 1 && (
                    <select className="rounded-lg border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" value={box} onChange={(e) => setBox(e.target.value)}>
                      <option value="">すべてのメールボックス</option>
                      {state.mailboxes.map((m) => (
                        <option key={m.id} value={m.id}>{m.email}</option>
                      ))}
                    </select>
                  )}
                </div>
                {visible.length === 0 && <p className="text-sm text-neutral-500">ここには何もありません。</p>}
                <ul className="space-y-3">
                  {visible.slice(0, 300).map((s) => (
                    <ServiceCard key={s.id} s={s} email={state.mailboxes.length > 1 ? emailOf.get(s.mailbox_id) : undefined} onStatus={(status) => void update(s, { status })} onEditUrl={() => editUrl(s)} />
                  ))}
                </ul>
                {visible.length > 300 && <p className="text-xs text-neutral-500">多いので先頭の 300 件だけ出しています。上の欄で絞りこんでください。</p>}
              </section>
            )}

            <AgentsPanel state={state} origin={origin} reload={reload} setError={setError} />

            <p className="pt-4 text-center text-xs text-neutral-400">
              <button
                type="button"
                className="underline"
                onClick={() =>
                  confirm("アカウントを削除します。つないだメールの許可を Google 側でも取り消し、一覧・仕分け・メモをすべて消します。元には戻せません。") && void act("deleteAccount", {})
                }
              >
                アカウントを削除する
              </button>
            </p>
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function ServiceCard({ s, email, onStatus, onEditUrl }: { s: Service; email?: string; onStatus: (status: Status) => void; onEditUrl: () => void }) {
  const url = s.login_url || `https://${s.domain}/`;
  const next: [Status, string][] =
    s.status === "new" ? [["move", "移行する"], ["skip", "不要"]] : s.status === "move" ? [["done", "変更できた"], ["skip", "不要"], ["new", "戻す"]] : [["new", "戻す"]];
  return (
    <li className={card}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {/* 見出しはドメイン。差出人の表示名は送る側が自由に書けるので（なりすまし）、「名乗り」として小さく添える */}
          <p className="truncate text-sm font-black">{s.domain}</p>
          {s.name && <p className="truncate text-xs text-neutral-500">差出人の名乗り：{s.name}</p>}
          {email && <p className="truncate text-xs text-neutral-500">届いたアドレス：{email}</p>}
        </div>
        <p className="shrink-0 text-right text-xs text-neutral-500">
          {s.count.toLocaleString()} 通
          <br />
          {day(s.first_at)}{s.last_at && day(s.last_at) !== day(s.first_at) ? ` 〜 ${day(s.last_at)}` : ""}
        </p>
      </div>
      <p className="mt-2 text-xs">
        <span className={`mr-2 rounded-full px-2 py-0.5 text-[11px] font-bold ${LEVEL_STYLE[s.judgment.level]}`}>{LEVEL_LABEL[s.judgment.level]}</span>
        <span className="text-neutral-600 dark:text-neutral-300">{s.judgment.reasons.join("／")}</span>
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {KINDS.filter((k) => s.signals[k]).map((k) => (
          <span key={k} className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${k === "promo" ? "bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300" : "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"}`}>
            {KIND_LABEL[k]} {s.signals[k]}
          </span>
        ))}
      </div>
      {s.subjects.length > 0 && (
        <details className="mt-2 text-xs text-neutral-600 dark:text-neutral-300">
          <summary className="cursor-pointer font-semibold text-neutral-500">件名の見本</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {s.subjects.map((t) => (
              <li key={t} className="break-words">{t}</li>
            ))}
          </ul>
        </details>
      )}
      {s.stillArriving && (
        <p className="mt-2 rounded-lg bg-rose-100 p-2 text-xs font-semibold text-rose-800 dark:bg-rose-950 dark:text-rose-200">
          「変更できた」にしたあとも、{day(s.stillArriving.lastAt)} に重要なメールが届いています（{s.stillArriving.count} 通）。まだこのアドレスが使われているようです。登録アドレスの変更が済んでいるか、もう一度確かめてください。
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {/* 届いた通数が少ない差出人には、その差出人のサイトへの案内を出さない（なりすましメールの差出人へ誘導しないため）。自分で URL を入れれば出る */}
        {s.status !== "skip" && (s.login_url || !s.judgment.unproven) && (
          <a href={url} target="_blank" rel="noopener noreferrer" className={s.status === "move" ? primary : ghost}>ページを開く ↗</a>
        )}
        {next.map(([status, label]) => (
          <button key={status} type="button" className={ghost} onClick={() => onStatus(status)}>{label}</button>
        ))}
        <button type="button" className="text-xs font-semibold text-neutral-500 underline" onClick={onEditUrl}>開くページを直す</button>
      </div>
    </li>
  );
}

/**
 * 「やること」。サービスを先に 4 つに仕分けておき、利用者は大きなボタンを 1 つずつ押すだけで進められるようにする。
 * 細かく見たい人だけ、「中身を見る」や、下の「1 件ずつ見る」を使う
 */
function TodoPanel({ services, reload, setError, setNotice, onShowMove }: { services: Service[]; reload: () => Promise<void>; setError: (m: string) => void; setNotice: (m: string) => void; onShowMove: () => void }) {
  const [busy, setBusy] = useState("");
  const [except, setExcept] = useState<Set<string>>(new Set());
  const live = services.filter((s) => s.count > 0);
  const fresh = live.filter((s) => s.status === "new");
  const ads = fresh.filter((s) => s.lane === "stop" && !s.unsub);
  const manual = live.filter((s) => s.unsub?.state === "manual" && s.status === "new");
  const stopped = live.filter((s) => s.unsub?.state === "done").length;
  const unused = fresh.filter((s) => s.lane === "quit");
  const move = live.filter((s) => s.lane === "move" && (s.status === "new" || s.status === "move"));
  const picked = (list: Service[]) => list.filter((s) => !except.has(s.id)).length;
  const toggle = (id: string) =>
    setExcept((cur) => {
      const next = new Set(cur);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const run = async (action: "stopAds" | "skipUnused", list: Service[]) => {
    setBusy(action);
    setError("");
    try {
      const r = await api<{ stopped?: number; manual?: number; remaining?: number; skipped?: number }>(action, { except: list.filter((s) => except.has(s.id)).map((s) => s.id) });
      if (action === "stopAds") {
        setNotice(
          `${r.stopped ?? 0} 件の配信を止めました。` +
            (r.manual ? `${r.manual} 件は、こちらからは止められませんでした（下の「自分で止める」に出ています）。` : "") +
            (r.remaining ? `あと ${r.remaining} 件あります。もう一度押してください。` : "") +
            "止まるまで、数日かかることがあります。",
        );
      } else setNotice(`${r.skipped ?? 0} 件を「移さない」にしました。`);
    } catch (e) {
      setError(message(e));
    }
    setBusy("");
    await reload();
  };

  const rows = (list: Service[]) => (
    <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto text-xs">
      {list.map((s) => (
        <li key={s.id}>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={!except.has(s.id)} onChange={() => toggle(s.id)} />
            <span className="min-w-0 break-all">
              <b>{s.domain}</b>
              <span className="ml-1 text-neutral-500">{s.count} 通 ／ {s.judgment.reasons[0]}</span>
            </span>
          </label>
        </li>
      ))}
    </ul>
  );

  if (!ads.length && !manual.length && !unused.length && !move.length && !stopped) return null;
  return (
    <section className="space-y-3">
      <h2 className="text-base font-black">やること</h2>

      {ads.length > 0 && (
        <div className={card}>
          <p className="text-sm font-black">① 広告メールを止める（{ads.length} 件）</p>
          <p className="mt-1 text-xs text-neutral-500">広告だけを送ってくる差出人です。ボタンを押すと、こちらから配信停止を申し込みます。必要なメール（ログインや請求）が届いている所は、ここには入っていません。</p>
          <button type="button" className={`${primary} mt-3`} disabled={!!busy || picked(ads) === 0} onClick={() => void run("stopAds", ads)}>
            {busy === "stopAds" ? "止めています…" : `まとめて止める（${picked(ads)} 件）`}
          </button>
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer font-semibold text-neutral-600 dark:text-neutral-300">中身を見る（残したいものは、チェックを外す）</summary>
            {rows(ads)}
          </details>
        </div>
      )}

      {manual.length > 0 && (
        <div className={card}>
          <p className="text-sm font-black">自分で止める（{manual.length} 件）</p>
          <p className="mt-1 text-xs text-neutral-500">こちらからは止められなかった差出人です。ページを開いて止めるか、届いたメールのいちばん下にある「配信停止」から止めてください。</p>
          <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto text-xs">
            {manual.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2">
                <b className="break-all">{s.domain}</b>
                {s.unsub?.url ? (
                  <a className="underline" href={s.unsub.url} target="_blank" rel="noreferrer noopener">
                    配信停止のページを開く
                  </a>
                ) : (
                  <span className="text-neutral-500">メールの下の「配信停止」から</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {unused.length > 0 && (
        <div className={card}>
          <p className="text-sm font-black">② 使っていないサービスを外す（{unused.length} 件）</p>
          <p className="mt-1 text-xs text-neutral-500">登録した跡はありますが、最近は使った様子がありません。「移さない」にすると、新しいアドレスへ移す対象から外れます（退会はしません。あとで戻せます）。</p>
          <button type="button" className={`${primary} mt-3`} disabled={!!busy || picked(unused) === 0} onClick={() => void run("skipUnused", unused)}>
            {busy === "skipUnused" ? "外しています…" : `まとめて「移さない」にする（${picked(unused)} 件）`}
          </button>
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer font-semibold text-neutral-600 dark:text-neutral-300">中身を見る（まだ使っているものは、チェックを外す）</summary>
            {rows(unused)}
          </details>
        </div>
      )}

      {move.length > 0 && (
        <div className={card}>
          <p className="text-sm font-black">③ 新しいアドレスに移す（{move.length} 件）</p>
          <p className="mt-1 text-xs text-neutral-500">今も使っていて、このアドレスに頼っているサービスです。1 件ずつ、登録のメールアドレスを新しいものに変えていきます。</p>
          <button type="button" className={`${primary} mt-3`} onClick={onShowMove}>
            1 件ずつ進める
          </button>
        </div>
      )}

      {stopped > 0 && <p className="text-xs text-neutral-500">これまでに {stopped} 件の配信を止めました。</p>}
    </section>
  );
}

/**
 * Gmail 以外のメール（Yahoo!メール・OCN など）を、アドレスとパスワードでつなぐ入力欄。
 * パスワードは、つなぐときにサーバーへ 1 回送るだけ（画面には残さない。サーバーでは暗号化して置く）
 */
function ImapConnect({ onDone }: { onDone: (email: string) => Promise<void> }) {
  const [shown, setShown] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [host, setHost] = useState("");
  const [login, setLogin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const provider = useMemo(() => providerFor(email), [email]);
  const hasDomain = /@[^@\s]+\.[^@\s]+$/.test(email.trim());
  const isGmail = /@(gmail|googlemail)\.com$/i.test(email.trim());

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ email: string }>("imapConnect", { email, password, host, login });
      setPassword("");
      setEmail("");
      setHost("");
      setLogin("");
      setShown(false);
      await onDone(r.email);
    } catch (e) {
      setPassword("");
      setError(message(e));
    }
    setBusy(false);
  };

  if (!shown) {
    return (
      <button type="button" className={`${ghost} mt-3`} onClick={() => setShown(true)}>
        ＋ ほかのメールをつなぐ（Yahoo!メール・プロバイダのメールなど）
      </button>
    );
  }
  return (
    <div className="mt-3 space-y-2 rounded-xl bg-neutral-100 p-3 text-xs dark:bg-neutral-800/60">
      <p className="font-black">ほかのメールをつなぐ</p>
      <p className="text-neutral-500">
        メールソフトと同じ方法（IMAP）で、読むだけの開き方でつなぎます。読むのは差出人・件名・日付などのヘッダだけで、本文は読みません。パスワードは暗号化して預かり、「つながりを切る」で消えます。
      </p>
      <label className="block font-semibold">
        メールアドレス
        <input className={`${input} mt-1`} type="email" autoComplete="off" value={email} maxLength={200} onChange={(e) => setEmail(e.target.value)} />
      </label>
      {isGmail && <p className="font-semibold text-amber-700 dark:text-amber-300">Gmail は、上の「＋ Gmail をつなぐ」からつないでください（パスワードを預からずに済みます）。</p>}
      {provider?.blocked && <p className="font-semibold text-amber-700 dark:text-amber-300">{provider.blocked}</p>}
      {provider && !provider.blocked && (
        <div className="rounded-lg bg-white/70 p-2 dark:bg-black/30">
          <p className="font-semibold">{provider.name} をつなぐ前に</p>
          {provider.steps && (
            <ol className="mt-1 list-decimal space-y-0.5 pl-5">
              {provider.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          )}
          {provider.helpUrl && (
            <a className="mt-1 inline-block underline" href={provider.helpUrl} target="_blank" rel="noreferrer noopener">
              {provider.name} の公式の案内
            </a>
          )}
          {provider.caution && <p className="mt-2 rounded-lg bg-amber-100 p-2 text-amber-900 dark:bg-amber-950 dark:text-amber-100">{provider.caution}</p>}
        </div>
      )}
      {hasDomain && !isGmail && !provider?.blocked && !provider?.host && (
        <label className="block font-semibold">
          IMAP サーバー（受信メールサーバー）の名前
          <input className={`${input} mt-1`} autoComplete="off" placeholder="例：imap.example.jp" value={host} maxLength={253} onChange={(e) => setHost(e.target.value)} />
          <span className="mt-1 block font-normal text-neutral-500">メール会社の「メールソフトの設定」の案内に書いてあります。暗号化された接続（ポート 993）だけに対応しています。</span>
        </label>
      )}
      {provider?.user === "ask" && (
        <label className="block font-semibold">
          {provider.userLabel ?? "ログインに使う ID"}
          <input className={`${input} mt-1`} autoComplete="off" value={login} maxLength={200} onChange={(e) => setLogin(e.target.value)} />
        </label>
      )}
      <label className="block font-semibold">
        {provider?.passwordLabel ?? "パスワード（メール用のパスワードがある会社では、そちら）"}
        <input className={`${input} mt-1`} type="password" autoComplete="off" value={password} maxLength={256} onChange={(e) => setPassword(e.target.value)} />
      </label>
      {error && <p className="font-semibold text-rose-700 dark:text-rose-300">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={primary} disabled={busy || !hasDomain || !password || isGmail || !!provider?.blocked} onClick={() => void submit()}>
          {busy ? "確かめています…" : "つなぐ"}
        </button>
        <button type="button" className={ghost} disabled={busy} onClick={() => setShown(false)}>
          やめる
        </button>
      </div>
    </div>
  );
}

/**
 * AI 秘書（Claude Desktop・Claude Code など）とつなぐ鍵。
 * 作った鍵は、その場で 1 回だけ見せる（閉じたら二度と見られない。なくしたら取り消して作り直す）
 */
function AgentsPanel({ state, origin, reload, setError }: { state: AppState; origin: string; reload: () => Promise<void>; setError: (m: string) => void }) {
  const [name, setName] = useState("Claude Desktop");
  const [scope, setScope] = useState<string[] | null>(null);
  const [issued, setIssued] = useState<{ token: string; grant: Grant } | null>(null);
  const [busy, setBusy] = useState(false);
  // AI 秘書に教える URL は、サーバーが決めた住所を使う（許可の手続きは、この住所と 1 文字も違わないときだけ通る）
  const url = state.mcpUrl ?? `${origin}/api/mcp/migrate`;

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      setIssued(await api<{ token: string; grant: Grant }>("grantCreate", { name, mailboxIds: scope }));
      await reload();
    } catch (e) {
      setError(message(e));
    }
    setBusy(false);
  };
  const revoke = async (g: Grant) => {
    if (!confirm(g.kind === "oauth" ? `「${g.name}」とのつながりを取り消します。この AI 秘書は、すぐに読めなくなります。` : `「${g.name}」の鍵を取り消します。この鍵を使っている AI 秘書は、すぐに使えなくなります。`)) return;
    try {
      await api("grantRevoke", { id: g.id });
      if (issued?.grant.id === g.id) setIssued(null);
      await reload();
    } catch (e) {
      setError(message(e));
    }
  };
  const toggle = (id: string, on: boolean) => {
    const current = scope ?? state.mailboxes.map((m) => m.id);
    const next = on ? [...new Set([...current, id])] : current.filter((x) => x !== id);
    setScope(next.length === state.mailboxes.length ? null : next);
  };

  return (
    <section className={card}>
      <h2 className="text-base font-black">AI 秘書とつなぐ（MCP）</h2>
      <p className="mt-1 text-xs text-neutral-500">
        Claude などの AI 秘書から、つないだアドレスの台帳と、メールの記録（ヘッダだけ）を読めるようにします。つながりごとに、見せるアドレスを選べます。いつでも取り消せます。
      </p>

      <div className="mt-3 rounded-xl bg-emerald-50 p-3 text-xs dark:bg-emerald-950/40">
        <p className="font-black">かんたんなつなぎ方（Claude のアプリ・claude.ai）</p>
        <ol className="mt-1 list-decimal space-y-0.5 pl-5">
          <li>Claude の設定の「コネクタ」で「カスタムコネクタを追加」を選ぶ</li>
          <li>下の URL を貼って追加し、「接続」を押す</li>
          <li>この画面と同じログインで、見せるアドレスを選んで「許可する」</li>
        </ol>
        <code className="mt-2 block break-all rounded bg-white/70 p-2 dark:bg-black/30">{url}</code>
        <p className="mt-2 text-neutral-500">鍵を貼る必要はありません。Claude Code では <code>claude mcp add --transport http account-migrate {url}</code> のあと、<code>/mcp</code> から許可します。</p>
      </div>

      {issued && (
        <div className="mt-3 rounded-xl bg-amber-100 p-3 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          <p className="font-black">鍵ができました。この画面を閉じると、二度と表示されません。いま控えてください。</p>
          <p className="mt-2 font-semibold">鍵</p>
          <code className="mt-1 block break-all rounded bg-white/70 p-2 dark:bg-black/30">{issued.token}</code>
          <p className="mt-2 font-semibold">つなぎ先（URL）</p>
          <code className="mt-1 block break-all rounded bg-white/70 p-2 dark:bg-black/30">{url}</code>
          <p className="mt-2 font-semibold">Claude Code の場合（端末で 1 回実行）</p>
          <code className="mt-1 block break-all rounded bg-white/70 p-2 dark:bg-black/30">{`claude mcp add --transport http account-migrate ${url} --header "Authorization: Bearer ${issued.token}"`}</code>
          <p className="mt-2 font-semibold">Claude Desktop の場合（設定ファイル claude_desktop_config.json の mcpServers に足す）</p>
          <code className="mt-1 block whitespace-pre-wrap break-all rounded bg-white/70 p-2 dark:bg-black/30">
            {JSON.stringify({ "account-migrate": { command: "npx", args: ["-y", "mcp-remote", url, "--header", "Authorization:${AUTH_HEADER}"], env: { AUTH_HEADER: `Bearer ${issued.token}` } } }, null, 2)}
          </code>
          <p className="mt-2">鍵は、パスワードと同じように扱ってください。人に見せたり、チャットに貼ったりしないでください。</p>
          <button type="button" className={`${ghost} mt-2`} onClick={() => setIssued(null)}>控えたので閉じる</button>
        </div>
      )}

      {state.grants.length > 0 && (
        <ul className="mt-3 space-y-2">
          {state.grants.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-neutral-100 p-3 text-xs dark:bg-neutral-800/60">
              <div className="min-w-0">
                <p className="font-bold break-all">
                  {g.name}
                  <span className="ml-2 font-normal text-neutral-500">{g.kind === "oauth" ? `ログインして許可${g.verifiedHost ? `（${g.verifiedHost}）` : "（身元は未確認）"}` : `${g.hint}…`}</span>
                </p>
                <p className="mt-0.5 text-neutral-500">
                  見せるアドレス：{g.mailboxes ? g.mailboxes.join("、") || "（なし）" : "すべて"} ／ 最後に使った日：{g.last_used_at ? day(g.last_used_at) : "まだ"} ／ 直近 24 時間 {g.calls24h} 回
                </p>
              </div>
              <button type="button" className={ghost} onClick={() => void revoke(g)}>取り消す</button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 space-y-2 text-xs">
        <p className="font-black">鍵でつなぐ（許可の画面を出せない AI 秘書や、自分で設定を書くとき）</p>
        <label className="block font-semibold">
          鍵の名前（どの AI 秘書に渡すか）
          <input className={`${input} mt-1`} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
        </label>
        {state.mailboxes.length > 0 && (
          <fieldset>
            <legend className="font-semibold">見せるアドレス</legend>
            {state.mailboxes.map((m) => (
              <label key={m.id} className="mt-1 flex items-center gap-2">
                <input type="checkbox" checked={!scope || scope.includes(m.id)} onChange={(e) => toggle(m.id, e.target.checked)} />
                <span className="break-all">{m.email}</span>
              </label>
            ))}
          </fieldset>
        )}
        <button type="button" className={primary} disabled={busy || (scope !== null && scope.length === 0)} onClick={() => void create()}>
          鍵を作る
        </button>
      </div>
    </section>
  );
}

/** やめるまでの進み具合。3 つの条件を順に見せ、全部そろったら「やめて大丈夫」と出す */
function GraduationPanel({ g }: { g: Graduation }) {
  const steps: [boolean, string][] = [
    ...(g.scanned ? [] : ([[false, "まず「調べる」を押して、最後まで調べてください"]] as [boolean, string][])),
    [g.todo === 0, g.todo === 0 ? "頼っているサービスは、すべて仕分けました" : `頼っている（かもしれない）サービスが、あと ${g.todo} 件あります。「移行する」→「変更できた」か、「不要」に仕分けてください`],
    [g.leaking === 0, g.leaking === 0 ? "「変更できた」にしたサービスから、そのあと重要なメールは届いていません" : `「変更できた」にしたのに、まだ重要なメールが届いているサービスが ${g.leaking} 件あります`],
    [
      g.waitDays === 0,
      g.quietDays === null
        ? "重要なメールは、1 通も見つかっていません"
        : g.waitDays === 0
          ? `重要なメールが届かなくなって ${g.quietDays} 日たちました（目安は ${QUIET_DAYS} 日）`
          : `重要なメールが最後に届いたのは ${day(g.lastNeededAt)}（${g.quietDays} 日前）です。あと ${g.waitDays} 日、届かないことを確かめます`,
    ],
  ];
  return (
    <div className={`mt-2 rounded-xl p-3 text-xs ${g.ready ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100" : "bg-white text-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"}`}>
      <p className="text-sm font-black">{g.ready ? "🎉 このアドレスは、やめて大丈夫です" : "まだ、やめないでください"}</p>
      <ul className="mt-1 space-y-1">
        {steps.map(([ok, text]) => (
          <li key={text}>{ok ? "✅" : "⬜"} {text}</li>
        ))}
      </ul>
      {g.ready && <p className="mt-1 text-neutral-600 dark:text-neutral-300">念のため、やめる前に、銀行・役所・家族との連絡など、メールが年に 1 回しか来ない大事な相手がいないか思い出してください。</p>}
    </div>
  );
}

/** メールボックスごとの内訳：必要なメール（ログイン・登録・支払い）と、広告 */
function KindSummary({ kinds }: { kinds: Partial<Record<Kind, number>> }) {
  const n = (k: Kind) => kinds[k] ?? 0;
  const login = n("auth") + n("security") + n("password");
  const needed = login + n("signup") + n("billing");
  if (!needed && !n("promo") && !n("notice")) return null;
  return (
    <div className="mt-2 text-xs text-neutral-600 dark:text-neutral-300">
      <p>
        必要なメール <b>{needed.toLocaleString()}</b> 通（うちログイン・本人確認 <b>{login.toLocaleString()}</b> 通）／ 広告 <b>{n("promo").toLocaleString()}</b> 通
        {n("notice") > 0 && <>／ そのほかのお知らせ {n("notice").toLocaleString()} 通</>}
      </p>
      <p className="mt-0.5 text-neutral-500">
        {KINDS.filter((k) => k !== "promo" && k !== "notice" && kinds[k]).map((k) => `${KIND_LABEL[k]} ${n(k).toLocaleString()}`).join("・")}
      </p>
    </div>
  );
}

function Setup({ setup, origin }: { setup: AppState["setup"]; origin: string }) {
  const uri = `${origin}/api/migrate/oauth/callback`;
  return (
    <section className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
      <h2 className="font-black">はじめの設定</h2>
      <ol className="mt-2 list-decimal space-y-2 pl-5">
        <li className={setup.db ? "opacity-50" : ""}>
          {setup.db ? "✅ " : ""}データベース（Vercel につないだ Neon。環境変数 <code>DATABASE_URL</code>）を用意する。表は自動で作られます。
        </li>
        <li className={setup.google ? "opacity-50" : ""}>
          {setup.google ? "✅ " : ""}Google Cloud で OAuth クライアント（種類：ウェブ アプリケーション）を作り、「承認済みのリダイレクト URI」に次を登録する。
          <code className="mt-1 block break-all rounded bg-white/70 p-2 text-xs dark:bg-black/30">{uri}</code>
          できたクライアント ID とシークレットを、Vercel の環境変数 <code>GOOGLE_MIGRATE_CLIENT_ID</code>・<code>GOOGLE_MIGRATE_CLIENT_SECRET</code> に入れて、デプロイし直す。
        </li>
      </ol>
    </section>
  );
}
