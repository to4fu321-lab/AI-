import { createClient } from "@supabase/supabase-js";

/**
 * 公開用クライアント（anon key）。RLSで is_published = true の行だけ読み取れる。
 * ブラウザ・サーバーどちらからも安全に使える。
 */
export function getSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) return null;

  return createClient(url, key, {
    auth: { persistSession: false },
  });
}
