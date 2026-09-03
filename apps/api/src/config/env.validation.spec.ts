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
      ID_BUSINESS_V2_EXCHANGE_RATE_STALE_MS: '600000',
      ID_BUSINESS_V2_MEDIA_RESOLVER_URL: 'http://127.0.0.1:8787'
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
        DATABASE_URL: 'mysql://user:password@mysql.example.test/app',
        FIELD_ENCRYPTION_KEY: 'a'.repeat(32),
        HASH_SECRET: 'b'.repeat(32),
        JWT_SECRET: 'c'.repeat(32)
      })
    ).toThrow('CORS_ORIGIN must be configured with a production-safe value');
  });

  it('only accepts local authentication', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'development',
        AUTH_PROVIDER: 'external'
      })
    ).toThrow('AUTH_PROVIDER must be local');
  });

  it('accepts a MySQL production database', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'production',
        APP_PUBLIC_URL: 'https://admin.company.io',
        CORS_ORIGIN: 'https://admin.company.io',
        DATABASE_URL: 'mysql://user:password@mysql.company.io/id_business',
        FIELD_ENCRYPTION_KEY: 'f'.repeat(32),
        HASH_SECRET: 'h'.repeat(32),
        JWT_SECRET: 'j'.repeat(32),
        MICROSOFT_MAIL_OAUTH_CLIENT_ID: '11111111-1111-4111-8111-111111111111',
        MICROSOFT_MAIL_OAUTH_CLIENT_SECRET: 'm'.repeat(32),
        MICROSOFT_MAIL_OAUTH_REDIRECT_URI:
          'https://admin.company.io/api/public/mailbox/microsoft-oauth/callback',
        ID_BUSINESS_V2_MEDIA_RESOLVER_URL: 'http://media-resolver:8787'
      })
    ).not.toThrow();
  });

  it('rejects a PostgreSQL production database for the current runtime', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'production',
        APP_PUBLIC_URL: 'https://admin.company.io',
        CORS_ORIGIN: 'https://admin.company.io',
        DATABASE_URL: 'postgresql://user:password@postgres.company.io/id_business',
        FIELD_ENCRYPTION_KEY: 'f'.repeat(32),
        HASH_SECRET: 'h'.repeat(32),
        JWT_SECRET: 'j'.repeat(32),
        MICROSOFT_MAIL_OAUTH_CLIENT_ID: '11111111-1111-4111-8111-111111111111',
        MICROSOFT_MAIL_OAUTH_CLIENT_SECRET: 'm'.repeat(32),
        MICROSOFT_MAIL_OAUTH_REDIRECT_URI:
          'https://admin.company.io/api/public/mailbox/microsoft-oauth/callback'
      })
    ).toThrow('DATABASE_URL must use mysql:// in production');
  });

  it('requires Microsoft mail OAuth settings as a complete set', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'development',
        MICROSOFT_MAIL_OAUTH_CLIENT_ID: 'client-id'
      })
    ).toThrow('Microsoft mail OAuth configuration must be provided as a complete set');
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

  it('keeps the production media resolver on the private Compose service', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'production',
        APP_PUBLIC_URL: 'https://admin.company.io',
        CORS_ORIGIN: 'https://admin.company.io',
        DATABASE_URL: 'mysql://user:password@mysql.company.io/id_business',
        FIELD_ENCRYPTION_KEY: 'f'.repeat(32),
        HASH_SECRET: 'h'.repeat(32),
        JWT_SECRET: 'j'.repeat(32),
        MICROSOFT_MAIL_OAUTH_CLIENT_ID: '11111111-1111-4111-8111-111111111111',
        MICROSOFT_MAIL_OAUTH_CLIENT_SECRET: 'm'.repeat(32),
        MICROSOFT_MAIL_OAUTH_REDIRECT_URI:
          'https://admin.company.io/api/public/mailbox/microsoft-oauth/callback',
        ID_BUSINESS_V2_MEDIA_RESOLVER_URL: 'https://resolver.example.org'
      })
    ).toThrow('must use the internal media-resolver service in production');
  });
});
