import {
  createClient,
  type AuthChangeEvent,
  type Session,
  type Subscription
} from '@supabase/supabase-js';
import { getSupabaseAuthConfig } from '@/auth/supabase-config';

const supabaseConfig = getSupabaseAuthConfig();

const supabase = supabaseConfig
  ? createClient(supabaseConfig.url, supabaseConfig.key, {
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: false,
        persistSession: true
      }
    })
  : null;

export async function getSupabaseSession() {
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

export async function setSupabaseSession(accessToken: string, refreshToken: string) {
  if (!supabase) return null;
  const { data, error } = await supabase.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken
  });
  if (error) throw error;
  return data.session;
}

export async function clearSupabaseSession() {
  if (!supabase) return;
  await supabase.auth.signOut({ scope: 'local' });
}

export function subscribeSupabaseSession(
  listener: (event: AuthChangeEvent, session: Session | null) => void
): Subscription | null {
  if (!supabase) return null;
  return supabase.auth.onAuthStateChange(listener).data.subscription;
}
