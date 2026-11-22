"use client";

import { useState } from "react";
import { defaultRules, KINDS, type Site, type SiteKind, type SiteRules } from "@/lib/autopost/types";
import { api, card, ghost, input, primary } from "./api";

interface Draft {
  id?: string;
  kind: SiteKind;
  name: string;
  enabled: boolean;
  auto: boolean;
  rules: SiteRules;
  creds: Record<string, string>;
  credFields: string[];
}

function SiteForm({ initial, onSaved, onClose }: { initial: Draft; onSaved: () => Promise<void>; onClose: () => void }) {
  const [d, setD] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [shown, setShown] = useState<Record<string, string> | null>(null);
  const info = KINDS[d.kind];
  const rule = (patch: Partial<SiteRules>) => setD((x) => ({ ...x, rules: { ...x.rules, ...patch } }));

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    run(async () => {
      await api("siteSave", { ...d });
      await onSaved();
      onClose();
    });
  const remove = () =>
    run(async () => {
      if (!confirm(`「${d.name}」を消します。この投稿先の下書きと投稿の記録も消えます。`)) return;
      await api("siteDelete", { id: d.id });
      await onSaved();
      onClose();
    });

  return (
    <div className={`${card} space-y-4 border-fuchsia-300 dark:border-fuchsia-900`}>
      <h3 className="text-base font-black">{info.emoji} {info.label}</h3>
      <p className="text-xs leading-relaxed text-neutral-500">{info.help}</p>

      <label className="block text-sm font-semibold">
        名前
        <input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} className={`${input} mt-1`} />
      </label>
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm font-semibold">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.target.checked })} className="h-5 w-5" />
          使う
        </label>
        {info.autoPost && (
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={d.auto} onChange={(e) => setD({ ...d, auto: e.target.checked })} className="h-5 w-5" />
            「おまかせ」で投稿まで進める
          </label>
        )}
      </div>

      <fieldset className="space-y-3 rounded-xl bg-neutral-100 p-3 dark:bg-neutral-800/60">
        <legend className="px-1 text-xs font-bold text-neutral-500">文の決まり</legend>
        <label className="block text-sm font-semibold">
          本文に必ず入れる文
          <textarea value={d.rules.required} onChange={(e) => rule({ required: e.target.value })} rows={2} placeholder="例：ご予約はプロフィールのリンクから" className={`${input} mt-1`} />
          <span className="text-xs font-normal text-neutral-500">AI が入れ忘れても、一字一句そのまま末尾に足します。</span>
        </label>
        <label className="block text-sm font-semibold">
          必ず付けるハッシュタグ（空白で区切る）
          <input value={d.rules.hashtags} onChange={(e) => rule({ hashtags: e.target.value })} placeholder="#北海道 #グルメ" className={`${input} mt-1`} />
        </label>
        <label className="block text-sm font-semibold">
          口調・書き方
          <textarea value={d.rules.tone} onChange={(e) => rule({ tone: e.target.value })} rows={2} placeholder="例：親しみやすく、絵文字は 2 個まで。最初の 1 行で内容がわかるように" className={`${input} mt-1`} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          {info.usesTitle && (
            <label className="block text-sm font-semibold">
              題名の上限（字）
              <input type="number" min={1} value={d.rules.titleMax} onChange={(e) => rule({ titleMax: Number(e.target.value) })} className={`${input} mt-1`} />
            </label>
          )}
          <label className="block text-sm font-semibold">
            本文の上限（字）
            <input type="number" min={1} value={d.rules.bodyMax} onChange={(e) => rule({ bodyMax: Number(e.target.value) })} className={`${input} mt-1`} />
          </label>
        </div>
        {d.kind === "youtube" && (
          <label className="block text-sm font-semibold">
            公開範囲
            <select value={d.rules.privacy} onChange={(e) => rule({ privacy: e.target.value as SiteRules["privacy"] })} className={`${input} mt-1`}>
              <option value="private">非公開（自分だけ。あとで YouTube で公開に変える）</option>
              <option value="unlisted">限定公開（URL を知っている人だけ）</option>
              <option value="public">公開</option>
            </select>
          </label>
        )}
        {d.kind === "manual" && (
          <label className="block text-sm font-semibold">
            投稿ページの URL
            <input type="url" value={d.rules.postUrl} onChange={(e) => rule({ postUrl: e.target.value })} placeholder="https://" className={`${input} mt-1`} />
          </label>
        )}
      </fieldset>

      {info.creds.length > 0 && (
        <fieldset className="space-y-3 rounded-xl bg-neutral-100 p-3 dark:bg-neutral-800/60">
          <legend className="px-1 text-xs font-bold text-neutral-500">🔐 {d.kind === "manual" ? "ログイン情報の控え" : "API の鍵"}（暗号化して保存）</legend>
          {info.creds.map((f) => {
            const saved = d.credFields.includes(f.key);
            return (
              <label key={f.key} className="block text-sm font-semibold">
                {f.label} {saved && <span className="text-xs font-normal text-emerald-600">✓ 保存済み</span>}
                <input
                  type={f.secret ? "password" : "text"}
                  autoComplete="off"
                  value={d.creds[f.key] ?? ""}
                  onChange={(e) => setD({ ...d, creds: { ...d.creds, [f.key]: e.target.value } })}
                  placeholder={saved ? "変えるときだけ入力" : ""}
                  className={`${input} mt-1`}
                />
                {shown?.[f.key] && <span className="mt-1 block select-all break-all font-mono text-xs font-normal">{shown[f.key]}</span>}
              </label>
            );
          })}
          {d.kind === "manual" && d.id && d.credFields.length > 0 && (
            <button type="button" disabled={busy} onClick={() => (shown ? setShown(null) : run(async () => setShown((await api<{ creds: Record<string, string> }>("siteSecret", { id: d.id })).creds)))} className="text-xs font-semibold text-fuchsia-600">
              {shown ? "🙈 隠す" : "👁 保存した内容を表示"}
            </button>
          )}
          {d.kind === "youtube" && d.id && d.credFields.includes("clientId") && (
            <div className="flex items-center gap-3">
              <a href={`/api/autopost/oauth/start?site=${d.id}`} className={ghost}>🔗 Google と連携{d.credFields.includes("refreshToken") ? "し直す" : ""}</a>
              <span className={`text-xs font-semibold ${d.credFields.includes("refreshToken") ? "text-emerald-600" : "text-amber-600"}`}>
                {d.credFields.includes("refreshToken") ? "✓ 連携済み" : "まだ連携していません"}
              </span>
            </div>
          )}
        </fieldset>
      )}

      {error && <p className="text-sm font-semibold text-red-600">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={save} className={`${primary} flex-1`}>保存</button>
        <button type="button" disabled={busy} onClick={onClose} className={ghost}>閉じる</button>
        {d.id && <button type="button" disabled={busy} onClick={remove} className={`${ghost} text-red-600 dark:text-red-400`}>消す</button>}
      </div>
    </div>
  );
}

