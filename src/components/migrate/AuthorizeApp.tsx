"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { AuthorizationInfo } from "@/lib/migrate/oauth";
import type { AppState } from "@/lib/migrate/types";

/**
 * AI 秘書（Claude など）が「つなぎたい」と申し込んできたときに、利用者が許可する・しないを決める画面。
 * 申し込みの中身（相手・戻り先）は、サーバーが確かめて覚えているものだけを出す（URL から受け取るのは、申し込みの番号だけ）。
 * 答えは、この画面からの操作としてサーバーへ送る（ほかのサイトからは送れない）。
 */

async function api<T>(
  action: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(`/api/migrate/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(json.error ?? `うまくいきませんでした（${res.status}）`);
  return json as T;
}
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const card =
  "rounded-2xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900";
const primary =
  "rounded-full bg-emerald-600 px-5 py-3 text-sm font-bold text-white disabled:opacity-40";
const ghost =
  "rounded-full bg-neutral-200/80 px-5 py-3 text-sm font-semibold text-neutral-700 disabled:opacity-40 dark:bg-neutral-800 dark:text-neutral-200";

const LOGIN_ERROR: Record<string, string> = {
  denied: "Google で許可されませんでした。",
  "bad-state": "手続きの確認ができませんでした。もう一度ログインしてください。",
  unverified:
    "メールアドレスの確認が済んでいない Google アカウントでは、ログインできません。",
  "not-configured": "Google Cloud の設定がまだです。",
  failed: "うまくいきませんでした。もう一度やり直してください。",
};

export function AuthorizeApp() {
  const [req, setReq] = useState<string | null>(null);
  const [state, setState] = useState<AppState | null>(null);
  const [info, setInfo] = useState<AuthorizationInfo | null>(null);
  const [scope, setScope] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [gone, setGone] = useState("");
  const [busy, setBusy] = useState(false);

  // URL から読んだもの。読むのは 1 回だけ（読んだら URL から消すので、2 回目には残っていない）
  const fromUrl = useRef<{ id: string; result: string | null } | null>(null);

  useEffect(() => {
    if (!fromUrl.current) {
      const p = new URLSearchParams(window.location.search);
      fromUrl.current = { id: p.get("req") ?? "", result: p.get("result") };
      // 申し込みの番号は、読んだら URL から消す（履歴や共有で残さない）
      window.history.replaceState(null, "", window.location.pathname);
    }
    const { id, result } = fromUrl.current;
    void (async () => {
      setReq(id);
      if (result && result !== "login")
        setError(LOGIN_ERROR[result] ?? LOGIN_ERROR.failed);
      try {
        const s = await api<AppState>("state");
        setState(s);
        if (s.user)
          setInfo(await api<AuthorizationInfo>("authorizeInfo", { req: id }));
      } catch (e) {
        setGone(message(e));
      }
    })();
  }, []);

  const decide = async (approve: boolean) => {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ redirect: string }>("authorizeDecide", {
        req,
        approve,
        mailboxIds: scope,
      });
      window.location.replace(r.redirect);
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };
  const boxes = state?.mailboxes ?? [];
  const toggle = (id: string, on: boolean) => {
    const current = scope ?? boxes.map((m) => m.id);
    const next = on
      ? [...new Set([...current, id])]
      : current.filter((x) => x !== id);
    setScope(next.length === boxes.length ? null : next);
  };

  return (
    <div className="min-h-dvh bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <main className="mx-auto max-w-xl space-y-4 p-4">
        <h1 className="pt-4 text-xl font-black">AI 秘書をつなぐ許可</h1>

        {error && (
          <p className="rounded-xl bg-rose-100 p-3 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-200">
            {error}
          </p>
        )}

        {gone ? (
          <section className={card}>
            <p className="text-sm">{gone}</p>
            <p className="mt-3 text-xs">
              <Link className="underline" href="/migrate">
                アカウント引っ越しへ
              </Link>
            </p>
          </section>
        ) : !state ? (
          <p className="text-sm text-neutral-500">読み込んでいます…</p>
        ) : !state.user ? (
          <section className={card}>
            <p className="text-sm">
              AI
              秘書をつなぐには、まずアカウント引っ越しにログインしてください。ログインのあと、この画面に戻ります。
            </p>
            <a
              className={`${primary} mt-4 inline-block`}
              href={`/api/migrate/oauth/login?${new URLSearchParams({ req: req ?? "" })}`}
            >
              Google でログイン
            </a>
          </section>
        ) : !info ? (
          <p className="text-sm text-neutral-500">読み込んでいます…</p>
        ) : (
          <>
            <section className={card}>
              <p className="text-sm">
                <b className="break-all text-base">{info.name}</b>{" "}
                が、あなたのアカウント引っ越しのデータを読みたいと言っています。
              </p>
              <dl className="mt-3 space-y-2 text-xs">
                <div>
                  <dt className="font-semibold text-neutral-500">相手の身元</dt>
                  <dd className="mt-0.5">
                    {info.verifiedHost ? (
                      <>
                        <b className="break-all">{info.publishedAt}</b>{" "}
                        に公開されている情報で確かめました。知っている AI 秘書の住所かどうかを、見てください。
                      </>
                    ) : (
                      <span className="text-amber-700 dark:text-amber-300">
                        確かめられていません。上の名前は、相手が自分で名乗っているだけです。
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="font-semibold text-neutral-500">
                    許可のあとに戻る先
                  </dt>
                  <dd className="mt-0.5">
                    <b className="break-all">{info.redirectHost}</b>
                    {info.loopback && "（この端末の中で動いているアプリ）"}
                  </dd>
                </div>
                <div>
                  <dt className="font-semibold text-neutral-500">
                    ログイン中のアカウント
                  </dt>
                  <dd className="mt-0.5 break-all">{state.user.email}</dd>
                </div>
              </dl>
              <p className="mt-3 rounded-xl bg-amber-100 p-3 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100">
                自分で AI
                秘書の設定画面から始めた手続きのときだけ、許可してください。メールやメッセージで届いたリンクからこの画面に来た場合は、許可しないでください。
              </p>
            </section>

            <section className={card}>
              <h2 className="text-sm font-black">
                許可すると、できるようになること
              </h2>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
                <li>
                  登録サービスの台帳を読む（どのサービスが、どのアドレスに頼っているか）
                </li>
                <li>
                  メールの記録を探す（差出人・件名・日付・種類。本文は保存していないので、渡りません）
                </li>
                <li>
                  認証コードやログイン通知が「届いたこと」を知る（コードそのものは渡りません）
                </li>
                <li>新しく届いた分の取り込みを始める</li>
              </ul>
              <p className="mt-2 text-xs text-neutral-500">
                メールを送る・消す・書き換えることは、できません。許可は、アカウント引っ越しの画面からいつでも取り消せます。
              </p>

              {boxes.length > 0 && (
                <fieldset className="mt-4 text-xs">
                  <legend className="text-sm font-black">見せるアドレス</legend>
                  {boxes.map((m) => (
                    <label key={m.id} className="mt-2 flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={!scope || scope.includes(m.id)}
                        onChange={(e) => toggle(m.id, e.target.checked)}
                      />
                      <span className="break-all">{m.email}</span>
                    </label>
                  ))}
                  <p className="mt-2 text-neutral-500">
                    {scope
                      ? "選んだアドレスだけを見せます。"
                      : "すべて見せます（あとからつないだアドレスも含みます）。"}
                  </p>
                </fieldset>
              )}
            </section>

            <div className="flex flex-wrap gap-3 pb-8">
              <button
                type="button"
                className={primary}
                disabled={busy || (scope !== null && scope.length === 0)}
                onClick={() => void decide(true)}
              >
                許可する
              </button>
              <button
                type="button"
                className={ghost}
                disabled={busy}
                onClick={() => void decide(false)}
              >
                許可しない
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
