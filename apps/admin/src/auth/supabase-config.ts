const supabaseUrl = String(import.meta.env.VITE_SUPABASE_URL ?? '').trim();
const supabaseKey = String(
  import.meta.env.VITE_SUPABASE_ANON_KEY ?? import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? ''
).trim();

export function getSupabaseAuthConfig() {
  if (!supabaseUrl || !supabaseKey) return null;

  return {
    key: supabaseKey,
    url: supabaseUrl.replace(/\/$/, '')
  };
}

export function isSupabaseAuthConfigured() {
  return Boolean(getSupabaseAuthConfig());
}
