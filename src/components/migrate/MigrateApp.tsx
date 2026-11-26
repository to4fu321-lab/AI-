"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { KINDS, type Kind } from "@/lib/migrate/classify";
import { LEVEL_LABEL, type Level } from "@/lib/migrate/judge";
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
  scope: "メールを読む許可（読み取りのみ）を受け取れませんでした。もう一度つないで、チェックを入れて許可してください。",
  unverified: "メールアドレスの確認が済んでいない Google アカウントでは、ログインできません。",
  failed: "うまくいきませんでした。もう一度やり直してください。",
};
const STATUSES: Status[] = ["new", "move", "skip", "done"];
const day = (iso: string | null) => (iso ? iso.slice(0, 10).replace(/-/g, "/") : "");
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
                {ready && <button type="button" className={primary} onClick={() => window.location.assign("/api/migrate/oauth/connect")}>＋ Gmail をつなぐ</button>}
              </div>
              <p className="mt-1 text-xs text-neutral-500">読むだけの許可でつなぎます。読むのは差出人・件名・日付などのヘッダだけで、本文は読みません。件名の中の数字（認証コードや注文番号）は、伏せてから記録します。</p>
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
                          ? `調べています…${m.remaining ? ` 残り ${m.remaining.toLocaleString()} 通` : ""}（これまで ${m.scanned.toLocaleString()} 通）。画面を閉じても続きます`
                          : m.last_scan
                            ? `${day(m.last_scan)} に調べました（これまで ${m.scanned.toLocaleString()} 通）`
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
                    </li>
                  );
                })}
              </ul>
            </section>

            {state.services.length > 0 && (
              <section className="space-y-3">
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
          <p className="truncate text-xs text-neutral-500">{s.name ? `差出人の名乗り：${s.name}` : ""}{s.name && email ? " ・ " : ""}{email ?? ""}</p>
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
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {s.status !== "skip" && (
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

/** メールボックスごとの内訳：必要なメール（ログイン・登録・支払いなど）と、広告 */
function KindSummary({ kinds }: { kinds: Partial<Record<Kind, number>> }) {
  const total = KINDS.reduce((a, k) => a + (kinds[k] ?? 0), 0);
  if (!total) return null;
  const promo = kinds.promo ?? 0;
  const login = (kinds.auth ?? 0) + (kinds.security ?? 0) + (kinds.password ?? 0);
  return (
    <div className="mt-2 text-xs text-neutral-600 dark:text-neutral-300">
      <p>
        必要なメール <b>{(total - promo).toLocaleString()}</b> 通（うちログイン・本人確認 <b>{login.toLocaleString()}</b> 通）／ 広告 <b>{promo.toLocaleString()}</b> 通
      </p>
      <p className="mt-0.5 text-neutral-500">
        {KINDS.filter((k) => k !== "promo" && kinds[k]).map((k) => `${KIND_LABEL[k]} ${kinds[k]!.toLocaleString()}`).join("・")}
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
