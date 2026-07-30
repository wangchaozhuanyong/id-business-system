import { describe, expect, it } from 'vitest';
import { validateAuthBuildConfiguration } from './auth-build-config';

describe('validateAuthBuildConfiguration', () => {
  it('accepts a local-auth production build without Supabase frontend credentials', () => {
    expect(() =>
      validateAuthBuildConfiguration('production', {
        AUTH_PROVIDER: 'local'
      })
    ).not.toThrow();
  });

  it('accepts matching Supabase backend and frontend configuration', () => {
    expect(() =>
      validateAuthBuildConfiguration('production', {
        AUTH_PROVIDER: 'supabase',
        SUPABASE_URL: 'https://current-project.supabase.co/',
        SUPABASE_SECRET_KEY: 'server-only-secret',
        VITE_SUPABASE_URL: 'https://current-project.supabase.co',
        VITE_SUPABASE_PUBLISHABLE_KEY: 'publishable-key'
      })
    ).not.toThrow();
  });

  it('rejects an incomplete or mismatched Supabase frontend build', () => {
    expect(() =>
      validateAuthBuildConfiguration('production', {
        AUTH_PROVIDER: 'supabase',
        SUPABASE_URL: 'https://current-project.supabase.co'
      })
    ).toThrow('requires matching backend and frontend');

    expect(() =>
      validateAuthBuildConfiguration('production', {
        AUTH_PROVIDER: 'supabase',
        SUPABASE_URL: 'https://backend-project.supabase.co',
        VITE_SUPABASE_URL: 'https://frontend-project.supabase.co',
        VITE_SUPABASE_PUBLISHABLE_KEY: 'publishable-key'
      })
    ).toThrow('must target the same project');
  });

  it('rejects Supabase frontend credentials when the backend uses local auth', () => {
    expect(() =>
      validateAuthBuildConfiguration('production', {
        AUTH_PROVIDER: 'local',
        VITE_SUPABASE_URL: 'https://current-project.supabase.co',
        VITE_SUPABASE_PUBLISHABLE_KEY: 'publishable-key'
      })
    ).toThrow('AUTH_PROVIDER=local');
  });

  it('rejects service credentials in frontend variables', () => {
    expect(() =>
      validateAuthBuildConfiguration('production', {
        AUTH_PROVIDER: 'supabase',
        SUPABASE_URL: 'https://current-project.supabase.co',
        VITE_SUPABASE_URL: 'https://current-project.supabase.co',
        VITE_SUPABASE_PUBLISHABLE_KEY: 'publishable-key',
        VITE_SUPABASE_SERVICE_ROLE_KEY: 'server-only-secret'
      })
    ).toThrow('must never be exposed');
  });
});
