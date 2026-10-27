import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export const mailboxValidityPaths = [
  '.github/workflows/mailbox-validity-publication.yml',
  '.github/workflows/recharge-billing-allocation-validation.yml',
  'apps/admin/mailbox-query-code-validity-fixture.html',
  'apps/admin/src/v2/api/workspace.ts',
  'apps/admin/src/v2/components/workspace/V2MailboxQueryCodeResetDialog.vue',
  'apps/admin/src/v2/components/workspace/V2ManagedMailboxPanel.vue',
  'apps/admin/src/v2/components/workspace/mailboxQueryCodeValidity.spec.ts',
  'apps/admin/src/v2/components/workspace/mailboxQueryCodeValidity.ts',
  'apps/admin/src/v2/components/workspace/managedMailboxExpiry.ts',
  'apps/admin/src/v2/features/auto-recharge/VendureMailboxManager.vue',
  'apps/admin/src/v2/features/auto-recharge/vendure-mailbox-api.ts',
  'apps/admin/src/v2/features/tableSchemas.ts',
  'apps/admin/src/v2/testing/V2MailboxQueryCodeValidityFixture.vue',
  'apps/admin/src/v2/testing/mailbox-query-code-validity-fixture.ts',
  'apps/api/prisma-mysql/migrations/20261027010000_managed_mailbox_query_code_validity/migration.sql',
  'apps/api/prisma-mysql/schema.prisma',
  'apps/api/src/id-business-v2/workspace/dto/id-business-v2-managed-mailbox.dto.ts',
  'apps/api/src/id-business-v2/workspace/dto/id-business-v2-vendure-mailbox.dto.ts',
  'apps/api/src/id-business-v2/workspace/id-business-v2-managed-mailbox-schema.contract.spec.ts',
  'apps/api/src/id-business-v2/workspace/id-business-v2-managed-mailbox-settings.service.spec.ts',
  'apps/api/src/id-business-v2/workspace/id-business-v2-managed-mailbox-settings.service.ts',
  'apps/api/src/id-business-v2/workspace/id-business-v2-managed-mailbox.controller.ts',
  'apps/api/src/id-business-v2/workspace/id-business-v2-managed-mailbox.service.spec.ts',
  'apps/api/src/id-business-v2/workspace/id-business-v2-managed-mailbox.service.ts',
  'apps/api/src/id-business-v2/workspace/id-business-v2-microsoft-mailbox-authorization.service.ts',
  'apps/api/src/id-business-v2/workspace/id-business-v2-vendure-mailbox.controller.ts',
  'apps/api/src/id-business-v2/workspace/id-business-v2-vendure-mailbox.service.spec.ts',
  'apps/api/src/id-business-v2/workspace/id-business-v2-vendure-mailbox.service.ts',
  'apps/api/src/id-business-v2/workspace/managed-mailbox-validity.mysql.integration.spec.ts',
  'apps/api/src/id-business-v2/workspace/persistence/id-business-v2-managed-mailbox.repository.ts',
  'apps/api/src/id-business-v2/workspace/providers/id-business-v2-vendure-mailbox.client.spec.ts',
  'apps/api/src/id-business-v2/workspace/providers/id-business-v2-vendure-mailbox.client.ts',
  'docs/MAILBOX_QUERY_CODE_VALIDITY_20261027.md',
  'docs/V2_TASKS.md',
  'packages/shared/src/v2/workspace.ts',
  'scripts/acceptance-v2-mailbox-query-code-validity.mjs',
  'scripts/ci-mailbox-validity-scope.mjs',
  'scripts/ci-mailbox-validity-scope.test.mjs',
  'scripts/ci-recharge-check.mjs',
  'scripts/ci-recharge-scope.mjs',
  'scripts/production-release/mailbox-validity-build.py',
  'scripts/production-release/mailbox-validity-contract.json',
  'scripts/production-release/mailbox-validity-publication.py',
  'scripts/production-release/mailbox-validity-release.test.py',
  'scripts/production-release/mailbox-validity-runtime.py'
];

