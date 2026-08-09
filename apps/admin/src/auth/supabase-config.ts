export interface SupabaseAuthEnvironment {
  url?: string;
  anonKey?: string;
  publishableKey?: string;
}

export function resolveSupabaseAuthConfig(environment: SupabaseAuthEnvironment) {
  const url = String(environment.url ?? '').trim();
  const key = [environment.anonKey, environment.publishableKey]
    .map((value) => value?.trim())
    .find(Boolean);

  if (!url || !key) return null;

  return {
    key,
    url: url.replace(/\/$/, '')
  };
}

const supabaseAuthConfig = resolveSupabaseAuthConfig({
  url: import.meta.env.VITE_SUPABASE_URL,
  anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
  publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
});

export function getSupabaseAuthConfig() {
  return supabaseAuthConfig;
}

export function isSupabaseAuthConfigured() {
  return Boolean(getSupabaseAuthConfig());
}
