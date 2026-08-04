const DATABASE_KEYS = [
  'DATABASE_URL',
  'DIRECT_URL',
  'MIGRATION_DATABASE_URL',
  'AUDIT_DATABASE_URL',
  'V2_RUNTIME_DATABASE_URL'
];

export const PRODUCTION_COMMANDS = Object.freeze({
  'closure-audit': {
    command: 'node',
    args: ['scripts/production-closure-audit.mjs'],
    requiredSecrets: ['AUDIT_DATABASE_URL'],
    databaseSecret: 'AUDIT_DATABASE_URL',
    forwardedSecrets: []
  },
  'release-check': {
    command: 'node',
    args: ['scripts/validate-cloudflare-free-release.mjs'],
    requiredSecrets: [
      'V2_RUNTIME_DATABASE_URL',
      'JWT_SECRET',
      'FIELD_ENCRYPTION_KEY',
      'HASH_SECRET',
      'SMOKE_TEST_USERNAME',
      'SMOKE_TEST_PASSWORD'
    ],
    databaseSecret: 'V2_RUNTIME_DATABASE_URL',
    forwardedSecrets: [
      'V2_RUNTIME_DATABASE_URL',
      'JWT_SECRET',
      'FIELD_ENCRYPTION_KEY',
      'HASH_SECRET',
      'SMOKE_TEST_USERNAME',
      'SMOKE_TEST_PASSWORD'
    ]
  },
  'smoke-user-provision': {
    command: 'npm',
    args: ['run', 'prod:smoke-user:provision:with-env'],
    requiredSecrets: [
      'V2_RUNTIME_DATABASE_URL',
      'FIELD_ENCRYPTION_KEY',
      'HASH_SECRET',
      'SMOKE_TEST_USERNAME',
      'SMOKE_TEST_PASSWORD'
    ],
    databaseSecret: 'V2_RUNTIME_DATABASE_URL',
    forwardedSecrets: [
      'FIELD_ENCRYPTION_KEY',
      'HASH_SECRET',
      'SMOKE_TEST_USERNAME',
      'SMOKE_TEST_PASSWORD'
    ]
  },
  deploy: {
    command: 'npm',
    args: ['run', 'deploy:production:with-env'],
    requiredSecrets: [
      'V2_RUNTIME_DATABASE_URL',
      'JWT_SECRET',
      'FIELD_ENCRYPTION_KEY',
      'HASH_SECRET',
      'SMOKE_TEST_USERNAME',
      'SMOKE_TEST_PASSWORD'
    ],
    databaseSecret: 'V2_RUNTIME_DATABASE_URL',
    forwardedSecrets: [
      'V2_RUNTIME_DATABASE_URL',
      'JWT_SECRET',
      'FIELD_ENCRYPTION_KEY',
      'HASH_SECRET',
      'SMOKE_TEST_USERNAME',
      'SMOKE_TEST_PASSWORD'
    ]
  }
});

export function resolveProductionCommand(operation) {
  const profile = PRODUCTION_COMMANDS[operation];
  if (!profile) {
    throw new Error(
      `未知生产操作：${operation || '(empty)'}；仅允许 ${Object.keys(PRODUCTION_COMMANDS).join(', ')}`
    );
  }
  return profile;
}

export function buildProductionCommandEnvironment(baseEnvironment, secrets, profile) {
  for (const key of profile.requiredSecrets) {
    if (typeof secrets[key] !== 'string' || !secrets[key]) {
      throw new Error(`部署凭据缺少 ${key}`);
    }
  }

  const environment = { ...baseEnvironment };
  for (const key of DATABASE_KEYS) delete environment[key];
  environment.DATABASE_URL = secrets[profile.databaseSecret];
  for (const key of profile.forwardedSecrets) environment[key] = secrets[key];
  return environment;
}