export function isMailboxValidityOnly(paths, oldSchema, newSchema) {
  if (
    paths.length !== mailboxValidityPaths.length ||
    new Set(paths).size !== paths.length ||
    !mailboxValidityPaths.every((n) => paths.includes(n))
  )
    return false;
  if (oldSchema === undefined || newSchema === undefined) return true;
  const field =
    '  queryCodeValidityDays       Int                              @default(30) @map("query_code_validity_days")\n';
  return newSchema.split(field).length === 2 && newSchema.replace(field, '') === oldSchema;
}

export function mailboxValidityContext(base) {
  const schema = 'apps/api/prisma-mysql/schema.prisma';
  return [
    execFileSync('git', ['show', base + ':' + schema], { encoding: 'utf8' }),
    readFileSync(schema, 'utf8')
  ];
}

export function mailboxValidityCommands(part, changed) {
  const npm = (...args) => ['npm', args];
  if (part === 'guards')
    return [
      npm(
        'exec',
        '--',
        'prettier',
        '--check',
        ...changed.filter((n) => /\.(?:ts|vue|mjs|json|yml|md)$/.test(n))
      ),
      npm('exec', '--', 'eslint', ...changed.filter((n) => /\.(?:ts|vue|mjs)$/.test(n))),
      ...[
        'check:admin-ui',
        'check:v2-ui-language',
        'check:v2-color-contrast',
        'check:v2-table-standard',
        'check:v2-loading-standard',
        'check:v2-module-architecture',
        'check:v2-isolation',
        'check:v2-timezone-standard',
        'check:v2-concurrency-standard',
        'check:v2-prisma-runtime-boundary'
      ].map((n) => npm('run', n)),
      [
        'node',
        [
          '--test',
          'scripts/ci-mailbox-validity-scope.test.mjs',
          'scripts/ci-recharge-scope.test.mjs',
          'scripts/ci-change-scope.test.mjs'
        ]
      ],
      [
        'node',
        [
          '--test',
          '--test-name-pattern=mailbox|mail-query|bank-card',
          'scripts/ci-recharge-check.test.mjs'
        ]
      ],
      ['python3', ['-B', 'scripts/production-release/mailbox-validity-publication.py', 'check']],
      ['python3', ['-B', 'scripts/production-release/mailbox-validity-release.test.py']]
    ];
  if (part === 'api')
    return [
      npm('run', 'prisma:mysql:generate'),
      npm('run', 'prisma:validate'),
      npm('run', 'build', '--workspace', '@apple-business/shared'),
      npm('run', 'typecheck', '--workspace', '@apple-business/api'),
      npm(
        'run',
        'test',
        '--workspace',
        '@apple-business/api',
        '--',
        'src/id-business-v2/workspace/id-business-v2-managed-mailbox-schema.contract.spec.ts',
        'src/id-business-v2/workspace/id-business-v2-managed-mailbox-settings.service.spec.ts',
        'src/id-business-v2/workspace/id-business-v2-managed-mailbox.service.spec.ts',
        'src/id-business-v2/workspace/id-business-v2-microsoft-mailbox-authorization.service.spec.ts',
        'src/id-business-v2/workspace/id-business-v2-vendure-mailbox.service.spec.ts',
        'src/id-business-v2/workspace/providers/id-business-v2-vendure-mailbox.client.spec.ts'
      ),
      npm('run', 'build', '--workspace', '@apple-business/api')
    ];
  if (part === 'admin')
    return [
      npm('run', 'build', '--workspace', '@apple-business/shared'),
      npm(
        'run',
        'test',
        '--workspace',
        '@apple-business/admin',
        '--',
        'src/v2/components/workspace/mailboxQueryCodeValidity.spec.ts',
        'src/v2/components/workspace/managedMailboxExpiry.spec.ts',
        'src/v2/components/workspace/managedMailboxProviderFlow.spec.ts',
        'src/v2/features/auto-recharge/vendure-mailbox-ui.contract.spec.ts'
      ),
      npm('run', 'build', '--workspace', '@apple-business/admin'),
      npm('exec', '--', 'playwright', 'install', 'chromium'),
      ['node', ['scripts/acceptance-v2-mailbox-query-code-validity.mjs']]
    ];
  throw new Error('Unsupported mailbox validity quality part');
}