export function SitesTab({ sites, onChanged }: { sites: Site[]; onChanged: () => Promise<void> }) {
  const [editing, setEditing] = useState<Draft | null>(null);
  const hasOwn = sites.some((s) => s.kind === "own");

  if (editing) return <SiteForm key={editing.id ?? editing.kind} initial={editing} onSaved={onChanged} onClose={() => setEditing(null)} />;
  return (
    <div className="space-y-4">
      {sites.length === 0 && <p className={`${card} text-sm text-neutral-500`}>まだ投稿先がありません。下から足してください。</p>}
      {sites.map((s) => {
        const info = KINDS[s.kind];
        const ready = info.creds.every((f) => s.credFields.includes(f.key)) && (s.kind !== "youtube" || s.credFields.includes("refreshToken"));
        return (
          <button key={s.id} type="button" onClick={() => setEditing({ ...s, creds: {} })} className={`${card} flex w-full items-center gap-3 text-left ${s.enabled ? "" : "opacity-50"}`}>
            <span className="text-2xl">{info.emoji}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-bold">{s.name}</span>
              <span className="block truncate text-xs text-neutral-500">
                {info.label}
                {s.rules.required && ` ・必ず入れる文あり`}
                {!s.enabled && " ・停止中"}
              </span>
            </span>
            {info.autoPost && s.kind !== "own" && (
              <span className={`shrink-0 rounded-full px-2 py-1 text-xs font-bold ${ready ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"}`}>
                {ready ? "投稿できます" : "鍵が未設定"}
              </span>
            )}
            <span className="text-neutral-400">›</span>
          </button>
        );
      })}

      <div className={card}>
        <p className="text-sm font-bold">＋ 投稿先を足す</p>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {(Object.keys(KINDS) as SiteKind[])
            .filter((k) => k !== "own" || !hasOwn)
            .map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() => setEditing({ kind, name: kind === "own" ? "メンバー限定シアター" : kind === "manual" ? "" : KINDS[kind].label, enabled: true, auto: true, rules: defaultRules(kind), creds: {}, credFields: [] })}
                className="rounded-xl bg-neutral-100 px-3 py-3 text-left text-sm font-semibold dark:bg-neutral-800"
              >
                {KINDS[kind].emoji} {KINDS[kind].label}
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}
