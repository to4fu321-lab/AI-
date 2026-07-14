import "server-only";
import { createClient } from "@supabase/supabase-js";

/**
 * service_role key を使う管理用クライアント。RLSを無視して書き込める。
 * API Route（サーバー）以外からは絶対に import しないこと。
 */
export function getSupabaseAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) return null;

  return createClient(url, serviceKey, {
    auth: { persistSession: false },
  });
}
