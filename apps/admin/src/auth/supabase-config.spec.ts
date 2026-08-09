import { describe, expect, it } from 'vitest';
import { resolveSupabaseAuthConfig } from './supabase-config';

describe('resolveSupabaseAuthConfig', () => {
  it('uses the publishable key when the legacy anon key is blank', () => {
    expect(
      resolveSupabaseAuthConfig({
        url: ' https://project.supabase.co/ ',
        anonKey: ' ',
        publishableKey: ' publishable-key '
      })
    ).toEqual({
      key: 'publishable-key',
      url: 'https://project.supabase.co'
    });
  });

  it('requires both a URL and a non-empty public key', () => {
    expect(resolveSupabaseAuthConfig({ url: '', publishableKey: 'publishable-key' })).toBeNull();
    expect(
      resolveSupabaseAuthConfig({ url: 'https://project.supabase.co', anonKey: ' ' })
    ).toBeNull();
  });
});
