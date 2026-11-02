import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dependencySecurityControls,
  isDependencySecurityControlsOnly,
  dependencySecurityCommands
} from './ci-dependency-security-scope.mjs';
import { checkMode, needsOnlineRechargeCiBuild } from './ci-recharge-scope.mjs';

test('finite dependency observation selects controls without application or database suites', () => {
  assert.equal(isDependencySecurityControlsOnly(dependencySecurityControls), true);
  assert.equal(checkMode(dependencySecurityControls, 'same', 'same'), 'ci-only');
  assert.equal(checkMode(dependencySecurityControls, 'old', 'new'), 'full');
  assert.equal(needsOnlineRechargeCiBuild(dependencySecurityControls), false);
  assert.equal(isDependencySecurityControlsOnly([]), false);
  assert.equal(isDependencySecurityControlsOnly(['scripts/ci-recharge-check.mjs']), false);
  for (const path of [
    'package.json',
    'package-lock.json',
    'apps/api/src/main.ts',
    'apps/api/prisma-mysql/schema.prisma',
    'scripts/production-release/online-session-observer-release.py'
  ])
    assert.equal(isDependencySecurityControlsOnly([...dependencySecurityControls, path]), false);
  assert.equal(
    checkMode([...dependencySecurityControls, 'package-lock.json'], 'same', 'same'),
    'full'
  );
});

test('dependency observation commands retain contract checks and reject non-guard parts', () => {
  const commands = dependencySecurityCommands('guards');
  assert.ok(
    commands.some(([, args]) =>
      args.includes('scripts/production-release/dependency-security-publication.test.py')
    )
  );
  assert.ok(
    commands.some(
      ([, args]) =>
        args.includes('scripts/production-release/dependency-security-publication.py') &&
        args.includes('check')
    )
  );
  for (const name of ['runtime.test.py', 'deploy.py'])
    assert.ok(
      commands.some(([, args]) =>
        args.includes('scripts/production-release/dependency-security-' + name)
      )
    );
  assert.ok(
    commands.every(([, args]) =>
      args.every((arg) => !/prisma|acceptance:v2|migrate|--workspace/.test(arg))
    )
  );
  assert.throws(() => dependencySecurityCommands('api'), /guards only/);
});
