import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export const mailboxSettingsPaths = [
  '.github/workflows/mailbox-settings-publication.yml',
  'apps/admin/src/v2/components/workspace/V2ManagedMailboxPanel.vue',
  'apps/admin/src/v2/testing/V2MailboxQueryCodeValidityFixture.vue',
  'scripts/acceptance-v2-mailbox-query-code-validity.mjs',
  'scripts/ci-mailbox-validity-scope.mjs',
  'scripts/ci-mailbox-validity-scope.test.mjs',
  'scripts/ci-recharge-check.mjs',
  'scripts/ci-recharge-scope.mjs',
  'scripts/production-release/mailbox-settings-build.py',
  'scripts/production-release/mailbox-settings-contract.json',
  'scripts/production-release/mailbox-settings-publication.py',
  'scripts/production-release/mailbox-settings-release.test.py',
  'scripts/production-release/mailbox-settings-runtime.py'
];

export function isMailboxSettingsOnly(paths) {
  return (
    paths.length === mailboxSettingsPaths.length &&
    new Set(paths).size === paths.length &&
    mailboxSettingsPaths.every((n) => paths.includes(n))
  );
}

export function isMailboxSettingsControlsOnly(paths) {
  const controls = mailboxSettingsPaths.filter(
    (n) => !n.startsWith('apps/') && n !== 'scripts/acceptance-v2-mailbox-query-code-validity.mjs'
  );
  return (
    paths.includes('scripts/production-release/mailbox-settings-publication.py') &&
    paths.includes('scripts/production-release/mailbox-settings-release.test.py') &&
    new Set(paths).size === paths.length &&
    paths.every((n) => controls.includes(n))
  );
}

export function mailboxSettingsCommands(part, changed) {
  if (part === 'admin') return mailboxValidityCommands(part, changed);
  if (part !== 'guards') throw new Error('Mailbox settings has no API or database changes');
  return mailboxValidityCommands(part, changed).map(([file, args]) => [
    file,
    args.map((arg) =>
      arg
        .replace('mailbox-validity-publication.py', 'mailbox-settings-publication.py')
        .replace('mailbox-validity-release.test.py', 'mailbox-settings-release.test.py')
    )
  ]);
}

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

export function isMailboxValidityControlsOnly(paths) {
  const controls = mailboxValidityPaths.filter(
    (n) =>
      n.startsWith('scripts/production-release/mailbox-validity-') ||
      [
        'scripts/ci-mailbox-validity-scope.mjs',
        'scripts/ci-mailbox-validity-scope.test.mjs',
        'scripts/ci-recharge-scope.mjs',
        'scripts/ci-recharge-check.mjs',
        '.github/workflows/mailbox-validity-publication.yml'
      ].includes(n)
  );
  return (
    paths.includes('scripts/production-release/mailbox-validity-release.test.py') &&
    paths.includes('scripts/production-release/mailbox-validity-build.py') &&
    new Set(paths).size === paths.length &&
    paths.every((n) => controls.includes(n))
  );
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

// The first PR run completed API checks; only its browser fixture failed.
export const mailboxValidityApiReceipt = Object.freeze({
  repository: 'wangchaozhuanyong/id-business-system',
  pullRequest: 750,
  runId: 40522000607,
  jobId: 122251409323,
  head: '35c4f65bdcec65adf7d0bfb6b3757ed7e7d375d2',
  base: 'a7f61aeca2b6ead635f3e0d8858f760da96964de',
  checkout: 'da615a3f81e8e0703e193d26f6ed85adbf5acd61',
  tree: '06b763bffeedccaf91e494dc374268432f85b98d'
});

export function mailboxValidityApiReceiptMatches({ run, job, checkout, log, unchanged }) {
  const b = mailboxValidityApiReceipt;
  return (
    unchanged &&
    run.id === b.runId &&
    run.run_attempt === 1 &&
    run.event === 'pull_request' &&
    run.path === '.github/workflows/quality.yml' &&
    run.status === 'completed' &&
    run.conclusion === 'failure' &&
    run.head_sha === b.head &&
    run.repository?.full_name === b.repository &&
    run.pull_requests?.some((p) => p.number === b.pullRequest) &&
    job.id === b.jobId &&
    job.run_id === b.runId &&
    job.name === 'recharge (api)' &&
    job.status === 'completed' &&
    job.conclusion === 'success' &&
    ['Checkout', 'Install package dependencies', 'Check affected recharge part'].every((name) =>
      job.steps.some((s) => s.name === name && s.conclusion === 'success')
    ) &&
    job.steps.every((s) => ['success', 'skipped'].includes(s.conclusion)) &&
    checkout.sha === b.checkout &&
    checkout.tree?.sha === b.tree &&
    JSON.stringify(checkout.parents?.map((p) => p.sha)) === JSON.stringify([b.base, b.head]) &&
    log.includes('[command]/usr/bin/git log -1 --format=%H') &&
    new RegExp('git log -1 --format=%H\\r?\\n[^\\n]* ' + b.checkout + '(?:\\r?\\n|$)').test(log)
  );
}
