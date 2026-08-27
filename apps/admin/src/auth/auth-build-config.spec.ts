import { describe, expect, it } from 'vitest';
import { validateAuthBuildConfiguration } from './auth-build-config';

describe('validateAuthBuildConfiguration', () => {
  it('accepts a local-auth production build', () => {
    expect(() =>
      validateAuthBuildConfiguration('production', {
        AUTH_PROVIDER: 'local'
      })
    ).not.toThrow();
  });

  it('rejects any non-local authentication provider', () => {
    expect(() =>
      validateAuthBuildConfiguration('production', {
        AUTH_PROVIDER: 'external'
      })
    ).toThrow('AUTH_PROVIDER must be local');
  });

  it('rejects service credentials in frontend variables', () => {
    expect(() =>
      validateAuthBuildConfiguration('production', {
        AUTH_PROVIDER: 'local',
        VITE_DATABASE_SECRET_KEY: 'server-only-secret'
      })
    ).toThrow('must never be exposed');
  });
});
