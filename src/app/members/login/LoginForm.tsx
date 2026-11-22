"use client";

import { useActionState } from "react";
import { memberLogin, type LoginState } from "../actions";

const field = "w-full rounded-xl border border-neutral-700 bg-neutral-900 px-4 py-3 text-[16px] text-white outline-none focus:border-fuchsia-400";

export function LoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(memberLogin, {});
  return (
    <form action={action} className="mt-6 space-y-3">
      <input name="loginId" defaultValue={state.loginId} placeholder="ログイン ID" autoCapitalize="none" autoComplete="username" required className={field} />
      <input name="password" type="password" placeholder="パスワード" autoComplete="current-password" required className={field} />
      {state.error && <p className="text-sm font-semibold text-red-400">{state.error}</p>}
      <button type="submit" disabled={pending} className="w-full rounded-full bg-fuchsia-600 px-4 py-3 font-bold text-white disabled:opacity-50">
        {pending ? "確かめています…" : "ログイン"}
      </button>
    </form>
  );
}
