import {
  createClient,
  type AuthChangeEvent,
  type RealtimeChannel,
  type Session,
  type Subscription
} from '@supabase/supabase-js';
import { getSupabaseAuthConfig } from '@/auth/supabase-config';
import { createSupabaseAuthStorage, getSupabaseAuthStorageKey } from '@/auth/supabase-storage';

const supabaseConfig = getSupabaseAuthConfig();

const supabase = supabaseConfig
  ? createClient(supabaseConfig.url, supabaseConfig.key, {
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: false,
        persistSession: true,
        storage: createSupabaseAuthStorage(supabaseConfig.url),
        storageKey: getSupabaseAuthStorageKey(supabaseConfig.url)
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
  return supabase.auth.onAuthStateChange((event, session) => {
    if (session?.access_token) {
      void supabase.realtime.setAuth(session.access_token);
    }
    listener(event, session);
  }).data.subscription;
}

export type SupabaseRealtimeStatus = 'SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' | 'CHANNEL_ERROR';

export async function refreshSupabaseRealtimeAuth() {
  if (!supabase) return false;
  const session = await getSupabaseSession();
  if (!session?.access_token) return false;
  await supabase.realtime.setAuth(session.access_token);
  return true;
}

export function subscribeSupabasePrivateBroadcast(
  topic: string,
  event: string,
  listener: (payload: unknown) => void,
  onStatus: (status: SupabaseRealtimeStatus) => void
): RealtimeChannel | null {
  if (!supabase) return null;
  return supabase
    .channel(topic, {
      config: {
        private: true
      }
    })
    .on('broadcast', { event }, ({ payload }) => listener(payload))
    .subscribe((status) => onStatus(status));
}

export async function removeSupabaseRealtimeChannel(channel: RealtimeChannel | null) {
  if (!supabase || !channel) return;
  await supabase.removeChannel(channel);
}
