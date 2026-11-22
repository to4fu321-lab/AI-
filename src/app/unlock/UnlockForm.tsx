"use client";

import { useActionState } from "react";
import { unlock, type UnlockState } from "./actions";

export function UnlockForm({ lockKey, next }: { lockKey: string; next: string }) {
  const [state, action, pending] = useActionState<UnlockState, FormData>(unlock, {});
  return (
    <form action={action} className="mt-5 space-y-3">
      <input type="hidden" name="key" value={lockKey} />
      <input type="hidden" name="next" value={next} />
      <input
        type="password"
        name="password"
        required
        autoFocus
        autoComplete="current-password"
        placeholder="パスワード"
        className="w-full rounded-full border border-neutral-200 bg-neutral-50 px-4 py-3 text-[16px] outline-none focus:border-fuchsia-400 focus:bg-white dark:border-neutral-700 dark:bg-neutral-950"
      />
      {state.error && <p className="text-center text-sm text-red-500">{state.error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-full bg-fuchsia-500 py-3 text-sm font-bold text-white shadow-sm shadow-fuchsia-500/30 disabled:opacity-60"
      >
        {pending ? "確認中…" : "開く"}
      </button>
      <p className="text-center text-[11px] text-neutral-400">一度開くと、この端末では 30 日間入力不要です</p>
    </form>
  );
}
