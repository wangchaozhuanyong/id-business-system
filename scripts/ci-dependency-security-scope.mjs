const prefix = 'scripts/production-release/dependency-security-';
export const dependencySecurityControls = Object.freeze([
  '.github/workflows/dependency-security-publication.yml',
  ...[
    'contract.json',
    'publication.py',
    'publication.test.py',
    'build.py',
    'runtime.py',
    'runtime.test.py',
    'deploy.py'
  ].map((name) => prefix + name),
  'scripts/ci-dependency-security-scope.mjs',
  'scripts/ci-dependency-security-scope.test.mjs',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-check.mjs',
  'scripts/ci-recharge-check.test.mjs'
]);

export function isDependencySecurityControlsOnly(paths) {
  return (
    paths.length > 0 &&
    new Set(paths).size === paths.length &&
    paths.some((name) => name.startsWith(prefix)) &&
    paths.every((name) => dependencySecurityControls.includes(name))
  );
}

export function dependencySecurityCommands(part) {
  if (part !== 'guards') throw new Error('Dependency security observation requires guards only');
  return [
    ['node', ['--test', 'scripts/ci-dependency-security-scope.test.mjs']],
    ['python3', ['-B', prefix + 'publication.test.py']],
    ['python3', ['-B', prefix + 'runtime.test.py']],
    ['python3', ['-B', prefix + 'deploy.py', 'check']],
    ['python3', ['-B', prefix + 'publication.py', 'check']],
    [
      'npm',
      [
        'exec',
        '--',
        'prettier',
        '--check',
        '.github/workflows/dependency-security-publication.yml',
        prefix + 'contract.json',
        'scripts/ci-dependency-security-scope.mjs',
        'scripts/ci-dependency-security-scope.test.mjs',
        'scripts/ci-recharge-scope.mjs',
        'scripts/ci-recharge-check.mjs',
        'scripts/ci-recharge-check.test.mjs'
      ]
    ],
    [
      'npm',
      [
        'exec',
        '--',
        'eslint',
        'scripts/ci-dependency-security-scope.mjs',
        'scripts/ci-dependency-security-scope.test.mjs',
        'scripts/ci-recharge-scope.mjs',
        'scripts/ci-recharge-check.mjs',
        'scripts/ci-recharge-check.test.mjs'
      ]
    ],
    [
      'node',
      [
        '--test',
        '--test-name-pattern=依赖发布控制|回填源码真实入口',
        'scripts/ci-recharge-check.test.mjs'
      ]
    ]
  ];
}
