import assert from 'node:assert/strict';
import test from 'node:test';
import { checkMode, selectedParts, needsOnlineRechargeCiBuild } from './ci-recharge-scope.mjs';
import {
  onlineProxyCountryPaths,
  onlineProxyCountryValidationPaths,
  isOnlineProxyCountryValidationOnly,
  onlineProxyCountrySources,
  onlineProxyCountryCommands,
  isOnlineProxyCountryOnly
} from './ci-online-proxy-country-scope.mjs';

test('Admin projection controls cannot admit application, dependency or schema changes', () => {
  const paths = [...onlineProxyCountryValidationPaths];
  assert.equal(isOnlineProxyCountryValidationOnly(paths), true);
  assert.equal(checkMode(paths, 'same', 'same'), 'ci-only');
  assert.equal(checkMode(paths, 'before', 'after'), 'full');
  assert.equal(needsOnlineRechargeCiBuild(paths), false);
  assert.equal(
    onlineProxyCountryCommands('guards', paths).some((args) => args.includes('check:admin-ui')),
    false
  );
  assert.throws(
    () => onlineProxyCountryCommands('api', paths),
    /Unsupported proxy country check part/
  );
  for (const extra of [
    onlineProxyCountrySources[0],
    'package-lock.json',
    'apps/api/prisma-mysql/schema.prisma'
  ]) {
    assert.equal(isOnlineProxyCountryValidationOnly([...paths, extra]), false);
    assert.equal(checkMode([...paths, extra], 'same', 'same'), 'full');
  }
});

test('country feature keeps API, Admin and engine checks without a historical image projection', () => {
  assert.equal(isOnlineProxyCountryOnly(onlineProxyCountryPaths), true);
  assert.equal(checkMode(onlineProxyCountryPaths, 'same schema', 'same schema'), 'recharge');
  assert.equal(checkMode(onlineProxyCountryPaths, 'old schema', 'new schema'), 'full');
  assert.deepEqual(selectedParts(onlineProxyCountryPaths), [
    'guards',
    'api',
    'admin',
    'online-engine'
  ]);
  assert.equal(needsOnlineRechargeCiBuild(onlineProxyCountryPaths), false);
  assert.ok(
    onlineProxyCountryCommands('api', onlineProxyCountryPaths).some((args) =>
      args.includes('typecheck')
    )
  );
  assert.ok(
    onlineProxyCountryCommands('admin', onlineProxyCountryPaths).some((args) =>
      args.includes('scripts/acceptance-v2-online-proxy-country.mjs')
    )
  );
  assert.ok(
    onlineProxyCountryCommands('online-engine', onlineProxyCountryPaths).some((args) =>
      args.includes('test:online-recharge:engine')
    )
  );
});
test('schema, dependencies, payment and worker changes cannot enter the finite country channel', () => {
  for (const path of [
    'apps/api/prisma-mysql/schema.prisma',
    'package-lock.json',
    'apps/api/Dockerfile.mysql',
    'apps/api/src/id-business-v2/online-recharge/engine/worker.cjs',
    'apps/api/src/id-business-v2/online-recharge/engine/upstream/stripe-payment.js'
  ]) {
    const wider = [...onlineProxyCountryPaths, path];
    assert.equal(isOnlineProxyCountryOnly(wider), false, path);
    assert.equal(checkMode(wider, 'same', 'same'), 'full', path);
    assert.equal(needsOnlineRechargeCiBuild(wider), true, path);
    assert.throws(
      () => onlineProxyCountryCommands('guards', wider),
      /Unsupported proxy country scope/
    );
  }
  assert.equal(
    isOnlineProxyCountryOnly([...onlineProxyCountryPaths, onlineProxyCountryPaths[0]]),
    false
  );
  for (const source of onlineProxyCountrySources)
    assert.equal(
      isOnlineProxyCountryOnly(onlineProxyCountryPaths.filter((path) => path !== source)),
      false
    );
});
