import { readFileSync } from 'node:fs';
const contract = JSON.parse(
  readFileSync(new URL('./production-release/workspace-drag-contract.json', import.meta.url))
);
const application = [
  ...Object.keys(contract.sources),
  'apps/admin/src/v2/components/workspace/useV2QuickActionSorting.spec.ts',
  'apps/admin/src/v2/testing/workspace-design-fixture.ts',
  'scripts/acceptance-v2-workspace-dock.mjs',
  'scripts/acceptance-v2-workspace-drag-static.mjs'
];
const controls = [
  ...['contract.json', 'build.py', 'release.py', 'release.test.py', 'dispatch.py'].map(
    (n) => 'scripts/production-release/workspace-drag-' + n
  ),
  '.github/workflows/workspace-drag-validation.yml',
  'scripts/ci-workspace-drag-scope.mjs',
  'scripts/ci-workspace-drag-scope.test.mjs',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-check.mjs',
  'docs/WORKSPACE_COPY_DRAG_20261016.md',
  'docs/V2_TASKS.md'
];
export function isWorkspaceDragOnly(paths) {
  return (
    paths.length > 0 &&
    new Set(paths).size === paths.length &&
    paths.some((n) => n.startsWith('scripts/production-release/workspace-drag-')) &&
    paths.every((n) => application.includes(n) || controls.includes(n))
  );
}
export function workspaceDragParts(paths) {
  if (!isWorkspaceDragOnly(paths)) throw new Error('Unsupported card drag scope');
  return paths.some((n) => application.includes(n)) ? ['guards', 'admin'] : ['guards'];
}
export function workspaceDragCommands(part, paths) {
  if (!workspaceDragParts(paths).includes(part)) throw new Error('Unsupported card drag part');
  const npm = (...args) => ['npm', ...args];
  if (part === 'guards')
    return [
      npm(
        'exec',
        '--',
        'prettier',
        '--check',
        ...paths.filter((n) => /\.(mjs|json|md|yml|ts|vue|css)$/.test(n))
      ),
      npm('exec', '--', 'eslint', ...paths.filter((n) => /\.(mjs|ts|vue)$/.test(n))),
      ['python3', '-B', 'scripts/production-release/workspace-drag-release.test.py'],
      ['node', '--test', 'scripts/ci-workspace-drag-scope.test.mjs'],
      ...(paths.some((n) => application.includes(n))
        ? [
            'check:admin-ui',
            'check:v2-ui-language',
            'check:v2-color-contrast',
            'check:v2-table-standard',
            'check:v2-loading-standard',
            'check:v2-module-architecture',
            'check:v2-isolation'
          ].map((n) => npm('run', n))
        : [])
    ];
  return [
    npm('run', 'build', '--workspace', '@apple-business/shared'),
    npm(
      'run',
      'test',
      '--workspace',
      '@apple-business/admin',
      '--',
      ...[
        'quickActionOrder',
        'useV2QuickActionSorting',
        'useV2QuickActions',
        'workspace-ui.contract'
      ].map((n) => 'src/v2/components/workspace/' + n + '.spec.ts')
    ),
    npm('run', 'build', '--workspace', '@apple-business/admin')
  ];
}
