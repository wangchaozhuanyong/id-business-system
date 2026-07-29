import { validateEnv } from './env.validation';

describe('validateEnv', () => {
  it('uses the current local auth and exchange-rate defaults', () => {
    expect(validateEnv({ NODE_ENV: 'development' })).toMatchObject({
      NODE_ENV: 'development',
      APP_PORT: '3000',
      AUTH_PROVIDER: 'local',
      ID_BUSINESS_V2_EXCHANGE_RATE_AUTO_ENABLED: 'true',
      ID_BUSINESS_V2_EXCHANGE_RATE_RUN_ON_STARTUP: 'false',
      ID_BUSINESS_V2_FREE_MANUAL_MODE: 'false',
      ID_BUSINESS_V2_EXCHANGE_RATE_STALE_MS: '600000'
    });
  });

  it('requires production database, CORS and local secrets', () => {
    expect(() => validateEnv({ NODE_ENV: 'production' })).toThrow(
      'CORS_ORIGIN is required in production'
    );

    expect(() =>
      validateEnv({
        NODE_ENV: 'production',
        CORS_ORIGIN: 'https://admin.example.test',
        DATABASE_URL: 'postgresql://user:password@db.example.test/app',
        FIELD_ENCRYPTION_KEY: 'a'.repeat(32),
        HASH_SECRET: 'b'.repeat(32),
        JWT_SECRET: 'c'.repeat(32)
      })
    ).toThrow('CORS_ORIGIN must be configured with a production-safe value');
  });

  it('validates Supabase auth configuration', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'development',
        AUTH_PROVIDER: 'supabase',
        SUPABASE_URL: 'https://project.supabase.co'
      })
    ).toThrow('SUPABASE_ANON_KEY or SUPABASE_PUBLISHABLE_KEY is required');

    expect(() =>
      validateEnv({
        NODE_ENV: 'development',
        AUTH_PROVIDER: 'supabase',
        SUPABASE_URL: 'https://project.supabase.co',
        SUPABASE_PUBLISHABLE_KEY: 'publishable-key',
        SUPABASE_SECRET_KEY: 'secret-key'
      })
    ).not.toThrow();
  });

  it('rejects removed runtime targets', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://postgres:password@db.uperydhdwgzvakyskask.supabase.co/postgres'
      })
    ).toThrow('指向已删除的系统');
  });

  it('validates exchange-rate runtime settings', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'development',
        ID_BUSINESS_V2_EXCHANGE_RATE_AUTO_ENABLED: 'yes'
      })
    ).toThrow('ID_BUSINESS_V2_EXCHANGE_RATE_AUTO_ENABLED must be true or false');

    expect(() =>
      validateEnv({
        NODE_ENV: 'development',
        ID_BUSINESS_V2_EXCHANGE_RATE_STALE_MS: '1000'
      })
    ).toThrow('ID_BUSINESS_V2_EXCHANGE_RATE_STALE_MS must be between 60000 and 3600000');
  });
});
