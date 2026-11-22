"use client";

import Link from "next/link";
import { useState } from "react";
import type { Member } from "@/lib/autopost/types";
import { api, card, ghost, input, primary } from "./api";

/** 会員制動画サイトの会員を管理する（足す・止める・パスワードを変える・消す） */
export function MembersTab({ members, hasOwnSite, onChanged }: { members: Member[]; hasOwnSite: boolean; onChanged: () => Promise<void> }) {
  const [form, setForm] = useState({ loginId: "", name: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const newPassword = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(9));
    setForm((f) => ({ ...f, password: btoa(String.fromCharCode(...bytes)).replace(/[+/]/g, "x") }));
  };

  return (
    <div className="space-y-4">
      <div className={`${card} text-sm leading-relaxed`}>
        <p>
          会員サイトは <Link href="/members" className="font-bold text-fuchsia-600 underline">/members</Link> です。ここで足した会員だけが、ログイン ID とパスワードで動画を見られます。
        </p>
        {!hasOwnSite && <p className="mt-2 font-semibold text-amber-600">「投稿先」に「自分の会員サイト」を足すと、そこへ投稿した動画が会員サイトに並びます。</p>}
      </div>

      <form
        className={`${card} space-y-3`}
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            await api("memberSave", form);
            setForm({ loginId: "", name: "", password: "" });
          });
        }}
      >
        <p className="text-sm font-bold">＋ 会員を足す</p>
        <input value={form.loginId} onChange={(e) => setForm({ ...form, loginId: e.target.value })} placeholder="ログイン ID（半角・メールアドレスでも可）" autoCapitalize="none" autoComplete="off" className={input} />
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="名前（自分用のメモ）" className={input} />
        <div className="flex gap-2">
          <input value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="パスワード（8 文字以上）" autoComplete="off" className={`${input} font-mono`} />
          <button type="button" onClick={newPassword} className={`${ghost} shrink-0`}>🎲 作る</button>
        </div>
        <p className="text-xs text-neutral-500">パスワードは元に戻せない形で保存します。あとから確かめられないので、足す前に控えて本人に伝えてください。</p>
        {error && <p className="text-sm font-semibold text-red-600">{error}</p>}
        <button type="submit" disabled={busy || !form.loginId || !form.password} className={`${primary} w-full`}>会員を足す</button>
      </form>

      {members.map((m) => (
        <div key={m.id} className={`${card} ${m.active ? "" : "opacity-60"}`}>
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <p className="truncate font-bold">{m.login_id}</p>
              <p className="truncate text-xs text-neutral-500">{m.name || "（名前なし）"} ・{m.active ? "見られます" : "停止中"}</p>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={() => run(() => api("memberSave", { id: m.id, active: !m.active }))} className={ghost}>
              {m.active ? "⏸ 止める" : "▶️ 再開"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                const password = prompt(`${m.login_id} の新しいパスワード（8 文字以上）`);
                if (password) run(() => api("memberSave", { id: m.id, password }));
              }}
              className={ghost}
            >
              🔑 パスワードを変える
            </button>
            <button type="button" disabled={busy} onClick={() => confirm(`${m.login_id} を消しますか？`) && run(() => api("memberDelete", { id: m.id }))} className={`${ghost} text-red-600 dark:text-red-400`}>
              消す
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
