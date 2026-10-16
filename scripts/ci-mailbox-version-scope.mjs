export const mailboxVersionPaths = [
  'apps/api/src/common/prisma/bump-v2-scope-versions.ts',
  'apps/api/src/id-business-v2/workspace/mail-events-version.spec.ts',
  'apps/api/src/id-business-v2/workspace/mail-events-version.mysql.integration.spec.ts',
  'apps/api/src/id-business-v2/runtime/id-business-v2-command-transaction.service.spec.ts',
  'apps/api/src/id-business-v2/finance/id-business-v2-finance-transactional-fx.spec.ts',
  '.github/workflows/mailbox-version-validation.yml',
  'scripts/ci-mailbox-version-scope.mjs',
  'scripts/ci-mailbox-version-scope.test.mjs',
  'scripts/ci-gpt-recharge-scope.test.mjs',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-check.mjs',
  'scripts/production-release/mailbox-version-build.py',
  'scripts/production-release/mailbox-version-release.py',
  'scripts/production-release/mailbox-version-release.test.py',
  'scripts/production-release/mailbox-version-dispatch.py',
  'scripts/production-release/mailbox-version-contract.json',
  'docs/MAILBOX_REALTIME_REPAIR_20261016.md'
];
export function isMailboxVersionOnly(paths) {
  return (
    mailboxVersionPaths.slice(0, 3).every((name) => paths.includes(name)) &&
    paths.length === new Set(paths).size &&
    paths.every((name) => mailboxVersionPaths.includes(name))
  );
}
export function mailboxVersionCommands(part, paths) {
  if (!isMailboxVersionOnly(paths)) throw new Error('Unsupported mailbox version scope');
  if (part === 'guards')
    return [
      [
        'node',
        '--test',
        'scripts/ci-mailbox-version-scope.test.mjs',
        'scripts/ci-gpt-recharge-scope.test.mjs',
        'scripts/ci-recharge-scope.test.mjs',
        'scripts/ci-recharge-check.test.mjs'
      ],
      [
        'npx',
        'prettier',
        '--check',
        ...paths.filter((name) => /\.(?:mjs|json|yml|md|ts)$/.test(name))
      ],
      ['npx', 'eslint', ...paths.filter((name) => /\.(?:mjs|ts)$/.test(name))],
      ...[
        'v2-module-architecture',
        'v2-isolation',
        'v2-concurrency-standard',
        'v2-prisma-runtime-boundary'
      ].map((name) => ['npm', 'run', 'check:' + name])
    ];
  if (part === 'release-controls')
    return [['python3', '-B', 'scripts/production-release/mailbox-version-release.test.py']];
  if (part === 'api')
    return [
      ['npm', 'run', 'prisma:mysql:generate'],
      ['npm', 'run', 'build', '--workspace', '@apple-business/shared'],
      ['npm', 'run', 'typecheck', '--workspace', '@apple-business/api'],
      [
        'npm',
        'run',
        'test',
        '--workspace',
        '@apple-business/api',
        '--',
        '--exclude',
        '**/*.mysql.integration.spec.ts'
      ],
      ['npm', 'run', 'build', '--workspace', '@apple-business/api']
    ];
  throw new Error('Unsupported mailbox version check part');
}
