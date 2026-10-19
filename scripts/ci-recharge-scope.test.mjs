import {
  registrationProtocolRestoreRepairBase,
  registrationProtocolRestoreRepairTree,
  registrationProtocolRestoreRepairPaths,
  registrationProtocolRestoreRepairGuard,
  registrationProtocolRestoreBase,
  registrationProtocolRestoreTree,
  registrationProtocolRestorePaths,
  registrationProtocolRestoreRemovedSources
} from './ci-registration-protocol-restore-scope.mjs';
import {
  proxyResultIdentityPaths,
  proxyResultIdentityBase,
  proxyResultIdentityTree,
  proxyResultIdentityPins
} from './ci-proxy-result-identity-scope.mjs';
import {
  isRegistrationClosureOnly,
  isRegistrationClosureControlsOnly,
  registrationFactsSchemaProof,
  registrationFactsMigration,
  registrationPublishedBindingPath,
  registrationPublishedRecoveryProof,
  hasRegistrationPublishedRecovery
} from './ci-registration-closure-scope.mjs';
import {
  isRegistrationEnvironmentRepair,
  registrationEnvironmentRepairBase,
  isRegistrationDeclarationRepair,
  registrationDeclarationRepairBase,
  isRegistrationMigrationQueryRepair,
  registrationMigrationQueryRepairBase
} from './ci-registration-closure-scope.mjs';
import { imageInputsChanged } from './ci-recharge-python-image.mjs';
import {
  onlineCardControlDiagnosticsPaths,
  onlineCardControlDiagnosticsControls,
  onlineCheckoutActionabilityPaths,
  onlineCheckoutInitializationPaths,
  onlineCheckoutInitializationControls,
  onlineCheckoutActionabilityControls,
  onlineQueryDeadlinePaths,
  onlineQueryDeadlineControls,
  onlineQueryNetworkPaths,
  onlineQueryNetworkControls,
  onlineSessionPreflightPaths,
  onlineSessionPreflightControls
} from './ci-online-settings-scope.mjs';
import {
  adminHtmlCachePaths,
  isRegistrationTerminalStopOnly,
  registrationTerminalStopBase,
  registrationTerminalStopTree,
  registrationTerminalStopRepairBase,
  registrationTerminalStopRepairTree,
  registrationTerminalStopRepairPaths,
  registrationTerminalStopRepairParts,
  registrationTerminalStopContract,
  registrationTerminalStopApplications,
  registrationTerminalStopPaths,
  registrationTerminalStopParts,
  registrationTerminalStopCommands,
  isRegistrationFlowV4Only,
  registrationFlowV4Base,
  registrationFlowV4Tree,
  registrationFlowV4Contract,
  registrationFlowV4Applications,
  registrationFlowV4Acceptance,
  registrationFlowV4Paths,
  registrationFlowV4Parts,
  registrationFlowV4Commands,
  registrationFlowV4SupportSources,
  isAdminHtmlCacheOnly,
  isRegistrationProtocolRepairOnly,
  registrationProtocolRepairBase,
  registrationProtocolRepairTree,
  registrationProtocolRepairContract,
  registrationProtocolRepairApplications,
  registrationProtocolRepairAcceptance,
  registrationProtocolRepairPaths,
  registrationProtocolRepairParts,
  registrationProtocolRepairCommands,
  isRegistrationProtocolRepairControlRepair,
  registrationProtocolRepairControlBase,
  registrationProtocolRepairControlTree,
  registrationProtocolRepairControlPaths,
  registrationProtocolRepairControlCommands,
  isRegistrationProtocolRepairPreservationOnly,
  registrationProtocolRepairPreservationAdmission,
  registrationProtocolRepairPreservationProjection,
  registrationProtocolRepairPreservationBase,
  registrationProtocolRepairPreservationTree,
  registrationProtocolRepairPreservationPaths
} from './ci-recharge-scope.mjs';
import assert from 'node:assert/strict';

test('比特多连接并发验收变动必须运行既有隔离 MySQL 检查', async () => {
  const { hasRechargeConnectionMigrationScope, selectedParts } =
    await import('./ci-recharge-scope.mjs');
  const paths = [
    'apps/api/src/id-business-v2/auto-recharge/recharge-employee-concurrency.mysql.integration.spec.ts'
  ];
  assert.equal(hasRechargeConnectionMigrationScope(paths), true);
  assert.equal(selectedParts(paths).includes('migration'), true);
  assert.equal(hasRechargeConnectionMigrationScope(['docs/V2_TASKS.md']), false);
});
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs, { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import {
  registrationParityDiagnosticsBase,
  registrationParityDiagnosticsRepairBase,
  registrationParityDiagnosticsRepairTree,
  registrationParityDiagnosticsRepairPaths,
  registrationParityDiagnosticsTree,
  registrationParityDiagnosticsCurrent,
  registrationParityDiagnosticsApplications,
  registrationParityDiagnosticsAcceptance,
  registrationParityDiagnosticsContract,
  registrationParityDiagnosticsControls,
  registrationParityDiagnosticsPaths,
  registrationParityDiagnosticsParts
} from './ci-registration-parity-diagnostics-scope.mjs';
import {
  registrationBrowserBase,
  registrationBrowserTree,
  registrationBrowserCurrent,
  registrationBrowserPaths,
  registrationBrowserReviewedPaths,
  registrationBrowserApplications,
  registrationBrowserControls,
  registrationBrowserContract,
  registrationBrowserAcceptance,
  registrationBrowserParts
} from './ci-registration-browser-scope.mjs';

function terminalStopFixture() {
  const hashes = Object.fromEntries(
    registrationTerminalStopPaths
      .filter((name) => name !== registrationTerminalStopContract)
      .map((name) => [name, 'a'.repeat(64)])
  );
  return {
    base: registrationTerminalStopBase,
    baseTree: registrationTerminalStopTree,
    sourceDigest: (name) => hashes[name] ?? null,
    contract: {
      version: 1,
      scope: 'REGISTRATION_TERMINAL_STOP_20261017',
      name: 'registration-terminal-stop-20261017',
      frozen: true,
      admission: 'VERIFIED',
      migration: null,
      businessActions: 0,
      pendingEvidence: [],
      sourceBaseline: registrationTerminalStopBase,
      sourceBaselineTree: registrationTerminalStopTree,
      expectedGitChanges: [...registrationTerminalStopPaths],
      applicationPaths: [...registrationTerminalStopApplications],
      sources: Object.fromEntries(
        registrationTerminalStopApplications.map((name) => [name, hashes[name]])
      ),
      workerFiles: { 'apple_mailboxes.py': hashes[registrationTerminalStopApplications[0]] },
      validationSources: {},
      apiRuntimeDelta: [],
      apiJavascriptDelta: [],
      adminDelta: [],
      reviewedFileHashes: hashes
    }
  };
}

test('registration terminal stop admits only the exact reviewed Worker successor', () => {
  const context = terminalStopFixture(),
    paths = [...registrationTerminalStopPaths];
  assert.equal(paths.length, 14);
  assert.equal(isRegistrationTerminalStopOnly(paths, context), true);
  assert.equal(checkMode(paths, 'same', 'same', undefined, context), 'recharge');
  assert.equal(checkMode(paths, 'old', 'new', undefined, context), 'full');
  assert.deepEqual(selectedParts(paths, undefined, context), [...registrationTerminalStopParts]);
  assert.equal(needsOnlineRechargeCiBuild(paths, context), false);
  for (const changed of [
    paths.slice(1),
    [...paths, paths[0]],
    [...paths, 'package-lock.json'],
    [...paths, 'apps/api/prisma-mysql/schema.prisma'],
    [...paths, 'apps/admin/src/v2/features/auto-registration/contracts.ts'],
    [...paths, 'apps/api/src/id-business-v2/auto-registration/upstream/src/core/register.py']
  ]) {
    assert.equal(isRegistrationTerminalStopOnly(changed, context), false);
    assert.equal(checkMode(changed, 'same', 'same', undefined, context), 'full');
  }
  for (const override of [
    { base: '0'.repeat(40) },
    { baseTree: '0'.repeat(40) },
    { sourceDigest: null },
    { sourceDigest: () => 'b'.repeat(64) },
    {
      sourceDigest: () => {
        throw new Error('SYNTHETIC_READ_FAILURE');
      }
    }
  ]) {
    assert.equal(isRegistrationTerminalStopOnly(paths, { ...context, ...override }), false);
  }
  for (const name of paths.filter((name) => name !== registrationTerminalStopContract)) {
    assert.equal(
      isRegistrationTerminalStopOnly(paths, {
        ...context,
        sourceDigest: (candidate) =>
          candidate === name ? 'b'.repeat(64) : context.sourceDigest(candidate)
      }),
      false
    );
  }
});

test('registration terminal stop rejects draft, altered scope and extra runtime payload', () => {
  for (const override of [
    { version: 2 },
    { frozen: false },
    { admission: 'DRAFT' },
    { migration: 'migration.sql' },
    { businessActions: 1 },
    { pendingEvidence: ['missing'] },
    { scope: 'OTHER' },
    { name: 'other' },
    { sourceBaseline: '0'.repeat(40) },
    { apiRuntimeDelta: ['module.js'] },
    { apiJavascriptDelta: ['module.js'] },
    { adminDelta: ['index.html'] },
    { validationSources: { 'other.mjs': 'a'.repeat(64) } },
    { workerFiles: { 'workspace.py': 'a'.repeat(64) } },
    { reviewedFileHashes: {} },
    { sources: {} },
    { expectedGitChanges: [] }
  ]) {
    const context = terminalStopFixture();
    Object.assign(context.contract, override);
    assert.equal(isRegistrationTerminalStopOnly(registrationTerminalStopPaths, context), false);
    assert.equal(
      checkMode(registrationTerminalStopPaths, 'same', 'same', undefined, context),
      'full'
    );
  }
  assert.deepEqual(registrationTerminalStopCommands.api, [
    [
      'python3',
      '-B',
      'scripts/production-release/registration-terminal-stop-build.py',
      'check-worker'
    ]
  ]);
  assert.equal(
    registrationTerminalStopCommands.guards.some((command) =>
      command.join(' ').includes('check:admin-ui')
    ),
    false
  );
});

function flowV4Fixture() {
  const hashes = Object.fromEntries(
    registrationFlowV4Paths
      .filter((name) => name !== registrationFlowV4Contract)
      .map((name) => [name, 'a'.repeat(64)])
  );
  return {
    base: registrationFlowV4Base,
    baseTree: registrationFlowV4Tree,
    sourceDigest: (name) => hashes[name] ?? registrationFlowV4SupportSources[name] ?? null,
    contract: {
      version: 1,
      scope: 'REGISTRATION_FLOW_V4_20261017',
      name: 'registration-flow-v4-20261017',
      frozen: true,
      admission: 'VERIFIED',
      migration: null,
      businessActions: 0,
      pendingEvidence: [],
      sourceBaseline: registrationFlowV4Base,
      sourceBaselineTree: registrationFlowV4Tree,
      expectedGitChanges: [...registrationFlowV4Paths],
      applicationPaths: [...registrationFlowV4Applications],
      sources: Object.fromEntries(
        registrationFlowV4Applications.map((name) => [name, hashes[name]])
      ),
      validationSources: {
        [registrationFlowV4Acceptance]: hashes[registrationFlowV4Acceptance]
      },
      validationSupportSources: { ...registrationFlowV4SupportSources },
      reviewedFileHashes: hashes
    }
  };
}

function protocolRepairFixture() {
  const hashes = Object.fromEntries(
    registrationProtocolRepairPaths
      .filter((name) => name !== registrationProtocolRepairContract)
      .map((name) => [name, 'a'.repeat(64)])
  );
  return {
    base: registrationProtocolRepairBase,
    baseTree: registrationProtocolRepairTree,
    sourceDigest: (name) => hashes[name] ?? null,
    contract: {
      version: 1,
      scope: 'REGISTRATION_PROTOCOL_REPAIR_20261017',
      name: 'registration-protocol-repair-20261017',
      frozen: true,
      admission: 'VERIFIED',
      migration: null,
      businessActions: 0,
      sourceBaseline: registrationProtocolRepairBase,
      sourceBaselineTree: registrationProtocolRepairTree,
      expectedGitChanges: [...registrationProtocolRepairPaths],
      applicationPaths: [...registrationProtocolRepairApplications],
      sources: Object.fromEntries(
        registrationProtocolRepairApplications.map((name) => [name, hashes[name]])
      ),
      validationSources: {
        [registrationProtocolRepairAcceptance]: hashes[registrationProtocolRepairAcceptance]
      },
      reviewedFileHashes: hashes
    }
  };
}

function protocolPreflightControlFixture() {
  const original = protocolRepairFixture();
  original.contract.controlHashes = {
    'registration-protocol-repair-release.py': 'a'.repeat(64),
    'registration-protocol-repair-release.test.py': 'a'.repeat(64),
    'unchanged-helper.py': 'a'.repeat(64)
  };
  original.contract.validationSupportSources = {
    'scripts/check-v2-module-architecture.mjs': 'a'.repeat(64)
  };
  original.contract.buildSupportHashes = {
    'scripts/production-release/registration-closure-release.py': 'a'.repeat(64)
  };
  const prior = structuredClone(original.contract),
    contract = structuredClone(prior);
  contract.sourceBaseline = registrationProtocolRepairControlBase;
  contract.sourceBaselineTree = registrationProtocolRepairControlTree;
  contract.expectedGitChanges = [...registrationProtocolRepairControlPaths];
  contract.reviewedFileHashes = Object.fromEntries(
    registrationProtocolRepairControlPaths
      .filter((name) => name !== registrationProtocolRepairContract)
      .map((name) => [name, 'b'.repeat(64)])
  );
  for (const name of [
    'registration-protocol-repair-release.py',
    'registration-protocol-repair-release.test.py'
  ])
    contract.controlHashes[name] =
      contract.reviewedFileHashes['scripts/production-release/' + name];
  const actualHashes = {
    ...prior.reviewedFileHashes,
    ...prior.validationSupportSources,
    ...prior.buildSupportHashes,
    ...Object.fromEntries(
      Object.entries(contract.controlHashes).map(([name, hash]) => [
        'scripts/production-release/' + name,
        hash
      ])
    ),
    ...contract.reviewedFileHashes
  };
  const validatedHashes = { ...prior.reviewedFileHashes };
  return {
    base: registrationProtocolRepairControlBase,
    baseTree: registrationProtocolRepairControlTree,
    contract,
    repairBaseContract: prior,
    repairSourcePaths: [...registrationProtocolRepairControlPaths],
    sourceDigest: (name) => actualHashes[name] ?? null,
    validatedSourceDigest: (name) => validatedHashes[name] ?? null
  };
}

function protocolPreservationFixture() {
  const earlier = protocolPreflightControlFixture();
  const prior = structuredClone(earlier.contract);
  prior.controlHashes['registration-protocol-repair-build.py'] = 'a'.repeat(64);
  const contract = structuredClone(prior);
  contract.sourceBaseline = registrationProtocolRepairPreservationBase;
  contract.sourceBaselineTree = registrationProtocolRepairPreservationTree;
  contract.expectedCurrent = registrationProtocolRepairControlBase;
  contract.expectedGitChanges = [...registrationProtocolRepairPreservationPaths];
  contract.baseline = {
    published: registrationProtocolRepairControlBase,
    api: 'fixture-published-api'
  };
  contract.reconstruction = { publishedSources: 'fixture-published-49-source-map' };
  contract.reviewedFileHashes = Object.fromEntries(
    registrationProtocolRepairPreservationPaths
      .filter((name) => name !== registrationProtocolRepairContract)
      .map((name) => [name, 'c'.repeat(64)])
  );
  for (const name of ['build.py', 'release.py', 'release.test.py'])
    contract.controlHashes['registration-protocol-repair-' + name] = 'c'.repeat(64);
  const actual = {
    ...prior.sources,
    ...prior.validationSources,
    ...prior.validationSupportSources,
    ...prior.buildSupportHashes,
    ...Object.fromEntries(
      Object.entries(contract.controlHashes).map(([name, hash]) => [
        'scripts/production-release/' + name,
        hash
      ])
    ),
    ...contract.reviewedFileHashes
  };
  return {
    base: registrationProtocolRepairPreservationBase,
    baseTree: registrationProtocolRepairPreservationTree,
    contract,
    repairBaseContract: prior,
    repairSourcePaths: [...registrationProtocolRepairPreservationPaths],
    sourceDigest: (name) => actual[name] ?? null,
    approvedProjection: registrationProtocolRepairPreservationProjection(contract)
  };
}

test('registration published-baseline preservation admits only an approved eight-path reconstruction', () => {
  const context = protocolPreservationFixture(),
    paths = [...registrationProtocolRepairPreservationPaths];
  const admits = (options) =>
    registrationProtocolRepairPreservationAdmission(paths, options, context.approvedProjection);
  assert.equal(paths.length, 8);
  assert.equal(admits(context), true);
  assert.equal(
    isRegistrationProtocolRepairPreservationOnly(paths, context),
    false,
    'the production classifier cannot accept a caller supplied synthetic approval'
  );
  for (const change of [
    { base: registrationProtocolRepairControlBase },
    { baseTree: '0'.repeat(40) },
    { repairSourcePaths: paths.slice(1) },
    { sourceDigest: () => '0'.repeat(64) }
  ])
    assert.equal(admits({ ...context, ...change }), false);
  for (const changed of [
    paths.slice(1),
    [...paths, paths[0]],
    [...paths, 'apps/api/prisma-mysql/schema.prisma'],
    [...paths, '.github/workflows/quality.yml'],
    [...paths, registrationProtocolRepairApplications[0]],
    [...paths, 'apps/api/src/id-business-v2/auto-registration/upstream/src/core/register.py']
  ])
    assert.equal(
      registrationProtocolRepairPreservationAdmission(changed, context, context.approvedProjection),
      false
    );
  assert.equal(
    registrationProtocolRepairPreservationAdmission(paths, context, '0'.repeat(64)),
    false
  );
});

test('registration published-baseline preservation selects only PR controls under a fixed synthetic approval', async () => {
  const context = protocolPreservationFixture(),
    paths = [...registrationProtocolRepairPreservationPaths],
    scopeUrl = new URL('./ci-recharge-scope.mjs', import.meta.url);
  // Replace the immutable approval only in this in-memory module; callers cannot replace the real pin.
  const source = readFileSync(scopeUrl, 'utf8')
    .replace(
      /export const registrationProtocolRepairPreservationProjectionSha256\s*=[\s\S]*?;/,
      'export const registrationProtocolRepairPreservationProjectionSha256 = ' +
        JSON.stringify(context.approvedProjection) +
        ';'
    )
    .replace(
      /from '(\.\/[^']+)'/g,
      (_, name) => 'from ' + JSON.stringify(new URL(name, scopeUrl).href)
    );
  const approved = await import('data:text/javascript,' + encodeURIComponent(source));
  assert.equal(approved.isRegistrationProtocolRepairPreservationOnly(paths, context), true);
  assert.equal(approved.checkMode(paths, 'same', 'same', undefined, context), 'ci-only');
  assert.deepEqual(approved.selectedParts(paths, undefined, context), ['guards']);
  assert.equal(approved.needsOnlineRechargeCiBuild(paths, context), false);
  assert.equal(approved.checkMode(paths, 'old', 'new', undefined, context), 'full');
  for (const options of [
    { ...context, base: registrationProtocolRepairControlBase },
    { ...context, baseTree: '0'.repeat(40) },
    { ...context, sourceDigest: () => '0'.repeat(64) }
  ])
    assert.equal(approved.checkMode(paths, 'same', 'same', undefined, options), 'full');
  for (const changed of [
    paths.slice(1),
    [...paths, registrationProtocolRepairApplications[0]],
    [...paths, 'apps/api/prisma-mysql/schema.prisma']
  ])
    assert.equal(approved.checkMode(changed, 'same', 'same', undefined, context), 'full');
});

test('registration published-baseline preservation rejects production shape application and excluded-map tampering', () => {
  for (const update of [
    (c) => {
      c.admission = 'DRAFT';
    },
    (c) => {
      c.migration = 'new.sql';
    },
    (c) => {
      c.sourceBaseline = registrationProtocolRepairControlBase;
    },
    (c) => {
      c.expectedCurrent = registrationProtocolRepairBase;
    },
    (c) => {
      c.baseline.api = 'unreviewed-api';
    },
    (c) => {
      c.reconstruction.publishedSources = 'unreviewed-source-map';
    },
    (c) => {
      c.reviewedFileHashes[registrationProtocolRepairApplications[0]] = 'd'.repeat(64);
    },
    (c) => {
      c.reviewedFileHashes[registrationProtocolRepairPreservationPaths[0]] = 'd'.repeat(64);
    },
    (c) => {
      c.controlHashes['unchanged-helper.py'] = 'd'.repeat(64);
    },
    (c) => {
      c.controlHashes['registration-protocol-repair-build.py'] = 'd'.repeat(64);
    },
    (c) => {
      c.sources[registrationProtocolRepairApplications[0]] = 'd'.repeat(64);
    }
  ]) {
    const context = protocolPreservationFixture();
    update(context.contract);
    assert.equal(
      registrationProtocolRepairPreservationAdmission(
        registrationProtocolRepairPreservationPaths,
        context,
        context.approvedProjection
      ),
      false
    );
    assert.equal(
      checkMode(registrationProtocolRepairPreservationPaths, 'same', 'same', undefined, context),
      'full'
    );
  }
  const context = protocolPreservationFixture();
  const required = new Set([
    ...Object.keys(context.contract.sources),
    ...Object.keys(context.contract.validationSources),
    ...Object.keys(context.contract.validationSupportSources),
    ...Object.keys(context.contract.buildSupportHashes),
    ...Object.keys(context.contract.controlHashes).map(
      (name) => 'scripts/production-release/' + name
    ),
    ...Object.keys(context.contract.reviewedFileHashes)
  ]);
  for (const name of required)
    assert.equal(
      registrationProtocolRepairPreservationAdmission(
        registrationProtocolRepairPreservationPaths,
        {
          ...context,
          sourceDigest: (candidate) =>
            candidate === name ? '0'.repeat(64) : context.sourceDigest(candidate)
        },
        context.approvedProjection
      ),
      false,
      name
    );
});

test('registration protocol preflight control repair selects only controls above the validated application', () => {
  const context = protocolPreflightControlFixture(),
    paths = [...registrationProtocolRepairControlPaths];
  assert.equal(paths.length, 7);
  assert.equal(isRegistrationProtocolRepairControlRepair(paths, context), true);
  assert.equal(checkMode(paths, 'same', 'same', undefined, context), 'ci-only');
  assert.deepEqual(selectedParts(paths, undefined, context), ['guards']);
  assert.equal(needsOnlineRechargeCiBuild(paths, context), false);
  assert.equal(
    isRegistrationProtocolRepairControlRepair(paths, {
      ...context,
      sourceDigest: (name) =>
        name === 'docs/V2_TASKS.md' ? '0'.repeat(64) : context.sourceDigest(name)
    }),
    true,
    'an unrelated document already merged into the new base is not an application drift'
  );
  assert.equal(checkMode(paths, 'before', 'after', undefined, context), 'full');
  assert.deepEqual(Object.keys(registrationProtocolRepairControlCommands), ['guards']);
  const commands = registrationProtocolRepairControlCommands.guards;
  assert.ok(
    commands.some(
      (command) =>
        command.includes('registration-protocol-repair-release.test.py') ||
        command.includes('scripts/production-release/registration-protocol-repair-release.test.py')
    )
  );
  assert.ok(
    commands.some(
      (command) =>
        command.includes('scripts/ci-recharge-scope.test.mjs') &&
        command.includes('scripts/ci-recharge-check.test.mjs')
    )
  );
  assert.ok(commands.some((command) => command.includes('prettier')));
  assert.ok(commands.some((command) => command.includes('eslint')));
  assert.equal(
    commands.some((command) =>
      command.some((arg) => /check-api|check-admin|check:v2-|prisma|acceptance/.test(arg))
    ),
    false
  );
  for (const override of [
    { base: registrationProtocolRepairBase },
    { base: '0'.repeat(40) },
    { baseTree: '0'.repeat(40) },
    { sourceDigest: () => '0'.repeat(64) },
    { repairSourcePaths: registrationProtocolRepairControlPaths.slice(1) },
    { repairSourcePaths: [...registrationProtocolRepairControlPaths, 'package-lock.json'] }
  ]) {
    const changed = { ...context, ...override };
    assert.equal(isRegistrationProtocolRepairControlRepair(paths, changed), false);
    assert.equal(checkMode(paths, 'same', 'same', undefined, changed), 'full');
  }
  for (const missing of paths) {
    const changed = paths.filter((name) => name !== missing);
    assert.equal(isRegistrationProtocolRepairControlRepair(changed, context), false);
    assert.equal(checkMode(changed, 'same', 'same', undefined, context), 'full');
  }
  for (const extra of [
    paths[0],
    registrationProtocolRepairApplications[0],
    registrationProtocolRepairAcceptance,
    'apps/api/prisma-mysql/schema.prisma',
    '.github/workflows/quality.yml',
    '.github/workflows/registration-protocol-repair-validation.yml',
    'apps/api/src/id-business-v2/auto-registration/upstream/src/core/register.py'
  ]) {
    const changed = [...paths, extra];
    assert.equal(isRegistrationProtocolRepairControlRepair(changed, context), false);
    assert.equal(checkMode(changed, 'same', 'same', undefined, context), 'full');
  }
});

test('registration protocol preflight control repair cannot rehash application baseline evidence or migration', () => {
  const paths = [...registrationProtocolRepairControlPaths];
  const initial = protocolPreflightControlFixture();
  const currentSources = new Set([
    ...registrationProtocolRepairApplications,
    registrationProtocolRepairAcceptance,
    ...Object.keys(initial.contract.validationSupportSources),
    ...Object.keys(initial.contract.buildSupportHashes),
    ...Object.keys(initial.contract.controlHashes).map(
      (name) => 'scripts/production-release/' + name
    ),
    ...registrationProtocolRepairControlPaths.filter(
      (name) => name !== registrationProtocolRepairContract
    )
  ]);
  for (const name of currentSources) {
    const context = protocolPreflightControlFixture();
    assert.equal(
      isRegistrationProtocolRepairControlRepair(paths, {
        ...context,
        sourceDigest: (candidate) =>
          candidate === name ? '0'.repeat(64) : context.sourceDigest(candidate)
      }),
      false,
      name
    );
  }
  assert.equal(
    isRegistrationProtocolRepairControlRepair(paths, {
      ...initial,
      validatedSourceDigest: () => '0'.repeat(64)
    }),
    false,
    'the original validated Git objects remain independently pinned'
  );
  for (const update of [
    (contract) => {
      contract.migration = 'new.sql';
    },
    (contract) => {
      contract.admission = 'DRAFT';
    },
    (contract) => {
      contract.sourceBaseline = registrationProtocolRepairBase;
    },
    (contract) => {
      contract.expectedGitChanges = [...registrationProtocolRepairPaths];
    },
    (contract) => {
      contract.baseline = { replacement: true };
    },
    (contract) => {
      contract.controlHashes['unchanged-helper.py'] = 'c'.repeat(64);
    },
    (contract) => {
      contract.controlHashes['registration-protocol-repair-release.py'] = 'c'.repeat(64);
    },
    (contract) => {
      const name = registrationProtocolRepairApplications[0];
      contract.sources[name] = contract.reviewedFileHashes[name] = 'c'.repeat(64);
    }
  ]) {
    const context = protocolPreflightControlFixture();
    update(context.contract);
    assert.equal(isRegistrationProtocolRepairControlRepair(paths, context), false);
    assert.equal(checkMode(paths, 'same', 'same', undefined, context), 'full');
  }
});

test('registration flow v4 admits only its exact verified unchanged-schema source', () => {
  const context = flowV4Fixture(),
    paths = [...registrationFlowV4Paths];
  assert.equal(new Set(paths).size, paths.length);
  assert.equal(isRegistrationFlowV4Only(paths, context), true);
  assert.equal(checkMode(paths, 'same', 'same', undefined, context), 'recharge');
  assert.deepEqual(selectedParts(paths, undefined, context), [...registrationFlowV4Parts]);
  assert.equal(needsOnlineRechargeCiBuild(paths, context), false);
  assert.equal(checkMode(paths, 'old', 'new', undefined, context), 'full');
  for (const override of [
    { base: '0'.repeat(40) },
    { baseTree: '0'.repeat(40) },
    { sourceDigest: () => 'b'.repeat(64) },
    { sourceDigest: null },
    {
      sourceDigest: () => {
        throw new Error('SYNTHETIC_READ_FAILURE');
      }
    }
  ]) {
    const changed = { ...context, ...override };
    assert.equal(isRegistrationFlowV4Only(paths, changed), false);
    assert.equal(checkMode(paths, 'same', 'same', undefined, changed), 'full');
    assert.equal(needsOnlineRechargeCiBuild(paths, changed), true);
  }
  for (const name of paths.filter((name) => name !== registrationFlowV4Contract)) {
    assert.equal(
      isRegistrationFlowV4Only(paths, {
        ...context,
        sourceDigest: (candidate) =>
          candidate === name ? 'b'.repeat(64) : context.sourceDigest(candidate)
      }),
      false,
      name
    );
  }
  for (const changed of [
    paths.slice(1),
    [...paths, paths[0]],
    [...paths, 'apps/api/prisma-mysql/schema.prisma'],
    [...paths, 'package-lock.json'],
    [...paths, '.github/workflows/quality.yml'],
    [...paths, 'apps/api/src/id-business-v2/auto-registration/upstream/src/core/register.py']
  ]) {
    assert.equal(isRegistrationFlowV4Only(changed, context), false);
    assert.equal(checkMode(changed, 'same', 'same', undefined, context), 'full');
  }
});

test('registration flow v4 rejects contract widening draft admission or detached hashes', () => {
  const context = flowV4Fixture(),
    paths = [...registrationFlowV4Paths];
  for (const override of [
    { version: 2 },
    { frozen: false },
    { admission: 'DRAFT' },
    { admission: { status: 'VERIFIED' } },
    { scope: 'REGISTRATION_PROTOCOL_RESTORE' },
    { name: 'other' },
    { migration: 'new.sql' },
    { businessActions: 1 },
    { pendingEvidence: ['unverified production baseline'] },
    { pendingEvidence: undefined },
    { pendingEvidence: {} },
    { pendingEvidence: '' },
    { sourceBaseline: '0'.repeat(40) },
    { sourceBaselineTree: '0'.repeat(40) },
    { applicationPaths: [...context.contract.applicationPaths, 'apps/api/src/main.ts'] },
    { expectedGitChanges: paths.slice(1) },
    {
      sources: {
        ...context.contract.sources,
        [registrationFlowV4Applications[0]]: 'b'.repeat(64)
      }
    },
    {
      validationSources: {
        ...context.contract.validationSources,
        'scripts/other.mjs': 'a'.repeat(64)
      }
    },
    {
      reviewedFileHashes: {
        ...context.contract.reviewedFileHashes,
        [registrationFlowV4Contract]: 'a'.repeat(64)
      }
    },
    { reviewedFileHashes: { ...context.contract.reviewedFileHashes, [paths[0]]: 'NOT_A_HASH' } }
  ])
    assert.equal(
      isRegistrationFlowV4Only(paths, {
        ...context,
        contract: { ...context.contract, ...override }
      }),
      false,
      JSON.stringify(override)
    );
  const controls = registrationFlowV4Commands.guards;
  for (const name of [
    'admin-ui',
    'v2-ui-language',
    'v2-color-contrast',
    'v2-table-standard',
    'v2-loading-standard',
    'v2-module-architecture',
    'v2-isolation'
  ]) {
    assert.ok(controls.some((command) => command.join(' ') === 'npm run check:' + name));
  }
  assert.deepEqual(registrationFlowV4Commands['release-controls'], [controls[0]]);
  assert.ok(
    controls.some(
      (command) =>
        command.includes('scripts/ci-recharge-scope.test.mjs') &&
        command.includes('scripts/ci-recharge-check.test.mjs')
    )
  );
  assert.ok(controls.some((command) => command.includes('prettier')));
  assert.ok(controls.some((command) => command.includes('eslint')));
});

test('registration protocol repair admits only its exact verified unchanged-schema source', () => {
  const context = protocolRepairFixture(),
    paths = [...registrationProtocolRepairPaths];
  assert.equal(paths.length, 28);
  assert.equal(isRegistrationProtocolRepairOnly(paths, context), true);
  assert.equal(checkMode(paths, 'same', 'same', undefined, context), 'recharge');
  assert.deepEqual(selectedParts(paths, undefined, context), [...registrationProtocolRepairParts]);
  assert.equal(needsOnlineRechargeCiBuild(paths, context), false);
  assert.equal(checkMode(paths, 'old', 'new', undefined, context), 'full');
  for (const override of [
    { base: '0'.repeat(40) },
    { baseTree: '0'.repeat(40) },
    { sourceDigest: () => 'b'.repeat(64) },
    { sourceDigest: null },
    {
      sourceDigest: () => {
        throw new Error('SYNTHETIC_READ_FAILURE');
      }
    }
  ]) {
    const changed = { ...context, ...override };
    assert.equal(isRegistrationProtocolRepairOnly(paths, changed), false);
    assert.equal(checkMode(paths, 'same', 'same', undefined, changed), 'full');
    assert.equal(needsOnlineRechargeCiBuild(paths, changed), true);
  }
  for (const name of paths.filter((name) => name !== registrationProtocolRepairContract)) {
    assert.equal(
      isRegistrationProtocolRepairOnly(paths, {
        ...context,
        sourceDigest: (candidate) =>
          candidate === name ? 'b'.repeat(64) : context.sourceDigest(candidate)
      }),
      false,
      name
    );
  }
  for (const changed of [
    paths.slice(1),
    [...paths, paths[0]],
    [...paths, 'apps/api/prisma-mysql/schema.prisma'],
    [...paths, 'package-lock.json'],
    [...paths, '.github/workflows/quality.yml'],
    [...paths, 'apps/api/src/id-business-v2/auto-registration/upstream/src/core/register.py']
  ]) {
    assert.equal(isRegistrationProtocolRepairOnly(changed, context), false);
    assert.equal(checkMode(changed, 'same', 'same', undefined, context), 'full');
  }
});

test('registration protocol repair rejects contract widening draft admission or detached hashes', () => {
  const context = protocolRepairFixture(),
    paths = [...registrationProtocolRepairPaths];
  for (const override of [
    { version: 2 },
    { frozen: false },
    { admission: 'DRAFT' },
    { admission: { status: 'VERIFIED' } },
    { scope: 'REGISTRATION_PROTOCOL_RESTORE' },
    { name: 'other' },
    { migration: 'new.sql' },
    { businessActions: 1 },
    { sourceBaseline: '0'.repeat(40) },
    { sourceBaselineTree: '0'.repeat(40) },
    { applicationPaths: [...context.contract.applicationPaths, 'apps/api/src/main.ts'] },
    { expectedGitChanges: paths.slice(1) },
    {
      sources: {
        ...context.contract.sources,
        [registrationProtocolRepairApplications[0]]: 'b'.repeat(64)
      }
    },
    {
      validationSources: {
        ...context.contract.validationSources,
        'scripts/other.mjs': 'a'.repeat(64)
      }
    },
    {
      reviewedFileHashes: {
        ...context.contract.reviewedFileHashes,
        [registrationProtocolRepairContract]: 'a'.repeat(64)
      }
    },
    { reviewedFileHashes: { ...context.contract.reviewedFileHashes, [paths[0]]: 'NOT_A_HASH' } }
  ])
    assert.equal(
      isRegistrationProtocolRepairOnly(paths, {
        ...context,
        contract: { ...context.contract, ...override }
      }),
      false,
      JSON.stringify(override)
    );
  const controls = registrationProtocolRepairCommands.guards;
  for (const name of [
    'admin-ui',
    'v2-ui-language',
    'v2-color-contrast',
    'v2-table-standard',
    'v2-loading-standard',
    'v2-module-architecture',
    'v2-isolation'
  ]) {
    assert.ok(controls.some((command) => command.join(' ') === 'npm run check:' + name));
  }
  assert.deepEqual(registrationProtocolRepairCommands['release-controls'], [controls[0]]);
  assert.ok(
    controls.some(
      (command) =>
        command.includes('scripts/ci-recharge-scope.test.mjs') &&
        command.includes('scripts/ci-recharge-check.test.mjs')
    )
  );
  assert.ok(controls.some((command) => command.includes('prettier')));
  assert.ok(controls.some((command) => command.includes('eslint')));
});

test('registration protocol image-user repair selects guards only without ONLINE or candidate suites', () => {
  const prior = JSON.parse(
    execFileSync(
      'git',
      [
        'show',
        registrationProtocolRestoreRepairBase +
          ':scripts/production-release/registration-protocol-restore-contract.json'
      ],
      { encoding: 'utf8' }
    )
  );
  const contract = structuredClone(prior);
  contract.validationBaselineSources = {
    ...prior.validationBaselineSources,
    ...registrationProtocolRestoreRepairGuard
  };
  const context = {
    base: registrationProtocolRestoreRepairBase,
    baseTree: registrationProtocolRestoreRepairTree,
    contract,
    repairBaseContract: prior,
    sourceDigest: (name) =>
      registrationProtocolRestoreRepairGuard[name] ?? contract.reviewedFileHashes[name] ?? null,
    baseSourceDigest: (name) => registrationProtocolRestoreRemovedSources[name] ?? null
  };
  const paths = [...registrationProtocolRestoreRepairPaths];
  assert.equal(paths.length, 9);
  assert.equal(
    paths.includes('scripts/production-release/registration-protocol-restore-release.py'),
    true
  );
  assert.equal(checkMode(paths, 'same', 'same', undefined, context), 'ci-only');
  assert.deepEqual(selectedParts(paths, undefined, context), ['guards']);
  assert.equal(needsOnlineRechargeCiBuild(paths, context), false);
  assert.equal(checkMode(paths, 'before', 'after', undefined, context), 'full');
  for (const change of [
    { base: registrationProtocolRestoreBase },
    { base: 'dc3c022de71ee702d627ad8231828e1d89866105' },
    { baseTree: '0'.repeat(40) },
    { sourceDigest: () => 'b'.repeat(64) },
    { contract: { ...contract, reviewedApplicationCommit: '0'.repeat(40) } }
  ])
    assert.equal(checkMode(paths, 'same', 'same', undefined, { ...context, ...change }), 'full');
  assert.equal(
    checkMode(
      [...paths, 'apps/api/prisma-mysql/schema.prisma'],
      'same',
      'same',
      undefined,
      context
    ),
    'full'
  );
  assert.equal(checkMode(paths.slice(1), 'same', 'same', undefined, context), 'full');
});

test('registration protocol restore admits only exact deletions and preserves the current schema', () => {
  const paths = [...registrationProtocolRestorePaths];
  const removed = registrationProtocolRestoreRemovedSources;
  const reviewed = Object.fromEntries(
    paths
      .filter(
        (name) =>
          !(name in removed) &&
          name !== 'scripts/production-release/registration-protocol-restore-contract.json'
      )
      .map((name) => [name, 'a'.repeat(64)])
  );
  const context = {
    base: registrationProtocolRestoreBase,
    baseTree: registrationProtocolRestoreTree,
    sourceDigest: (name) => reviewed[name] ?? null,
    baseSourceDigest: (name) => removed[name] ?? null,
    contract: {
      version: 1,
      frozen: true,
      scope: 'REGISTRATION_PROTOCOL_RESTORE',
      migration: null,
      sourceBaseline: registrationProtocolRestoreBase,
      sourceBaselineTree: registrationProtocolRestoreTree,
      expectedCurrent: '123ea34df9bf74a1d65e74bd70f336eaa9344165',
      schemaSha256: '51a4d25b1302458145f560acc32f25b89a7bd65fea64dc72b254dc56da430100',
      runtimeEvidence: { status: 'VERIFIED', commit: '123ea34df9bf74a1d65e74bd70f336eaa9344165' },
      expectedGitChanges: paths,
      withdrawal: { sourceRemovals: { ...removed } },
      reviewedFileHashes: reviewed
    }
  };
  assert.equal(checkMode(paths, 'same', 'same', undefined, context), 'recharge');
  assert.deepEqual(selectedParts(paths, undefined, context), ['guards', 'api', 'admin']);
  assert.equal(needsOnlineRechargeCiBuild(paths, context), false);
  assert.equal(checkMode(paths, 'before', 'after', undefined, context), 'full');
  for (const change of [
    { base: '0'.repeat(40) },
    { baseTree: '0'.repeat(40) },
    { baseSourceDigest: () => '0'.repeat(64) },
    { contract: { ...context.contract, frozen: false } }
  ]) {
    assert.equal(checkMode(paths, 'same', 'same', undefined, { ...context, ...change }), 'full');
  }
  assert.equal(
    checkMode(
      [...paths, 'apps/api/prisma-mysql/schema.prisma'],
      'same',
      'same',
      undefined,
      context
    ),
    'full'
  );
});

test('registration browser selects four affected checks only for the complete frozen source and unchanged schema', () => {
  const paths = [...registrationBrowserPaths];
  const hashes = Object.fromEntries(
    registrationBrowserReviewedPaths
      .filter((name) => name !== registrationBrowserContract)
      .map((name) => [name, 'a'.repeat(64)])
  );
  const context = {
    base: registrationBrowserBase,
    baseTree: registrationBrowserTree,
    sourceDigest: (name) => hashes[name],
    contract: {
      version: 1,
      frozen: true,
      scope: 'REGISTRATION_BROWSER',
      sourceBaseline: registrationBrowserBase,
      sourceBaselineTree: registrationBrowserTree,
      expectedCurrent: registrationBrowserCurrent,
      migration: null,
      expectedGitChanges: [...registrationBrowserReviewedPaths],
      sourceDeltaPaths: paths,
      allowedApplicationPaths: [...registrationBrowserApplications],
      controlPaths: [...registrationBrowserControls],
      sources: Object.fromEntries(
        registrationBrowserApplications.map((name) => [name, hashes[name]])
      ),
      validationSources: { [registrationBrowserAcceptance]: hashes[registrationBrowserAcceptance] },
      reviewedFileHashes: hashes
    }
  };
  assert.equal(checkMode(paths, 'same', 'same', undefined, context), 'recharge');
  assert.deepEqual(selectedParts(paths, undefined, context), [...registrationBrowserParts]);
  assert.equal(needsOnlineRechargeCiBuild(paths, context), false);
  assert.equal(checkMode(paths, 'before', 'after', undefined, context), 'full');
  for (const changed of [
    { base: '0'.repeat(40) },
    { baseTree: '0'.repeat(40) },
    { contract: { ...context.contract, frozen: false } }
  ])
    assert.equal(checkMode(paths, 'same', 'same', undefined, { ...context, ...changed }), 'full');
  for (const name of [
    'apps/api/prisma-mysql/schema.prisma',
    'package-lock.json',
    'apps/admin/src/v2/features/auto-recharge/useAutoRecharge.ts'
  ])
    assert.equal(checkMode([...paths, name], 'same', 'same', undefined, context), 'full');
});

test('registration parity selects every affected check only with exact reviewed bytes and unchanged schema', () => {
  const paths = [...registrationParityDiagnosticsPaths];
  const hashes = Object.fromEntries(
    paths.filter((p) => p !== registrationParityDiagnosticsContract).map((p) => [p, 'a'.repeat(64)])
  );
  const context = {
    base: registrationParityDiagnosticsBase,
    baseTree: registrationParityDiagnosticsTree,
    sourceDigest: (p) => hashes[p],
    contract: {
      frozen: true,
      scope: 'REGISTRATION_PARITY_DIAGNOSTICS',
      sourceBaseline: registrationParityDiagnosticsBase,
      sourceBaselineTree: registrationParityDiagnosticsTree,
      expectedCurrent: registrationParityDiagnosticsCurrent,
      migration: null,
      expectedGitChanges: paths,
      sourceDeltaPaths: [...registrationParityDiagnosticsRepairPaths],
      allowedApplicationPaths: [...registrationParityDiagnosticsApplications],
      controlPaths: [...registrationParityDiagnosticsControls],
      sources: Object.fromEntries(
        registrationParityDiagnosticsApplications.map((p) => [p, hashes[p]])
      ),
      validationSources: {
        [registrationParityDiagnosticsAcceptance]: hashes[registrationParityDiagnosticsAcceptance]
      },
      reviewedFileHashes: hashes
    }
  };
  assert.equal(checkMode(paths, 'same-schema', 'same-schema', undefined, context), 'recharge');
  assert.deepEqual(selectedParts(paths, undefined, context), [
    ...registrationParityDiagnosticsParts
  ]);
  assert.equal(needsOnlineRechargeCiBuild(paths, context), false);
  const repairContext = {
    ...context,
    base: registrationParityDiagnosticsRepairBase,
    baseTree: registrationParityDiagnosticsRepairTree
  };
  assert.equal(
    checkMode(registrationParityDiagnosticsRepairPaths, 'same', 'same', undefined, repairContext),
    'ci-only'
  );
  assert.deepEqual(
    selectedParts(registrationParityDiagnosticsRepairPaths, undefined, repairContext),
    ['guards']
  );
  assert.equal(
    needsOnlineRechargeCiBuild(registrationParityDiagnosticsRepairPaths, repairContext),
    false
  );
  assert.equal(
    checkMode(
      registrationParityDiagnosticsRepairPaths,
      'before',
      'after',
      undefined,
      repairContext
    ),
    'full'
  );
  assert.equal(
    checkMode(
      [...registrationParityDiagnosticsRepairPaths, 'apps/api/prisma-mysql/schema.prisma'],
      'before',
      'after',
      undefined,
      repairContext
    ),
    'full'
  );
  assert.equal(checkMode(paths, 'before', 'after', undefined, context), 'full');
  for (const path of [
    'apps/api/prisma-mysql/schema.prisma',
    'package-lock.json',
    'apps/api/src/id-business-v2/auto-registration/upstream/src/core/register.py'
  ])
    assert.equal(checkMode([...paths, path], 'same', 'same', undefined, context), 'full');
  assert.equal(
    checkMode(paths, 'same', 'same', undefined, { ...context, base: 'b'.repeat(40) }),
    'full'
  );
});

// The original registration recovery proves the already published 7c tree.
// Later proxy, order-layout and Sales repairs intentionally advance these inputs, so
// historical recovery cases read their immutable source bytes. Production
// selectors still read current files and reject changes to the old receipt.
const registrationPublishedHead = '7c3c102c98539d33cb379ef018427371ba750cb7';
const registrationManifestPath =
  'apps/api/src/id-business-v2/online-recharge/engine/SOURCE_MANIFEST.json';
const registrationLayoutPaths = [
  'apps/admin/src/v2/features/auto-recharge/BitOrderPricingSettings.vue',
  'apps/admin/src/v2/features/auto-recharge/V2BankRechargeOrdersView.vue',
  'apps/admin/src/v2/features/auto-recharge/V2RechargeOrdersChannelView.vue',
  'apps/admin/src/v2/features/online-recharge/OnlineOrderBackfill.vue'
];
const registrationCountryPaths = [
  'apps/api/src/id-business-v2/online-recharge/contracts.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/settings.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/tasks.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/proxy-input.ts'
];
const registrationSalesPaths = [
  'apps/admin/src/v2/features/auto-recharge/bank-recharge-api.ts',
  'apps/admin/src/v2/features/tableSchemas.ts',
  'apps/api/prisma-mysql/schema.prisma',
  'apps/api/src/id-business-v2/auto-recharge/bank-recharge-account-list.ts',
  'apps/api/src/id-business-v2/auto-recharge/bank-recharge.controller.ts'
];
const registrationAdvancedPaths = [
  // Progress cancellation advances the client; historical recovery retains its pinned bytes.
  'apps/admin/src/v2/features/online-recharge/api.ts',
  'apps/admin/src/v2/features/online-recharge/api.spec.ts',
  'apps/admin/src/v2/features/online-recharge/public-api.ts',
  'apps/admin/src/v2/features/customers/useCustomersPage.ts',
  'apps/api/src/id-business-v2/auto-recharge/recharge.module.ts',
  'apps/api/src/id-business-v2/auto-recharge/bank-recharge-mysql.integration.spec.ts',
  'apps/api/src/id-business-v2/auto-recharge/persistence/bank-recharge.repository.ts',
  'apps/admin/src/v2/features/online-recharge/OnlineResultDialog.vue',
  'apps/api/src/id-business-v2/online-recharge/engine/confirmation.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/plans.cjs',
  'apps/api/src/id-business-v2/online-recharge/persistence/admin.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/worker.repository.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/worker.repository.ts',
  'apps/admin/src/v2/features/auto-recharge/V2BankRechargeOrderDrawers.vue',
  'apps/admin/src/v2/features/auto-recharge/bank-orders-manifest.ts',
  'apps/admin/src/v2/features/auto-recharge/useBankRechargeOrderResources.ts',
  'apps/admin/src/v2/features/auto-recharge/useBankRechargeOrdersPage.spec.ts',
  'apps/admin/src/v2/features/auto-recharge/useBankRechargeOrdersPage.ts',
  'apps/api/src/id-business-v2/auto-recharge/bank-recharge-order.service.ts',
  'apps/api/src/id-business-v2/auto-recharge/bank-recharge-verified-order.ts',
  'apps/api/src/id-business-v2/online-recharge/online-recharge.module.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/online-recharge.repository.ts'
];
const registrationHistoricalBinding = JSON.parse(fs.readFileSync(registrationPublishedBindingPath));
const registrationSourceFixtures = Object.fromEntries(
  [
    registrationManifestPath,
    ...Object.keys(registrationHistoricalBinding.sources),
    ...Object.keys(registrationHistoricalBinding.combinedSources),
    ...Object.keys(registrationHistoricalBinding.validationSources),
    'scripts/production-release/registration-closure-release.py',
    'scripts/production-release/registration-closure-release.test.py',
    // The GPT successor advances this historical module without changing its receipt.
    'apps/api/src/id-business-v2/online-recharge/online-recharge.module.ts',
    // Table container wording advances independently of the immutable recovery receipt.
    'scripts/check-v2-table-standard.mjs',
    // Checkout limits advance validation without changing historical registration evidence.
    'apps/api/src/id-business-v2/online-recharge/validation.ts',
    'apps/api/src/id-business-v2/online-recharge/validation.spec.ts',
    ...registrationLayoutPaths,
    ...registrationCountryPaths,
    ...registrationSalesPaths,
    ...registrationAdvancedPaths
  ].map((path) => [
    path,
    execFileSync('git', ['show', registrationPublishedHead + ':' + path]).toString('utf8')
  ])
);
const registrationFixtureBytes = new Map(
  Object.entries(registrationSourceFixtures).flatMap(([path, source]) =>
    [
      path,
      new URL('../' + path, import.meta.url).href,
      new URL('../' + path, import.meta.url).pathname
    ].map((name) => [name, Buffer.from(source)])
  )
);
const actualReadFileSync = fs.readFileSync;
const readRegistrationFixture = (path, options) => {
  const source = registrationFixtureBytes.get(String(path));
  return source
    ? typeof options === 'string'
      ? source.toString(options)
      : Buffer.from(source)
    : actualReadFileSync(path, options);
};
test.beforeEach(() => {
  fs.readFileSync = readRegistrationFixture;
  syncBuiltinESMExports();
});
test.afterEach(() => {
  fs.readFileSync = actualReadFileSync;
  syncBuiltinESMExports();
});

test('formal registration engine dependency repair is exact and never admits business or neighboring controls', () => {
  const paths = [
    '.github/workflows/registration-closure-validation.yml',
    'scripts/production-release/registration-closure-release.test.py',
    'scripts/ci-registration-closure-native-reuse.test.mjs'
  ];
  const options = {
    base: registrationEnvironmentRepairBase,
    baseTree: 'a1ffd620d2b79630b9c1e9db700d6af765f33a50',
    readSource: (path) =>
      execFileSync('git', ['show', 'cd7bba03bec1742328e0829c215823bda1fd3fae:' + path])
  };
  assert.equal(isRegistrationEnvironmentRepair(paths, options), true);
  assert.equal(checkMode(paths, schema, schema), 'ci-only');
  assert.deepEqual(selectedParts(paths), ['guards']);
  for (const extra of [
    'apps/api/src/id-business-v2/online-recharge/public.controller.ts',
    'apps/admin/src/v2/features/auto-registration/api.ts',
    'packages/shared/src/index.ts',
    '.github/workflows/quality.yml',
    '.github/workflows/registration-other.yml',
    'package-lock.json',
    'scripts/production-release/registration-closure-release.py',
    'scripts/production-release/registration-closure-contract.json',
    'scripts/ci-registration-closure-native-reuse.mjs'
  ])
    assert.equal(isRegistrationEnvironmentRepair([...paths, extra], options), false, extra);
  assert.equal(isRegistrationEnvironmentRepair(paths, { ...options, base: 'a'.repeat(40) }), false);
  assert.equal(
    isRegistrationEnvironmentRepair(paths, { ...options, baseTree: 'a'.repeat(40) }),
    false
  );
  assert.equal(isRegistrationEnvironmentRepair(paths.slice(1), options), false);
  for (const drift of paths)
    assert.equal(
      isRegistrationEnvironmentRepair(paths, {
        ...options,
        readSource: (path) =>
          path === drift ? Buffer.from('UNREVIEWED') : options.readSource(path)
      }),
      false,
      drift
    );
});

test('single proven Prisma declaration propagation has its own exact control-only case', () => {
  const paths = [
    'scripts/production-release/registration-closure-contract.json',
    'scripts/production-release/registration-closure-release.test.py'
  ];
  const options = {
    base: registrationDeclarationRepairBase,
    baseTree: '874102957cbd6cc921e05e5bba252e63bd09fd85',
    readSource: (path) =>
      execFileSync('git', ['show', 'd38c243b5727953aa96c0fa83e706fee253c9624:' + path])
  };
  assert.equal(isRegistrationDeclarationRepair(paths, options), true);
  assert.equal(checkMode(paths, schema, schema), 'ci-only');
  assert.deepEqual(selectedParts(paths), ['guards']);
  for (const extra of [
    'apps/api/src/id-business-v2/auto-recharge/persistence/recharge-card-removal.repository.ts',
    'apps/admin/src/v2/features/auto-registration/api.ts',
    'packages/shared/src/index.ts',
    'apps/api/prisma-mysql/schema.prisma',
    'package-lock.json',
    '.github/workflows/quality.yml',
    '.github/workflows/registration-closure-validation.yml',
    'scripts/production-release/registration-closure-build.py',
    'scripts/production-release/registration-closure-release.py',
    'scripts/ci-registration-closure-native-reuse.mjs',
    'scripts/ci-registration-closure-native-reuse.test.mjs'
  ])
    assert.equal(isRegistrationDeclarationRepair([...paths, extra], options), false, extra);
  assert.equal(
    isRegistrationDeclarationRepair(paths, { ...options, base: registrationEnvironmentRepairBase }),
    false
  );
  assert.equal(
    isRegistrationDeclarationRepair(paths, { ...options, baseTree: 'a'.repeat(40) }),
    false
  );
  assert.equal(isRegistrationDeclarationRepair(paths.slice(1), options), false);
  for (const drift of paths)
    assert.equal(
      isRegistrationDeclarationRepair(paths, {
        ...options,
        readSource: (path) =>
          path === drift ? Buffer.from('UNREVIEWED') : options.readSource(path)
      }),
      false,
      drift
    );
});

test('migration query marker repair stays on its exact controller and regression bytes', () => {
  const paths = [
    'scripts/production-release/registration-closure-release.py',
    'scripts/production-release/registration-closure-release.test.py'
  ];
  const options = {
    base: registrationMigrationQueryRepairBase,
    baseTree: 'a331c3ab6b23c3331aa550b752d9d66860e62cdb'
  };
  assert.equal(isRegistrationMigrationQueryRepair(paths, options), true);
  assert.equal(checkMode(paths, schema, schema), 'ci-only');
  assert.deepEqual(selectedParts(paths), ['guards']);
  for (const extra of [
    'apps/api/src/id-business-v2/online-recharge/public.controller.ts',
    'apps/admin/src/v2/features/auto-registration/api.ts',
    'packages/shared/src/index.ts',
    'apps/api/prisma-mysql/schema.prisma',
    'package-lock.json',
    '.github/workflows/quality.yml',
    '.github/workflows/registration-closure-validation.yml',
    'scripts/production-release/registration-closure-build.py',
    'scripts/production-release/registration-closure-contract.json',
    'scripts/ci-registration-closure-native-reuse.mjs'
  ])
    assert.equal(isRegistrationMigrationQueryRepair([...paths, extra], options), false, extra);
  assert.equal(
    isRegistrationMigrationQueryRepair(paths, {
      ...options,
      base: registrationDeclarationRepairBase
    }),
    false
  );
  assert.equal(
    isRegistrationMigrationQueryRepair(paths, { ...options, baseTree: 'a'.repeat(40) }),
    false
  );
  assert.equal(isRegistrationMigrationQueryRepair(paths.slice(1), options), false);
  for (const drift of paths)
    assert.equal(
      isRegistrationMigrationQueryRepair(paths, {
        ...options,
        readSource: (path) => (path === drift ? Buffer.from('UNREVIEWED') : readFileSync(path))
      }),
      false,
      drift
    );
});

test('independent BitBrowser billing uses the recharge checks and its built-page acceptance', () => {
  const paths = [
    'apps/admin/src/v2/features/auto-recharge/useRechargeAddressGeneration.ts',
    'apps/api/src/id-business-v2/auto-recharge/recharge-billing-generator.ts',
    'scripts/acceptance-v2-recharge-billing.mjs',
    'docs/BIT_RECHARGE_BILLING_GENERATION_20261016.md'
  ];
  const schema = readFileSync('apps/api/prisma-mysql/schema.prisma', 'utf8');
  assert.equal(checkMode(paths, schema, schema), 'recharge');
  assert.deepEqual(selectedParts(paths), ['guards', 'admin', 'api']);
  assert.ok(
    adminCheckCommands('recharge', paths).some(
      (args) => args.join(' ') === 'exec -- node scripts/acceptance-v2-recharge-billing.mjs'
    )
  );
  assert.equal(
    checkMode([...paths, 'scripts/acceptance-v2-unreviewed.mjs'], schema, schema),
    'full'
  );
});

test('ONLINE CI build has finite inputs and read-only diagnostics remain control-only', () => {
  for (const path of onlineCiBuildControlPaths) {
    assert.equal(isCiOnly([path]), true, path);
    assert.deepEqual(selectedParts([path]), ['guards']);
  }
  for (const path of [
    'scripts/production-release/online-recharge-ci-build.py',
    'scripts/production-release/online-recharge-component-runtime.py',
    'scripts/production-release/online-recharge-component-readonly.py',
    'scripts/production-release/build-images.sh',
    '.github/workflows/quality.yml',
    'apps/api/Dockerfile.mysql',
    'apps/admin/Dockerfile',
    'apps/api/package.json',
    'apps/admin/package.json',
    'packages/shared/package.json',
    'scripts/audit-python-dependencies.py',
    'apps/api/src/id-business-v2/online-recharge/engine/.dockerignore',
    'apps/api/src/id-business-v2/online-recharge/engine/requirements-hcaptcha.lock.txt',
    'apps/api/src/id-business-v2/online-recharge/engine/upstream/package-lock.json',
    'apps/api/src/id-business-v2/online-recharge/engine/upstream/payment.js',
    'apps/api/src/id-business-v2/online-recharge/engine/Dockerfile'
  ])
    assert.equal(needsOnlineRechargeCiBuild([path]), true, path);
  for (const path of [
    '.github/workflows/online-recharge-diagnostic.yml',
    'scripts/production-release/online-recharge-ci-build.test.py',
    'scripts/production-release/online-recharge-component-lifecycle.test.py',
    'scripts/production-release/online-recharge-component-diagnostic.py',
    'scripts/production-release/online-recharge-component-recovery.py',
    'scripts/production-release/online-recharge-component-recovery.test.py',
    'scripts/production-release/online-recharge-component-recovery-readonly.py',
    '.github/workflows/online-recharge-recovery.yml',
    'docs/ONLINE_RECHARGE.md',
    'apps/admin/src/v2/features/online-recharge/OnlineRechargePage.vue',
    'apps/admin/src/v2/features/customers/CustomerPage.vue'
  ])
    assert.equal(needsOnlineRechargeCiBuild([path]), false, path);
  assert.equal(needsOnlineRechargeCiBuild([]), false);
  for (const path of [
    'scripts/production-release/online-recharge-ci-build-write.py',
    'scripts/production-release/online-recharge-ci-build.py.backup',
    '.github/workflows/online-recharge-diagnostic-write.yml',
    'scripts/production-release/online-recharge-component-recovery-write.py',
    'scripts/production-release/online-recharge-component-recovery.py.backup',
    '.github/workflows/online-recharge-recovery-write.yml'
  ])
    assert.equal(isCiOnly([path]), false, path);
});

test('ordinary Admin publication retains Admin build/UI without selecting historical four-image projection', () => {
  const paths = [
    'apps/admin/src/v2-router.ts',
    'apps/admin/src/v2/features/online-recharge/V2OnlineRedeemView.vue',
    'apps/admin/src/v2/features/auto-recharge/bitbrowser-direct-login.ts',
    'scripts/check-v2-input-retention.mjs',
    'scripts/check-v2-online-recharge-controls.test.mjs',
    'scripts/acceptance-v2-online-recharge-ui.mjs',
    'scripts/production-release/online-recharge-ci-build.test.py',
    'scripts/production-release/online-recharge-component-lifecycle.test.py',
    'scripts/ci-recharge-scope.mjs',
    'scripts/ci-recharge-scope.test.mjs',
    'docs/V2_TASKS.md'
  ];
  assert.equal(checkMode(paths, schema, schema), 'admin');
  assert.deepEqual(selectedParts(paths), ['guards', 'admin']);
  assert.equal(needsOnlineRechargeCiBuild(paths), false);
  const commands = adminCheckCommands('admin', paths).map((args) => args.join(' '));
  assert.ok(commands.includes('run test --workspace @apple-business/admin'));
  assert.ok(commands.includes('run build --workspace @apple-business/admin'));
  assert.ok(commands.includes('run acceptance:v2-online-recharge-ui'));
  assert.ok(commands.includes('run acceptance:v2-auto-recharge'));
  assert.equal(adminUiGuardChecks('admin', paths).length, 8);
  for (const input of [
    'apps/api/src/id-business-v2/online-recharge/online-recharge.service.ts',
    'apps/api/src/id-business-v2/online-recharge/engine/worker.cjs',
    'apps/api/Dockerfile.mysql',
    'apps/admin/Dockerfile',
    'apps/api/package.json',
    'apps/admin/package.json',
    'packages/shared/package.json',
    'packages/shared/src/v2/auto-recharge.ts',
    'package.json',
    'package-lock.json',
    '.dockerignore',
    'tsconfig.base.json',
    'deploy/nginx/admin.conf',
    '.github/workflows/quality.yml',
    '.github/workflows/production-release.yml',
    'scripts/ci-recharge-check.mjs',
    'scripts/production-release/build-images.sh',
    'scripts/production-release/online-recharge-ci-build.py',
    'scripts/production-release/online-recharge-component-runtime.py'
  ])
    assert.equal(needsOnlineRechargeCiBuild([...paths, input]), true, input);
  assert.equal(needsOnlineRechargeCiBuild(['scripts/ci-recharge-scope.mjs']), true);
  const testsOnly = [
    'scripts/production-release/online-recharge-ci-build.test.py',
    'scripts/production-release/online-recharge-component-lifecycle.test.py'
  ];
  for (const changed of [...testsOnly.map((path) => [path]), testsOnly]) {
    assert.equal(checkMode(changed, schema, schema), 'ci-only');
    assert.deepEqual(selectedParts(changed), ['guards']);
    assert.equal(needsOnlineRechargeCiBuild(changed), false);
  }
});

test('archive-only controls never select ONLINE images while mixed ONLINE changes retain the build gate', () => {
  const archive = [
    ...releaseArtifactRetentionControls,
    'scripts/ci-recharge-scope.mjs',
    'scripts/ci-recharge-check.mjs',
    'docs/DISK_STORAGE_POLICY.md'
  ];
  assert.equal(isReleaseArtifactRetentionOnly(archive), true);
  assert.equal(needsOnlineRechargeCiBuild(archive), false);
  for (const online of [
    'scripts/production-release/online-recharge-component-runtime.py',
    'scripts/production-release/online-recharge-ci-build.py',
    'apps/api/src/id-business-v2/online-recharge/engine/worker.cjs'
  ]) {
    assert.equal(isReleaseArtifactRetentionOnly([...archive, online]), false);
    assert.equal(needsOnlineRechargeCiBuild([...archive, online]), true);
  }
});

test('typed receipt repair mixed with ONLINE and archive controls retains every affected guard and image check', () => {
  const paths = [
    ...onlinePreflightReceiptFixGuardPaths,
    ...onlineCiBuildControlPaths,
    ...releaseArtifactRetentionControls
  ];
  assert.equal(checkMode(paths, '', ''), 'ci-only');
  // The main classifier uses only guards for ci-only; the raw dependency
  // selector also includes consumers of a changed dispatcher.
  assert.ok(selectedParts(paths).includes('guards'));
  assert.equal(isReleaseArtifactRetentionOnly(paths), false);
  assert.equal(needsOnlineRechargeCiBuild(paths), true);
  for (const path of [
    'scripts/production-release/online-recharge-component-runtime.py',
    'scripts/production-release/online-recharge-component-runtime.test.py'
  ])
    assert.ok(paths.includes(path));
});

test('ordinary ONLINE component controls remain finite and do not select a database part', () => {
  const paths = [
    'scripts/production-release/online-recharge-component-consumer.py',
    'scripts/production-release/online-recharge-component-consumer.test.py',
    'scripts/production-release/online-recharge-component-runtime.py',
    'scripts/production-release/online-recharge-component-runtime.test.py',
    'scripts/production-release/online-recharge-component-readonly.py',
    'scripts/production-release/online-recharge-component-readonly.test.py'
  ];
  assert.equal(checkMode(paths, '', ''), 'ci-only');
  assert.deepEqual(selectedParts(paths), ['guards']);
  for (const extra of [
    'scripts/production-release/online-recharge-component-consumer-write.py',
    'scripts/production-release/online-recharge-component-consumer.py.backup',
    'scripts/production-release/online-recharge-component-runtime-write.py',
    'scripts/production-release/online-recharge-component-readonly.py.backup',
    'apps/api/src/auth/unknown.ts'
  ])
    assert.equal(checkMode([...paths, extra], '', ''), 'full');
});

test('Admin successor diagnostics have a finite control scope', () => {
  const paths = [
    'scripts/production-release/admin-successor-diagnostic.py',
    'scripts/production-release/admin-successor-diagnostic.test.py'
  ];
  assert.equal(isCiOnly(paths), true);
  assert.equal(checkMode(paths, '', ''), 'ci-only');
  assert.equal(
    checkMode([...paths, 'apps/admin/src/v2/components/workspace/V2WorkspaceDock.vue'], '', ''),
    'admin'
  );
  for (const other of [
    'scripts/production-release/admin-successor-diagnostic.py.backup',
    'scripts/production-release/admin-successor-diagnostic-write.py',
    'apps/api/src/auth/unknown.ts'
  ])
    assert.equal(checkMode([...paths, other], '', ''), 'full');
});
import { fileURLToPath } from 'node:url';
import {
  affectsPart,
  releaseArtifactRetentionControls,
  isReleaseArtifactRetentionOnly,
  isRechargeOnly,
  matchingRun,
  canReuseMain,
  isCiOnly,
  isAdminOnly,
  isMailboxOnly,
  isTargetedOnly,
  selectedParts,
  onlineCiBuildControlPaths,
  needsOnlineRechargeCiBuild,
  checkMode,
  adminCheckCommands,
  adminUiGuardChecks,
  backendArchitectureGuardChecks,
  registrationOnboardingControls,
  hasRegistrationOnboardingScope,
  hasAppleMailboxScope,
  onlineRechargeRecoveryPolicy,
  productionDatabaseAccessHelper,
  productionDatabaseAccessTest,
  productionDatabaseAccessAcceptance,
  hasBankCardDeletePolicyProof,
  rechargeConnectionProfileMigration,
  unpublishedComponentSuccessorControlPaths,
  rechargeFlowSuccessorControlPaths,
  hasRechargeFlowBusinessReuseProof,
  ownedMysqlTestControlPaths,
  hasCombinedComponentScope,
  combinedMigrationBinding,
  validateCombinedMigrationNative,
  combinedMigrationScopeBytesUnchanged,
  canReuseCombinedAdminSource,
  combinedDispatcherBytesUnchanged,
  combinedQualityWorkflowBytesUnchanged,
  onlineComponentGuardBinding,
  onlineComponentGuardLogFacts,
  onlineComponentGuardCurrentEnvironment,
  onlineComponentGuardScopeBytesUnchanged,
  onlineComponentGuardDispatcherBytesUnchanged,
  validateOnlineComponentGuardNative,
  canResumeOnlineComponentGuard,
  onlinePrepareFixGuardBinding,
  onlinePrepareFixGuardPaths,
  onlinePrepareFixScopeBytesUnchanged,
  onlinePrepareFixDispatcherBytesUnchanged,
  onlinePrepareFixRuntimeBytesUnchanged,
  onlinePrepareFixGuardRawLogFacts,
  validateOnlinePrepareFixGuardNative,
  onlinePrepareFixGuardFailureCodes,
  requireOnlinePrepareFixGuardNative,
  canResumeOnlinePrepareFixGuard,
  onlinePreflightReceiptFixGuardBinding,
  onlinePreflightReceiptFixGuardPaths,
  onlinePreflightReceiptFixScopeBytesUnchanged,
  onlinePreflightReceiptFixDispatcherBytesUnchanged,
  onlinePreflightReceiptFixRuntimeBytesUnchanged,
  onlinePreflightReceiptFixGuardRawLogFacts,
  validateOnlinePreflightReceiptFixGuardNative,
  onlinePreflightReceiptFixGuardFailureCodes,
  requireOnlinePreflightReceiptFixGuardNative,
  canResumeOnlinePreflightReceiptFixGuard
} from './ci-recharge-scope.mjs';
import { matchesSourceEvidence } from './ci-recharge-evidence.mjs';

const schema =
  'model Other { id String }\nmodel IdBusinessV2RechargeBrowserSetting { ownerId String }\n';

function syntheticOnlineGuardNative() {
  const b = onlineComponentGuardBinding;
  const counts = [
    257, 40, 27, 91, 30, 16, 40, 63, 40, 35, 8, 25, 24, 109, 24, 86, 90, 23, 20, 25, 27, 297, 34,
    39, 15, 66, 32, 31
  ];
  // Synthetic metadata tests validate the finite contract. Only the runtime
  // GH reader can derive the frozen digest from the actual complete raw log.
  return {
    run: {
      id: b.run,
      run_attempt: b.attempt,
      conclusion: 'failure',
      event: 'pull_request',
      path: '.github/workflows/quality.yml',
      status: 'completed',
      head_sha: b.head,
      repository: { full_name: b.repository },
      pull_requests: [{ number: b.pullRequest, base: { sha: b.base }, head: { sha: b.head } }]
    },
    jobs: [
      {
        id: b.job,
        run_id: b.run,
        run_attempt: b.attempt,
        name: 'recharge (guards)',
        status: 'completed',
        conclusion: 'failure',
        steps: [
          ...['Checkout', 'Setup Node.js', 'Install package dependencies'].map((name) => ({
            name,
            status: 'completed',
            conclusion: 'success'
          })),
          ...[
            'Install browser for recharge acceptance',
            'Install existing connector dependencies'
          ].map((name) => ({ name, status: 'completed', conclusion: 'skipped' })),
          { name: 'Check affected recharge part', status: 'completed', conclusion: 'failure' }
        ]
      }
    ],
    checkout: {
      sha: b.checkout,
      tree: { sha: b.tree },
      parents: [{ sha: b.base }, { sha: b.head }]
    },
    headTree: b.tree,
    currentHead: b.head,
    changed: ['scripts/production-release/unified-component-source.test.py'],
    fixtureSha256: b.fixtureSha256,
    scopeUnchanged: true,
    dispatcherUnchanged: true,
    modesUnchanged: true,
    currentEnvironment: {
      node: 'v24.21.0',
      npm: '11.19.0',
      imageOS: 'ubuntu24',
      imageVersion: '20261004.327.1',
      platform: 'linux'
    },
    facts: {
      sha256: b.logSha256,
      checkout: b.checkout,
      scope: true,
      environment: true,
      failureCode: 1,
      python: [...counts.map((count) => [count, 'OK']), [12, 'FAILED (errors=1)']],
      node: [320, 202, 13, 5, 12, 5].flatMap((count) => [
        'ℹ tests ' + count,
        'ℹ fail 0',
        'ℹ cancelled 0',
        'ℹ skipped 0'
      ]),
      errors: [
        'ERROR: test_business_archive_tree_and_all_application_bytes_match_the_worktree_seal (__main__.JointSourceTests.test_business_archive_tree_and_all_application_bytes_match_the_worktree_seal)'
      ],
      failedCommands: [
        'Error: Command failed: python3 -B scripts/production-release/unified-component-source.test.py'
      ]
    }
  };
}

test('finite ONLINE guard continuation binds the original native failed job and rejects unknown evidence or inputs', () => {
  assert.equal(validateOnlineComponentGuardNative(syntheticOnlineGuardNative()), true);
  for (const mutate of [
    (v) => {
      delete v.run;
    },
    (v) => {
      delete v.jobs;
    },
    (v) => {
      delete v.checkout;
    },
    (v) => {
      delete v.facts;
    },
    (v) => {
      delete v.currentEnvironment;
    },
    (v) => {
      delete v.currentHead;
    },
    (v) => {
      v.currentHead = 'not-a-source-commit';
    },
    (v) => {
      v.currentHead = 'a'.repeat(40);
    },
    ...['node', 'npm', 'imageOS', 'imageVersion', 'platform'].flatMap((field) => [
      (v) => {
        v.currentEnvironment[field] += '-changed';
      },
      (v) => {
        delete v.currentEnvironment[field];
      }
    ]),
    (v) => {
      v.run.id++;
    },
    (v) => {
      v.run.run_attempt++;
    },
    (v) => {
      v.run.repository.full_name = 'foreign/repo';
    },
    (v) => {
      v.run.head_sha = 'a'.repeat(40);
    },
    (v) => {
      v.run.path = '.github/workflows/other.yml';
    },
    (v) => {
      v.run.pull_requests[0].number++;
    },
    (v) => {
      v.run.pull_requests[0].base.sha = 'a'.repeat(40);
    },
    (v) => {
      v.run.pull_requests[0].head.sha = 'a'.repeat(40);
    },
    (v) => {
      v.headTree = 'a'.repeat(40);
    },
    (v) => {
      v.checkout.sha = 'a'.repeat(40);
    },
    (v) => {
      v.checkout.tree.sha = 'a'.repeat(40);
    },
    (v) => {
      v.checkout.parents.reverse();
    },
    (v) => {
      v.jobs[0].id++;
    },
    (v) => {
      v.jobs[0].run_id++;
    },
    (v) => {
      v.jobs[0].run_attempt++;
    },
    (v) => {
      v.jobs[0].conclusion = 'success';
    },
    (v) => {
      v.jobs[0].steps[0].conclusion = 'failure';
    },
    (v) => {
      v.jobs.push(v.jobs[0]);
    },
    (v) => {
      v.changed.push('apps/api/src/main.ts');
    },
    (v) => {
      v.changed.push('package-lock.json');
    },
    (v) => {
      v.changed.push('.github/workflows/quality.yml');
    },
    (v) => {
      v.changed.push('scripts/production-release/online-recharge-component-runtime.py');
    },
    (v) => {
      v.fixtureSha256 = '0'.repeat(64);
    },
    (v) => {
      v.scopeUnchanged = false;
    },
    (v) => {
      v.dispatcherUnchanged = false;
    },
    (v) => {
      v.modesUnchanged = false;
    },
    (v) => {
      v.facts.sha256 = '0'.repeat(64);
    },
    (v) => {
      v.facts.checkout = 'a'.repeat(40);
    },
    (v) => {
      v.facts.errors[0] = 'ERROR: another failing suite';
    },
    (v) => {
      v.facts.failureCode++;
    },
    (v) => {
      v.facts.python[0][1] = 'OK (skipped=1)';
    },
    (v) => {
      v.facts.python.pop();
    },
    (v) => {
      v.facts.node[1] = 'ℹ fail 1';
    },
    (v) => {
      v.facts.scope = false;
    },
    (v) => {
      v.facts.environment = false;
    },
    (v) => {
      v.facts.failedCommands[0] += ' --different';
    }
  ]) {
    const input = syntheticOnlineGuardNative();
    mutate(input);
    assert.equal(validateOnlineComponentGuardNative(input), false, mutate.toString());
  }
  assert.equal(canResumeOnlineComponentGuard('a'.repeat(40)), false);
});

test('finite ONLINE guard continuation binds the dynamic PR head while retaining immutable original run checkout tree and log', () => {
  const input = syntheticOnlineGuardNative();
  input.currentHead = 'f'.repeat(40);
  input.run.pull_requests[0].head.sha = input.currentHead;
  assert.equal(input.run.head_sha, onlineComponentGuardBinding.head);
  assert.equal(validateOnlineComponentGuardNative(input), true);
  for (const mutate of [
    (v) => {
      v.run.pull_requests[0].head.sha = onlineComponentGuardBinding.head;
    },
    (v) => {
      v.currentHead = onlineComponentGuardBinding.head;
    },
    (v) => {
      v.run.head_sha = v.currentHead;
    },
    (v) => {
      v.checkout.parents[1].sha = v.currentHead;
    },
    (v) => {
      v.headTree = 'f'.repeat(40);
    },
    (v) => {
      delete v.currentHead;
    }
  ]) {
    const changed = structuredClone(input);
    mutate(changed);
    assert.equal(validateOnlineComponentGuardNative(changed), false, mutate.toString());
  }
});

test('finite ONLINE guard environment collector reads current runtime without claiming local Ubuntu identity', () => {
  const current = onlineComponentGuardCurrentEnvironment();
  assert.deepEqual(current, {
    node: process.version,
    npm: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(),
    imageOS: process.env.ImageOS,
    imageVersion: process.env.ImageVersion,
    platform: process.platform
  });
});

test('finite ONLINE guard log facts hash the complete original bytes and keep each failure identity', () => {
  const raw =
    'job\tstep\t2026-10-14T01:00:00Z [command]/usr/bin/git log -1 --format=%H\n' +
    'job\tstep\t2026-10-14T01:00:00Z ' +
    onlineComponentGuardBinding.checkout +
    '\n' +
    'job\tstep\t2026-10-14T01:00:00Z Ran 12 tests in 1.0s\n\nFAILED (errors=1)\n' +
    'ERROR: synthetic failing test\nError: Command failed: python3 -B synthetic.py\n';
  const facts = onlineComponentGuardLogFacts(raw);
  assert.equal(facts.sha256, createHash('sha256').update(raw).digest('hex'));
  assert.equal(facts.checkout, onlineComponentGuardBinding.checkout);
  assert.deepEqual(facts.python, [[12, 'FAILED (errors=1)']]);
  assert.deepEqual(facts.errors, ['ERROR: synthetic failing test']);
  assert.notEqual(onlineComponentGuardLogFacts(raw + '\n').sha256, facts.sha256);
  assert.equal(onlineComponentGuardLogFacts(''), undefined);
  assert.equal(onlineComponentGuardLogFacts(undefined), undefined);
});

test('finite ONLINE guard wiring restores every original command byte and keeps the old combined contract unchanged', () => {
  const b = onlineComponentGuardBinding;
  for (const [path, validate] of [
    ['scripts/ci-recharge-scope.mjs', onlineComponentGuardScopeBytesUnchanged],
    ['scripts/ci-recharge-check.mjs', onlineComponentGuardDispatcherBytesUnchanged]
  ]) {
    const before = execFileSync('git', ['show', b.head + ':' + path], { encoding: 'utf8' });
    const after = execFileSync('git', ['show', onlinePrepareFixGuardBinding.base + ':' + path], {
      encoding: 'utf8'
    });
    assert.equal(validate(before, after), true, path);
    assert.equal(validate(before, readFileSync(path, 'utf8')), false, path);
    const dispatcher = path === 'scripts/ci-recharge-check.mjs';
    for (const changed of [
      ' ' + after,
      after + '\n',
      dispatcher
        ? after.replace('const npm =', 'const changedNpm =')
        : after.replace('const git =', 'const changedGit ='),
      dispatcher
        ? after.replace("run('python3',", "run('modified-python3',")
        : after.replace('export function matchingRun(', 'export function modifiedMatchingRun(')
    ])
      assert.equal(validate(before, changed), false, path);
    assert.equal(validate(before, before), false);
  }
});

test('disk retention scope changes invalidate frozen migration reuse without weakening its original gate', () => {
  const before = execFileSync(
    'git',
    ['show', combinedMigrationBinding.head + ':scripts/ci-recharge-scope.mjs'],
    { encoding: 'utf8' }
  );
  const after = readFileSync('scripts/ci-recharge-scope.mjs', 'utf8');
  const prior = execFileSync(
    'git',
    ['show', 'f193f34ea09a2c37485c1582a81b33ee3acec865:scripts/ci-recharge-scope.mjs'],
    { encoding: 'utf8' }
  );
  assert.equal(combinedMigrationScopeBytesUnchanged(before, prior), true);
  assert.equal(combinedMigrationScopeBytesUnchanged(before, after), false);
  for (const name of [
    'hasCombinedComponentScope',
    'hasRechargeConnectionMigrationScope',
    'hasRegistrationMirrorScope',
    'adminCheckCommands',
    'affectsPart'
  ])
    assert.equal(
      combinedMigrationScopeBytesUnchanged(before, prior.replace(name, name + 'Changed')),
      false
    );
});

function syntheticPrepareFixNative() {
  // Synthetic validator metadata only; it cannot grant operational authority.
  // The real reader hashes the original complete artifact/log bytes itself.
  const b = onlinePrepareFixGuardBinding;
  const passed = (name) => ({ name, status: 'completed', conclusion: 'success' });
  const run = {
    id: b.run,
    run_attempt: 1,
    event: 'pull_request',
    path: '.github/workflows/quality.yml',
    status: 'completed',
    conclusion: 'success',
    head_sha: b.originalHead,
    repository: { full_name: b.repository },
    pull_requests: []
  };
  return {
    run,
    jobs: [
      {
        id: b.job,
        run_id: b.run,
        run_attempt: 1,
        name: 'recharge (guards)',
        head_sha: b.originalHead,
        status: 'completed',
        conclusion: 'success',
        steps: [
          ...[
            'Checkout',
            'Setup Node.js',
            'Install package dependencies',
            'Check affected recharge part'
          ].map(passed),
          ...[
            'Install browser for recharge acceptance',
            'Install existing connector dependencies'
          ].map((name) => ({ name, status: 'completed', conclusion: 'skipped' }))
        ]
      },
      {
        id: b.qualityJob,
        run_id: b.run,
        run_attempt: 1,
        name: 'quality',
        head_sha: b.originalHead,
        status: 'completed',
        conclusion: 'success',
        steps: [
          'Checkout the tested source tree for its evidence',
          'Record successful PR source evidence',
          'Preserve successful source evidence'
        ].map(passed)
      }
    ],
    originalPr: {
      number: 470,
      state: 'closed',
      merged: true,
      head: { sha: b.originalHead },
      base: { sha: b.originalBase },
      merge_commit_sha: b.base
    },
    mainRun: { ...run, id: b.mainRun, event: 'push', head_sha: b.base },
    artifact: {
      id: b.artifact,
      name: 'quality-source-evidence-1',
      expired: false,
      size_in_bytes: 357,
      digest: 'sha256:' + b.artifactSha256,
      workflow_run: { id: b.run, head_sha: b.originalHead }
    },
    proof: {
      repository: b.repository,
      runId: b.run,
      runAttempt: 1,
      pullRequest: 470,
      headSha: b.originalHead,
      baseSha: b.originalBase,
      testedTree: b.tree
    },
    proofSha256: b.proofSha256,
    facts: {
      sha256: b.rawLogSha256,
      checkout: b.checkout,
      scope: true,
      environment: true,
      errors: [],
      failedCommands: []
    },
    qualityLog: { sha256: b.rawQualityLogSha256, checkout: b.checkout },
    currentEnvironment: {
      node: 'v24.21.0',
      npm: '11.19.0',
      imageOS: 'ubuntu24',
      imageVersion: '20261004.327.1',
      platform: 'linux'
    },
    baselineTree: b.tree,
    currentHeadTree: 'a'.repeat(40),
    currentTree: 'a'.repeat(40),
    changed: [...onlinePrepareFixGuardPaths],
    runtimeSha256: b.runtimeSha256,
    runtimeTestSha256: b.runtimeTestSha256,
    scopeUnchanged: true,
    dispatcherUnchanged: true,
    runtimeUnchanged: true,
    modesUnchanged: true
  };
}

test('finite prepare-fix guard binds authentic closed-PR source artifact logs jobs and exact repairs without mutable PR aliases', () => {
  const original = syntheticPrepareFixNative();
  assert.equal(validateOnlinePrepareFixGuardNative(original), true);
  for (const mutate of [
    (v) => {
      v.run.id++;
    },
    (v) => {
      v.run.run_attempt = 2;
    },
    (v) => {
      v.run.head_sha = v.currentHeadTree;
    },
    (v) => {
      v.run.conclusion = 'failure';
    },
    (v) => {
      v.run.event = 'push';
    },
    (v) => {
      v.run.path = '.github/workflows/production-release.yml';
    },
    (v) => {
      v.originalPr.merged = false;
    },
    (v) => {
      v.originalPr.head.sha = v.currentHeadTree;
    },
    (v) => {
      v.originalPr.merge_commit_sha = v.currentHeadTree;
    },
    (v) => {
      v.mainRun.conclusion = 'failure';
    },
    (v) => {
      v.jobs[0].conclusion = 'failure';
    },
    (v) => {
      v.jobs[0].steps[0].conclusion = 'skipped';
    },
    (v) => {
      v.jobs.push({ ...v.jobs[0] });
    },
    (v) => {
      v.jobs[1].steps.pop();
    },
    (v) => {
      v.artifact.expired = true;
    },
    (v) => {
      v.artifact.id++;
    },
    (v) => {
      v.artifact.digest = 'sha256:' + '0'.repeat(64);
    },
    (v) => {
      v.proof.baseSha = v.currentHeadTree;
    },
    (v) => {
      v.proof.testedTree = v.currentHeadTree;
    },
    (v) => {
      v.proof.extra = true;
    },
    (v) => {
      v.proofSha256 = '0'.repeat(64);
    },
    (v) => {
      v.facts.sha256 = '0'.repeat(64);
    },
    (v) => {
      v.facts.errors.push('ERROR: unknown');
    },
    (v) => {
      v.facts.environment = false;
    },
    (v) => {
      v.qualityLog.checkout = v.currentHeadTree;
    },
    (v) => {
      v.qualityLog.sha256 = '0'.repeat(64);
    },
    (v) => {
      v.currentHeadTree = 'b'.repeat(40);
    },
    (v) => {
      v.baselineTree = v.currentTree;
    },
    (v) => {
      v.changed.push('apps/api/src/main.ts');
    },
    (v) => {
      v.changed.shift();
    },
    (v) => {
      v.currentEnvironment.imageVersion = 'changed';
    },
    (v) => {
      v.currentEnvironment.platform = 'darwin';
    },
    (v) => {
      v.currentEnvironment.node = 'v24.19.0';
    },
    (v) => {
      v.runtimeSha256 = '0'.repeat(64);
    },
    (v) => {
      v.runtimeTestSha256 = '0'.repeat(64);
    },
    (v) => {
      v.scopeUnchanged = false;
    },
    (v) => {
      v.dispatcherUnchanged = false;
    },
    (v) => {
      v.runtimeUnchanged = false;
    },
    (v) => {
      v.modesUnchanged = false;
    }
  ]) {
    const changed = structuredClone(original);
    mutate(changed);
    assert.equal(validateOnlinePrepareFixGuardNative(changed), false, mutate.toString());
  }
});

test('finite prepare-fix diagnostics distinguish native logs source and environment while the same gate still rejects', () => {
  const original = syntheticPrepareFixNative();
  assert.deepEqual(onlinePrepareFixGuardFailureCodes(original), []);
  assert.equal(requireOnlinePrepareFixGuardNative(original), true);
  const cases = [
    [
      'ORIGINAL_RUN',
      (v) => {
        v.run.conclusion = 'failure';
      }
    ],
    [
      'CLOSED_PR_SOURCE',
      (v) => {
        v.originalPr.merged = false;
      }
    ],
    [
      'MAIN_QUALITY',
      (v) => {
        v.mainRun.conclusion = 'failure';
      }
    ],
    [
      'GUARD_JOB',
      (v) => {
        v.jobs[0].head_sha = 'b'.repeat(40);
      }
    ],
    [
      'GUARD_STEPS',
      (v) => {
        v.jobs[0].steps[0].conclusion = 'failure';
      }
    ],
    [
      'GUARD_SKIPPED_DEPENDENCIES',
      (v) => {
        v.jobs[0].steps.pop();
      }
    ],
    [
      'QUALITY_JOB',
      (v) => {
        v.jobs[1].conclusion = 'failure';
      }
    ],
    [
      'QUALITY_STEPS',
      (v) => {
        v.jobs[1].steps.pop();
      }
    ],
    [
      'SOURCE_ARTIFACT',
      (v) => {
        v.artifact.expired = true;
      }
    ],
    [
      'PROOF_BYTES',
      (v) => {
        v.proofSha256 = '0'.repeat(64);
      }
    ],
    [
      'PROOF_SOURCE',
      (v) => {
        v.proof.extra = 'synthetic-private';
      }
    ],
    [
      'GUARD_LOG_BYTES',
      (v) => {
        v.facts.sha256 = '0'.repeat(64);
      }
    ],
    [
      'GUARD_LOG_CHECKOUT',
      (v) => {
        v.facts.checkout = '0'.repeat(40);
      }
    ],
    [
      'GUARD_LOG_SCOPE',
      (v) => {
        v.facts.scope = false;
      }
    ],
    [
      'GUARD_LOG_ENVIRONMENT',
      (v) => {
        v.facts.environment = false;
      }
    ],
    [
      'GUARD_LOG_ERRORS',
      (v) => {
        v.facts.errors.push('synthetic-private');
      }
    ],
    [
      'QUALITY_LOG_BYTES',
      (v) => {
        v.qualityLog.sha256 = '0'.repeat(64);
      }
    ],
    [
      'QUALITY_LOG_CHECKOUT',
      (v) => {
        v.qualityLog.checkout = '0'.repeat(40);
      }
    ],
    [
      'BASELINE_TREE',
      (v) => {
        v.baselineTree = '0'.repeat(40);
      }
    ],
    [
      'CURRENT_TREE',
      (v) => {
        v.currentHeadTree = '0'.repeat(40);
      }
    ],
    [
      'CHANGED_PATHS',
      (v) => {
        v.changed.push('synthetic-private');
      }
    ],
    ...[
      ['node', 'ENV_NODE'],
      ['npm', 'ENV_NPM'],
      ['imageOS', 'ENV_IMAGE_OS'],
      ['imageVersion', 'ENV_IMAGE_VERSION'],
      ['platform', 'ENV_PLATFORM']
    ].map(([key, code]) => [
      code,
      (v) => {
        v.currentEnvironment[key] = 'synthetic-private';
      }
    ]),
    [
      'RUNTIME_SOURCE',
      (v) => {
        v.runtimeSha256 = '0'.repeat(64);
      }
    ],
    [
      'RUNTIME_TEST_SOURCE',
      (v) => {
        v.runtimeTestSha256 = '0'.repeat(64);
      }
    ],
    [
      'SCOPE_NORMALIZATION',
      (v) => {
        v.scopeUnchanged = false;
      }
    ],
    [
      'DISPATCHER_NORMALIZATION',
      (v) => {
        v.dispatcherUnchanged = false;
      }
    ],
    [
      'RUNTIME_NORMALIZATION',
      (v) => {
        v.runtimeUnchanged = false;
      }
    ],
    [
      'FILE_MODES',
      (v) => {
        v.modesUnchanged = false;
      }
    ]
  ];
  for (const [code, mutate] of cases) {
    const value = structuredClone(original);
    mutate(value);
    assert.equal(validateOnlinePrepareFixGuardNative(value), false, code);
    assert.ok(onlinePrepareFixGuardFailureCodes(value).includes(code), code);
    assert.throws(
      () => requireOnlinePrepareFixGuardNative(value),
      (error) => {
        assert.match(
          error.message,
          /^Original prepare-fix source or guard evidence changed; predicates=[A-Z_,]+$/
        );
        assert.ok(error.message.includes(code), code);
        assert.equal(error.message.includes('synthetic-private'), false);
        return true;
      }
    );
  }
});

test('finite prepare-fix diagnostics never print secrets unknown fields or raw records and retain every non-log predicate byte', () => {
  const value = syntheticPrepareFixNative();
  for (const object of [value, value.run, value.jobs[0], value.artifact, value.currentEnvironment])
    object.syntheticUnknownSecret = 'synthetic-secret-do-not-print';
  assert.deepEqual(onlinePrepareFixGuardFailureCodes(value), []);
  assert.equal(requireOnlinePrepareFixGuardNative(value), true);
  value.facts.failedCommands.push('synthetic-secret-do-not-print');
  value.currentEnvironment.imageOS = 'synthetic-secret-do-not-print';
  assert.throws(
    () => requireOnlinePrepareFixGuardNative(value),
    (error) => {
      assert.equal(
        error.message,
        'Original prepare-fix source or guard evidence changed; predicates=GUARD_LOG_ERRORS,ENV_IMAGE_OS'
      );
      for (const excluded of [
        'syntheticUnknownSecret',
        'synthetic-secret-do-not-print',
        'failedCommands',
        'currentEnvironment'
      ])
        assert.equal(error.message.includes(excluded), false);
      return true;
    }
  );
  const path = 'scripts/ci-recharge-scope.mjs';
  const prior = execFileSync('git', ['show', '327bfbc03bd414ae8328f7f2a875bcc4dcd8998d:' + path], {
    cwd: root,
    encoding: 'utf8'
  });
  const validator = (source) =>
    source.slice(
      source.indexOf('export function validateOnlinePrepareFixGuardNative('),
      source.indexOf('function typeOfProof(')
    );
  const current = validator(
    readFileSync(fileURLToPath(new URL('./ci-recharge-scope.mjs', import.meta.url)), 'utf8')
  );
  assert.equal(current.split('b.rawLogSha256').length, 2);
  assert.equal(current.split('b.rawQualityLogSha256').length, 2);
  assert.equal(
    current
      .replace('b.rawLogSha256', 'b.logSha256')
      .replace('b.rawQualityLogSha256', 'b.qualityLogSha256'),
    validator(prior)
  );
});

test('finite prepare-fix raw log parsing uses exact platform bytes and rejects invalid UTF8 and CLI decorations', () => {
  const b = onlinePrepareFixGuardBinding;
  const text =
    [
      '[command]/usr/bin/git log -1 --format=%H',
      b.checkout,
      '  CHECK_BASE: ' + b.originalBase,
      '  CHECK_MODE: ci-only',
      '  CHECK_PART: guards',
      '##[group]Run node scripts/ci-recharge-check.mjs "$CHECK_PART" "$CHECK_BASE"',
      '  NODE_ENV: test',
      'Image: ubuntu-24.04',
      'Version: 20261004.327.1',
      'node: v24.21.0',
      'npm: 11.19.0',
      '\x1b[36;1msynthetic command\x1b[0m'
    ]
      .map((line, i) => (i === 0 ? '\uFEFF' : '') + '2026-10-14T00:00:00.1234567Z ' + line)
      .join('\n') + '\n';
  const raw = Buffer.from(text, 'utf8');
  const parsed = onlinePrepareFixGuardRawLogFacts(raw);
  assert.equal(parsed.sha256, createHash('sha256').update(raw).digest('hex'));
  assert.equal(parsed.checkout, b.checkout);
  assert.equal(parsed.scope, true);
  assert.equal(parsed.environment, true);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.failedCommands, []);
  const rendered = Buffer.from(text.replaceAll(String.fromCharCode(27), '^['), 'utf8');
  assert.notEqual(onlinePrepareFixGuardRawLogFacts(rendered).sha256, parsed.sha256);
  assert.equal(
    validateOnlinePrepareFixGuardNative({ ...syntheticPrepareFixNative(), facts: parsed }),
    false
  );
  for (const invalid of [
    undefined,
    '',
    Buffer.alloc(0),
    Buffer.from([0xff]),
    Buffer.from('job\tstep\t' + text),
    Buffer.from(text + 'unframed-tail'),
    Buffer.from(text.replace('2026-10-14T00:00:00.1234567Z ', '2026-10-14T00:00:00+08:00 '))
  ])
    assert.equal(onlinePrepareFixGuardRawLogFacts(invalid), undefined);
});

test('finite prepare-fix authenticates one raw hash per job and never accepts historical CLI hashes', () => {
  const b = onlinePrepareFixGuardBinding;
  assert.equal(b.rawLogSha256, '914d13bef30182deaaf574104f26cb51b17cd29c67dacc5e0529cfa98628e6db');
  assert.equal(
    b.rawQualityLogSha256,
    '760539f4479f0a9d4f32cd86da2bab6c5a273cbdfe315cde2cd98b04fb41e028'
  );
  assert.equal(b.logSha256, 'e7151e901b9bdbb473f735ea808cbebcf39f91ba65e05314e54906b615169c9c');
  assert.equal(
    b.qualityLogSha256,
    '8437e426a8deb05fb482d0074e51d3aa4ebb6283f9c8125b116284464a35f4f5'
  );
  const value = syntheticPrepareFixNative();
  assert.equal(requireOnlinePrepareFixGuardNative(value), true);
  value.facts.sha256 = b.logSha256;
  value.qualityLog.sha256 = b.qualityLogSha256;
  assert.equal(validateOnlinePrepareFixGuardNative(value), false);
  assert.deepEqual(onlinePrepareFixGuardFailureCodes(value), [
    'GUARD_LOG_BYTES',
    'QUALITY_LOG_BYTES'
  ]);
  assert.throws(
    () => requireOnlinePrepareFixGuardNative(value),
    /predicates=GUARD_LOG_BYTES,QUALITY_LOG_BYTES$/
  );
  const source = readFileSync(
    fileURLToPath(new URL('./ci-recharge-scope.mjs', import.meta.url)),
    'utf8'
  );
  const start = source.indexOf('export function canResumeOnlinePrepareFixGuard(');
  const reader = source.slice(
    start,
    source.indexOf('// END finite ONLINE prepare-fix guard continuation', start)
  );
  assert.ok(
    reader
      .replace(/\s/g, '')
      .includes(
        "['api', '--allow-escape-sequences', 'repos/' + b.repository + '/actions/jobs/' + job + '/logs']".replace(
          /\s/g,
          ''
        )
      )
  );
  assert.equal(reader.includes("['run', 'view'"), false);
});

test('historical finite prepare-fix guard restores its frozen source bytes and rejects subsequent hardening', () => {
  const b = onlinePrepareFixGuardBinding;
  for (const [path, verify] of [
    ['scripts/ci-recharge-scope.mjs', onlinePrepareFixScopeBytesUnchanged],
    ['scripts/ci-recharge-check.mjs', onlinePrepareFixDispatcherBytesUnchanged],
    [
      'scripts/production-release/online-recharge-component-runtime.py',
      onlinePrepareFixRuntimeBytesUnchanged
    ]
  ]) {
    const before = execFileSync('git', ['show', b.base + ':' + path], { encoding: 'utf8' });
    // Validate the frozen preparation fix, not a later dispatcher revision.
    const after = execFileSync(
      'git',
      ['show', 'a9829b443fe5c0cf6f4803366d06c5f8e3357318:' + path],
      { encoding: 'utf8' }
    );
    assert.equal(verify(before, after), true, path);
    const current = readFileSync(path, 'utf8');
    if (current !== after) assert.equal(verify(before, current), false, path);
    for (const altered of [
      ' ' + after,
      after + '\n',
      after.replace('const git =', 'const modifiedGit ='),
      after.replace('def authority(', 'def modified_authority(')
    ]) {
      if (altered !== after) assert.equal(verify(before, altered), false, path);
    }
    assert.equal(verify(before, before), false);
  }
  assert.equal(canResumeOnlinePrepareFixGuard('0'.repeat(40)), false);
});

test('historical combined Quality workflow permits only its frozen guards token insertion and rejects new build steps', () => {
  const current = execFileSync(
    'git',
    ['show', 'a9829b443fe5c0cf6f4803366d06c5f8e3357318:.github/workflows/quality.yml'],
    { encoding: 'utf8' }
  );
  for (const commit of [
    combinedMigrationBinding.head,
    '5930f71e00d178a867526766e16e9aee14077244'
  ]) {
    const before = execFileSync('git', ['show', commit + ':.github/workflows/quality.yml'], {
      encoding: 'utf8'
    });
    assert.equal(combinedQualityWorkflowBytesUnchanged(before, current), true);
    assert.equal(
      combinedQualityWorkflowBytesUnchanged(
        before,
        readFileSync('.github/workflows/quality.yml', 'utf8')
      ),
      false
    );
    for (const changed of [
      before,
      current.replace("matrix.part == 'guards' && github.token || ''", 'github.token'),
      current.replace("matrix.part == 'guards'", "matrix.part == 'admin'"),
      current.replace('  contents: read', '  contents: write'),
      current.replace('  actions: read', '  actions: write'),
      current.replace('          CHECK_PART:', '          OTHER_ENV:'),
      current.replace(
        '        run: node scripts/ci-recharge-check.mjs',
        '        run: node arbitrary.mjs'
      ),
      current.replace('          GH_TOKEN:', '          UNRELATED: true\n          GH_TOKEN:'),
      current + '\n',
      current.replace('          GH_TOKEN:', '          GH_TOKEN: fixture\n          GH_TOKEN:')
    ])
      assert.equal(combinedQualityWorkflowBytesUnchanged(before, changed), false);
  }
});

test('the completed Admin job is reusable only with native success and control-only changes', () => {
  const run = {
    id: 38414414141,
    run_attempt: 1,
    conclusion: 'failure',
    event: 'pull_request',
    path: '.github/workflows/quality.yml',
    status: 'completed',
    head_sha: '5930f71e00d178a867526766e16e9aee14077244',
    pull_requests: [{ number: 463, base: { sha: combinedMigrationBinding.base } }]
  };
  const jobs = [
    {
      id: 115355004562,
      run_id: run.id,
      name: 'recharge (admin)',
      status: 'completed',
      conclusion: 'success',
      steps: ['Checkout', 'Check affected recharge part'].map((name) => ({
        name,
        status: 'completed',
        conclusion: 'success'
      }))
    }
  ];
  const checkout = {
    sha: 'd7a17bbd2626a9adc77ba732ed934d302f78a0d2',
    tree: { sha: '3594058955012e7ad7087cbb340a0f30420c92f2' },
    parents: [combinedMigrationBinding.base, run.head_sha].map((sha) => ({ sha }))
  };
  const log =
    checkout.sha +
    '\nTest Files 159 passed (159)\nTests 1235 passed (1235)\n工作区浏览器验收通过：86 项';
  const validate = (r = run, j = jobs, c = [], x = checkout, l = log, workflowProof = false) =>
    canReuseCombinedAdminSource(r, j, c, x, l, workflowProof);
  assert.equal(validate(run, jobs, ['scripts/ci-recharge-scope.mjs']), true);
  for (const path of [
    'apps/admin/src/v2/styles/base.css',
    'scripts/acceptance-v2-workspace-dock.mjs',
    'package-lock.json',
    '.github/workflows/quality.yml'
  ])
    assert.equal(validate(run, jobs, [path]), false);
  assert.equal(validate(run, jobs, ['.github/workflows/quality.yml'], checkout, log, true), true);
  assert.equal(
    validate(run, jobs, ['.github/workflows/quality.yml'], checkout, log, 'true'),
    false
  );
  assert.equal(validate(run, jobs, ['.github/workflows/other.yml'], checkout, log, true), false);
  assert.equal(validate({ ...run, status: 'in_progress' }), false);
  assert.equal(validate({ ...run, run_attempt: 2 }), false);
  assert.equal(validate({ ...run, head_sha: 'a'.repeat(40) }), false);
  assert.equal(validate(run, []), false);
  assert.equal(validate(run, jobs, [], checkout, log.replace('1235 passed', '1234 passed')), false);
  assert.equal(
    validate(run, jobs, [], checkout, log.replace('Test Files', '^[[2mTest Files^[[22m')),
    true
  );
  assert.equal(
    validate(
      run,
      jobs,
      [],
      checkout,
      log.replace(
        'Test Files',
        String.fromCharCode(27) + '[2mTest Files' + String.fromCharCode(27) + '[22m'
      )
    ),
    true
  );
  assert.equal(validate(run, jobs, [], { ...checkout, tree: { sha: 'a'.repeat(40) } }), false);
});

test('changed guard controls require new evidence while frozen continuation remains exact', () => {
  const before = execFileSync(
    'git',
    ['show', combinedMigrationBinding.head + ':scripts/ci-recharge-check.mjs'],
    { encoding: 'utf8' }
  );
  const after = readFileSync('scripts/ci-recharge-check.mjs', 'utf8');
  const prior = execFileSync(
    'git',
    ['show', 'f193f34ea09a2c37485c1582a81b33ee3acec865:scripts/ci-recharge-check.mjs'],
    { encoding: 'utf8' }
  );
  assert.equal(combinedDispatcherBytesUnchanged(before, prior), true);
  assert.equal(combinedDispatcherBytesUnchanged(before, after), false);
  for (const name of [
    'shared',
    'onlineEngine',
    'unpublishedComponentSuccessorControls',
    'hasCombinedComponentScope'
  ])
    assert.equal(
      combinedDispatcherBytesUnchanged(before, prior.replace(name, name + 'Changed')),
      false
    );
});

test('finite combined migration reuse requires native source and all 25 actual assertions', () => {
  const b = combinedMigrationBinding;
  const report = {
    numTotalTestSuites: 6,
    success: true,
    numTotalTests: 25,
    numPassedTests: 25,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    testResults: [
      ['recharge-callback-receipts.mysql.integration.spec.ts', 4],
      ['recharge-employee-concurrency.mysql.integration.spec.ts', 16],
      ['recharge-subscription-cycle.mysql.integration.spec.ts', 5]
    ].map(([file, count]) => ({
      name: '/fixture/apps/api/src/id-business-v2/auto-recharge/' + file,
      status: 'passed',
      assertionResults: Array.from({ length: count }, () => ({ status: 'passed' }))
    }))
  };
  const fixture = () => ({
    run: {
      id: b.runId,
      run_attempt: 1,
      event: 'pull_request',
      path: '.github/workflows/quality.yml',
      status: 'completed',
      head_sha: b.head,
      pull_requests: [{ number: 463, base: { sha: b.base } }]
    },
    jobs: [
      {
        id: b.jobId,
        run_id: b.runId,
        name: 'recharge (migration)',
        status: 'completed',
        conclusion: 'success',
        steps: ['Checkout', 'Check affected recharge part'].map((name) => ({
          name,
          status: 'completed',
          conclusion: 'success'
        }))
      }
    ],
    checkout: {
      sha: b.checkout,
      tree: { sha: b.tree },
      parents: [b.base, b.head].map((sha) => ({ sha }))
    },
    log:
      'Checkout\tgit log -1 --format=%H\nCheckout\t' + b.checkout + '\n' + JSON.stringify(report),
    changed: ['scripts/acceptance-v2-workspace-dock.mjs', 'scripts/ci-recharge-release.test.mjs']
  });
  assert.equal(validateCombinedMigrationNative(fixture()).testsPassed, 25);
  const tokenRepair = fixture();
  tokenRepair.changed.push('.github/workflows/quality.yml');
  assert.equal(validateCombinedMigrationNative(tokenRepair), undefined);
  tokenRepair.qualityWorkflowUnchanged = 'true';
  assert.equal(validateCombinedMigrationNative(tokenRepair), undefined);
  tokenRepair.qualityWorkflowUnchanged = true;
  assert.equal(validateCombinedMigrationNative(tokenRepair).testsPassed, 25);
  for (const path of [
    'apps/api/src/id-business-v2/auto-recharge/recharge.service.ts',
    'apps/api/prisma-mysql/schema.prisma',
    'packages/shared/src/v2/auto-recharge.ts',
    'package-lock.json',
    '.github/workflows/quality.yml',
    'scripts/ci-recharge-check.mjs',
    'scripts/acceptance-v2-recharge-employee-concurrency.mjs',
    'scripts/lib/owned-mysql-test-instance.mjs',
    'unknown.txt'
  ]) {
    const input = fixture();
    input.changed.push(path);
    assert.equal(validateCombinedMigrationNative(input), undefined, path);
  }
  for (const change of [
    (v) => {
      v.run.run_attempt = 2;
    },
    (v) => {
      v.run.head_sha = 'a'.repeat(40);
    },
    (v) => {
      v.run.pull_requests[0].number = 464;
    },
    (v) => {
      v.run.pull_requests[0].base.sha = 'b'.repeat(40);
    },
    (v) => {
      v.checkout.tree.sha = 'c'.repeat(40);
    },
    (v) => {
      v.checkout.parents.reverse();
    },
    (v) => {
      v.jobs[0].id++;
    },
    (v) => {
      v.jobs[0].conclusion = 'failure';
    },
    (v) => {
      v.jobs[0].steps[1].conclusion = 'skipped';
    },
    (v) => {
      v.log = '';
    },
    (v) => {
      v.log += '\n' + JSON.stringify(report);
    },
    (v) => {
      v.log = v.log.replace(b.checkout, 'd'.repeat(40));
    },
    (v) => {
      v.log = v.log.replace('"numPendingTests":0', '"numPendingTests":1');
    },
    (v) => {
      v.log = v.log.replace('"numTodoTests":0', '"numTodoTests":1');
    },
    (v) => {
      v.log = v.log.replace('"status":"passed"', '"status":"skipped"');
    },
    (v) => {
      v.log = v.log.replace(
        'recharge-subscription-cycle.mysql.integration.spec.ts',
        'recharge-employee-concurrency.mysql.integration.spec.ts'
      );
    }
  ]) {
    const input = fixture();
    change(input);
    assert.equal(validateCombinedMigrationNative(input), undefined);
  }
});

test('combined component acceptance remains finite and ordinary Admin edits do not acquire database checks', () => {
  const paths = [
    'apps/admin/src/v2/components/workspace/V2WorkspaceDock.vue',
    'scripts/production-release/unpublished-component-successor.py',
    'scripts/acceptance-v2-workspace-dock.mjs',
    'scripts/acceptance-v2-recharge-employee-concurrency.mjs',
    'scripts/acceptance-v2-recharge-employee-concurrency.test.mjs'
  ];
  assert.equal(hasCombinedComponentScope(paths), true);
  assert.equal(checkMode(paths, schema, schema), 'admin');
  assert.equal(checkMode([...paths, 'apps/api/src/auth/unknown.ts'], schema, schema), 'full');
  assert.equal(
    hasCombinedComponentScope(['apps/admin/src/v2/components/workspace/V2WorkspaceDock.vue']),
    false
  );
  assert.equal(
    hasCombinedComponentScope(paths.filter((path) => !path.endsWith('successor.py'))),
    false
  );
});
const connectionProfileModel = `model IdBusinessV2RechargeConnectionProfile {
  id            String   @id @db.Char(36)
  ownerId       String   @map("owner_id") @db.VarChar(191)
  name          String   @db.VarChar(80)
  configuration Json
  createdAt     DateTime @default(now()) @map("created_at")
  updatedAt     DateTime @updatedAt @map("updated_at")

  @@unique([ownerId, name])
  @@index([ownerId, createdAt], map: "id_business_v2_recharge_connection_profiles_owner_id_created_idx")
  @@map("id_business_v2_recharge_connection_profiles")
}`;
const connectionProfileSchema = connectionProfileModel + '\n\n' + schema;
const root = fileURLToPath(new URL('../', import.meta.url));
const grantHelperBefore = execFileSync(
  'git',
  ['show', 'ca36c52ab5df39a8eb1da7f1d763f6714399965a:' + productionDatabaseAccessHelper],
  { cwd: root, encoding: 'utf8' }
);
const grantAnchor = "  'ip_whitelists',\n";
const grantAdditions =
  "  'online_recharge_bills',\n  'online_recharge_cards',\n  'online_recharge_proxies',\n";
const grantHelperAfter = grantHelperBefore.replace(grantAnchor, grantAnchor + grantAdditions);
const grantProof = { before: grantHelperBefore, after: grantHelperAfter };
const bankAnchor = 'export const V2_RUNTIME_DELETE_TABLES = Object.freeze([\n';
const bankHelperAfter = grantHelperAfter.replace(
  bankAnchor,
  bankAnchor + "  'id_business_v2_bank_recharge_cards',\n"
);
const bankAcceptanceBefore = execFileSync(
  'git',
  ['show', '31d2c6885a45817cd40d23fce8d6145bc9f18af2:' + productionDatabaseAccessAcceptance],
  { cwd: root, encoding: 'utf8' }
);
// Reconstruct the sealed fixture from its ancestor; do not depend on an open PR
// object or mutable HEAD after this finite exception has been used.
const bankAcceptanceAfter = bankAcceptanceBefore
  .replace(
    '  `;\n  const result = spawnSync(',
    [
      '    CREATE TABLE \\`id_business_v2_bank_recharge_cards\\` (id INT PRIMARY KEY);',
      '    CREATE TABLE \\`id_business_v2_bank_recharge_orders\\` (id INT PRIMARY KEY);',
      '    CREATE TABLE \\`id_business_v2_recharge_jobs\\` (id INT PRIMARY KEY);',
      '  `;\n  const result = spawnSync('
    ].join('\n')
  )
  .replace(
    "    await client.$executeRawUnsafe('DELETE FROM `ip_whitelists` WHERE `id` = 1');\n",
    [
      "    await client.$executeRawUnsafe('DELETE FROM `ip_whitelists` WHERE `id` = 1');",
      '    await client.$executeRawUnsafe(',
      "      'INSERT INTO `id_business_v2_bank_recharge_cards` (`id`) VALUES (1)'",
      '    );',
      '    assert.equal(',
      '      await client.$executeRawUnsafe(',
      "        'DELETE FROM `id_business_v2_bank_recharge_cards` WHERE `id` = 1'",
      '      ),',
      '      1',
      '    );',
      "    for (const table of ['id_business_v2_bank_recharge_orders', 'id_business_v2_recharge_jobs']) {",
      '      await client.$executeRawUnsafe(`INSERT INTO \\`${table}\\` (\\`id\\`) VALUES (1)`);',
      '      await assert.rejects(',
      '        client.$executeRawUnsafe(`DELETE FROM \\`${table}\\` WHERE \\`id\\` = 1`),',
      '        /denied|command denied/i',
      '      );',
      '      assert.deepEqual(await client.$queryRawUnsafe(`SELECT \\`id\\` FROM \\`${table}\\``), [',
      '        { id: 1 }',
      '      ]);',
      '    }\n'
    ].join('\n')
  );
const bankProof = {
  before: grantHelperAfter,
  after: bankHelperAfter,
  beforeMode: '100644',
  afterMode: '100644',
  acceptance: {
    before: bankAcceptanceBefore,
    after: bankAcceptanceAfter,
    beforeMode: '100644',
    afterMode: '100644'
  }
};
const bankPolicyPaths = [productionDatabaseAccessHelper, productionDatabaseAccessAcceptance];

function recordScopeClassification(paths, snapshot, eventName = 'pull_request', options = {}) {
  // Exercise the real CLI with synthetic Git snapshots and successful same-tree PR evidence.
  // No remote API, artifact download, file write or business command is executed.
  const script = `
    import childProcess from 'node:child_process';
    import fs from 'node:fs';
    import { createHash } from 'node:crypto';
    import { syncBuiltinESMExports } from 'node:module';
    const { paths, snapshot, options, schema: fixtureSchema, registrationSourceFixtures } = JSON.parse(fs.readFileSync(process.env.SCOPE_TEST_FIXTURE_FILE, 'utf8'));
    const fixtureSources = new Map(Object.entries(registrationSourceFixtures).flatMap(([path, source]) =>
      [path, new URL('./' + path, import.meta.url).href, new URL('./' + path, import.meta.url).pathname]
        .map(name => [name, source])));
    const gitCalls = [];
    const apiCalls = [];
    const writes = [];
    const tree = 'd'.repeat(40);
    const pr = { number: 372, merged_at: '2026-10-09T00:00:00Z',
      merge_commit_sha: process.env.GITHUB_SHA, base: { ref: 'main' },
      head: { sha: 'b'.repeat(40), repo: { full_name: process.env.GITHUB_REPOSITORY } } };
    const run = { id: 123, run_attempt: 1, event: 'pull_request',
      path: '.github/workflows/quality.yml', status: 'completed',
      head_sha: options.historical ? 'a'.repeat(40) : pr.head.sha, conclusion: 'success',
      pull_requests: [{ number: pr.number, head: pr.head, base: { sha: 'e'.repeat(40) } }] };
    const proof = { repository: process.env.GITHUB_REPOSITORY,
      runId: run.id, runAttempt: run.run_attempt, pullRequest: pr.number,
      headSha: run.head_sha, baseSha: options.historical ? 'f'.repeat(40) : process.env.BASE_SHA,
      testedTree: options.historical ? 'e'.repeat(40) : tree };
    childProcess.execFileSync = (file, args) => {
      if (file === 'git') {
        gitCalls.push(args);
        if (args[0] === 'cat-file') return '';
        if (args[0] === 'diff') return (options.historical && args[2] === proof.testedTree
          ? options.changed : paths).join('\\n') + '\\n';
        if (args[0] === 'rev-parse') return (args[1] === process.env.BASE_SHA + '^{tree}'
          ? options.baseTree ?? tree : tree) + '\\n';
        if (args[0] === 'merge-tree') return proof.testedTree + '\\n';
        if (args[0] === 'show' && args[1].endsWith(':' + process.env.SCOPE_TEST_HELPER)) {
          const source = args[1].startsWith('HEAD:') ? snapshot?.after : snapshot?.before;
          if (typeof source !== 'string') throw new Error('synthetic missing Git blob');
          return source;
        }
        if (args[0] === 'show' && args[1].endsWith(':' + process.env.SCOPE_TEST_ACCEPTANCE)) {
          const source = args[1].startsWith('HEAD:') ? snapshot?.acceptance?.after : snapshot?.acceptance?.before;
          if (typeof source !== 'string') throw new Error('synthetic missing acceptance blob');
          return source;
        }
        if (args[0] === 'ls-tree') {
          const source = args[3] === process.env.SCOPE_TEST_HELPER ? snapshot : snapshot?.acceptance;
          const mode = args[1] === 'HEAD' ? source?.afterMode : source?.beforeMode;
          return (mode ?? '100644') + ' blob ' + 'e'.repeat(40) + '\\t' + args[3] + '\\n';
        }
        if (args[0] === 'show' && args[1].endsWith(':apps/api/prisma-mysql/schema.prisma'))
          return (args[1].startsWith('HEAD:') ? options.schemaAfter : options.schemaBefore)
            ?? fixtureSchema;
        throw new Error('Unexpected Git command: ' + JSON.stringify(args));
      }
      if (file === 'gh' && args[0] === 'run') return '';
      if (file === 'gh' && args[0] === 'api') {
        apiCalls.push(args[1]);
        if (args[1].endsWith('/pulls')) return JSON.stringify([pr]);
        if (args[1].includes('/workflows/quality.yml/runs?'))
          return JSON.stringify({ workflow_runs: [run] });
        if (args[1].endsWith('/artifacts?per_page=100'))
          return JSON.stringify({ artifacts: [{ name: 'quality-source-evidence-1', expired: false }] });
        if (args[1].endsWith('/jobs?per_page=100'))
          return JSON.stringify({ jobs: options.historical
            ? ['guards', 'admin', 'api', 'connector'].map(part => ({ name: 'recharge (' + part + ')', conclusion: 'success' }))
            : [{ name: 'quality', conclusion: 'success' }] });
      }
      throw new Error('Unexpected process: ' + file);
    };
    const readFile = fs.readFileSync;
    fs.readFileSync = (path, ...args) => {
      const fixtureSource = fixtureSources.get(String(path));
      if (fixtureSource !== undefined)
        return typeof args[0] === 'string' ? fixtureSource : Buffer.from(fixtureSource);
      if (path === process.env.GITHUB_EVENT_PATH) return JSON.stringify({ pull_request: pr });
      if (path === '.deploy/ci-source-evidence/123-1/evidence.json') return JSON.stringify(proof);
      return readFile(path, ...args);
    };
    fs.appendFileSync = (path, contents) => writes.push({ path, contents });
    syncBuiltinESMExports();
    let result;
    console.log = (value) => { result = JSON.parse(value); };
    process.argv = ['node', 'scripts/ci-recharge-scope.mjs'];
    await import('./scripts/ci-recharge-scope.mjs');
    process.stdout.write(JSON.stringify({ result, gitCalls, apiCalls, writes,
      fixtureTransfer: options.fixtureTransferProbe ? {
        beforeBytes: Buffer.byteLength(options.schemaBefore),
        beforeSha256: createHash('sha256').update(options.schemaBefore).digest('hex'),
        afterBytes: Buffer.byteLength(options.schemaAfter),
        afterSha256: createHash('sha256').update(options.schemaAfter).digest('hex')
      } : undefined
    }));
  `;
  const runtime = new URL('../.runtime/', import.meta.url);
  fs.mkdirSync(runtime, { recursive: true });
  const temporary = fs.mkdtempSync(new URL('ci-scope-fixture-', runtime));
  const inputPath = temporary + '/input.json';
  fs.writeFileSync(
    inputPath,
    JSON.stringify({ paths, snapshot, options, schema, registrationSourceFixtures })
  );
  try {
    return JSON.parse(
      execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          SCOPE_TEST_FIXTURE_FILE: inputPath,
          GITHUB_EVENT_NAME: eventName,
          GITHUB_REF: 'refs/heads/synthetic-scope-fixture',
          GITHUB_EVENT_PATH: root + '/.runtime/online-recharge-ci-synthetic-event.json',
          GITHUB_OUTPUT: root + '/.runtime/online-recharge-ci-synthetic-output',
          GITHUB_STEP_SUMMARY: root + '/.runtime/online-recharge-ci-synthetic-summary',
          GITHUB_REPOSITORY: 'fixture/id-business',
          GITHUB_SHA: 'c'.repeat(40),
          BASE_SHA: options.base ?? 'a'.repeat(40),
          SCOPE_TEST_HELPER: productionDatabaseAccessHelper,
          SCOPE_TEST_ACCEPTANCE: productionDatabaseAccessAcceptance
        }
      })
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

test('bank-card policy controls require the exact paired source hashes and regular Git modes', () => {
  const paths = [
    ...bankPolicyPaths,
    productionDatabaseAccessTest,
    'scripts/production-release/online-recharge-scope.py',
    'scripts/production-release/online-recharge-scope.test.py',
    'scripts/ci-recharge-scope.mjs',
    'scripts/ci-recharge-check.mjs'
  ];
  assert.equal(isCiOnly(paths), false);
  assert.equal(hasBankCardDeletePolicyProof(paths, bankProof), true);
  assert.equal(checkMode(paths, schema, schema, bankProof), 'ci-only');
  assert.deepEqual(selectedParts(paths, bankProof), ['guards', 'security']);
  for (const only of bankPolicyPaths) {
    assert.equal(hasBankCardDeletePolicyProof([only], bankProof), false);
    assert.equal(checkMode([only], schema, schema, bankProof), 'full');
  }
});

test('bank-card proof rejects either source drift, unknown modes and mixed business paths', () => {
  const invalid = [
    undefined,
    grantProof,
    { ...bankProof, before: bankProof.before + '\n' },
    { ...bankProof, after: bankProof.after + '\n' },
    { ...bankProof, beforeMode: undefined },
    { ...bankProof, beforeMode: '100755' },
    { ...bankProof, afterMode: '120000' },
    { ...bankProof, acceptance: undefined },
    { ...bankProof, acceptance: { ...bankProof.acceptance, before: '' } },
    {
      ...bankProof,
      acceptance: { ...bankProof.acceptance, after: bankProof.acceptance.after + '\n' }
    },
    { ...bankProof, acceptance: { ...bankProof.acceptance, beforeMode: '100755' } },
    { ...bankProof, acceptance: { ...bankProof.acceptance, afterMode: undefined } },
    {
      ...bankProof,
      after: bankProof.after.replace(
        'id_business_v2_bank_recharge_cards',
        'id_business_v2_bank_recharge_orders'
      )
    }
  ];
  for (const snapshot of invalid) {
    assert.equal(hasBankCardDeletePolicyProof(bankPolicyPaths, snapshot), false);
    assert.equal(checkMode(bankPolicyPaths, schema, schema, snapshot), 'full');
  }
  for (const other of [
    productionDatabaseAccessAcceptance + '.backup',
    'scripts/acceptance-v2-financial-integrity.mjs',
    'scripts/lib/v2-production-database-access-other.mjs',
    'scripts/provision-v2-production-database-access.mjs',
    'apps/api/src/auth/auth.service.ts',
    'apps/api/prisma-mysql/schema.prisma',
    'apps/admin/src/v2/features/auto-registration/useAppleMailboxes.ts'
  ]) {
    const paths = [...bankPolicyPaths, other];
    assert.equal(hasBankCardDeletePolicyProof(paths, bankProof), false, other);
    assert.equal(checkMode(paths, schema, schema, bankProof), 'full', other);
  }
});

test('bank-card PR and identical-tree main CLI select guards and disposable database security', () => {
  for (const eventName of ['pull_request', 'push']) {
    const { result, gitCalls } = recordScopeClassification(bankPolicyPaths, bankProof, eventName);
    assert.equal(result.mode, 'ci-only');
    assert.deepEqual(result.checkParts, ['guards', 'security']);
    assert.equal(result.reuseMain, eventName === 'push');
    for (const path of bankPolicyPaths) {
      assert.ok(gitCalls.some((args) => args.join(' ') === 'show ' + 'a'.repeat(40) + ':' + path));
      assert.ok(gitCalls.some((args) => args.join(' ') === 'show HEAD:' + path));
      assert.ok(
        gitCalls.some((args) => args.join(' ') === 'ls-tree ' + 'a'.repeat(40) + ' -- ' + path)
      );
      assert.ok(gitCalls.some((args) => args.join(' ') === 'ls-tree HEAD -- ' + path));
    }
  }
  for (const snapshot of [
    { ...bankProof, acceptance: {} },
    { ...bankProof, afterMode: '100755' },
    { ...bankProof, acceptance: { ...bankProof.acceptance, after: '' } }
  ])
    assert.equal(recordScopeClassification(bankPolicyPaths, snapshot).result.mode, 'full');
});

test('online recovery accepts only the reviewed three-line grant change with exact source proof', () => {
  assert.equal(
    createHash('sha256').update(grantHelperBefore).digest('hex'),
    '6c8285ba7322d460c89778dc1793a553d1ddd8316f246d0411a3275857881e00'
  );
  assert.equal(
    createHash('sha256').update(grantHelperAfter).digest('hex'),
    '7ece1de5cbba89b26615d749a671d32a380f4dc377548071746d14f1f2e2a546'
  );
  const controls = [
    onlineRechargeRecoveryPolicy,
    productionDatabaseAccessTest,
    'scripts/production-release/online-recharge-scope.py',
    'scripts/production-release/online-recharge-readonly.test.py',
    'scripts/ci-recharge-scope.mjs',
    'docs/ONLINE_RECHARGE.md'
  ];
  assert.equal(isCiOnly(controls), true);
  assert.equal(checkMode(controls, schema, schema), 'ci-only');
  assert.deepEqual(selectedParts(controls), ['guards']);
  for (const paths of [
    [productionDatabaseAccessHelper],
    [...controls, productionDatabaseAccessHelper]
  ]) {
    assert.equal(isCiOnly(paths), false);
    assert.equal(checkMode(paths, schema, schema, grantProof), 'ci-only');
  }
});

test('grant source proof is fail closed for missing snapshots and any additional source edit', () => {
  const invalid = [
    undefined,
    null,
    {},
    { before: grantHelperBefore },
    { after: grantHelperAfter },
    { before: grantHelperBefore.trim(), after: grantHelperAfter },
    { before: grantHelperBefore, after: grantHelperAfter.trim() },
    { before: grantHelperAfter, after: grantHelperBefore },
    { before: grantHelperBefore, after: grantHelperBefore },
    { before: grantHelperBefore, after: grantHelperAfter + '\n' },
    {
      before: grantHelperBefore,
      after: grantHelperAfter.replace(grantAdditions, grantAdditions + "  'audit_logs',\n")
    },
    {
      before: grantHelperBefore,
      after: grantHelperAfter.replace("  'role_permissions',\n", '')
    },
    {
      before: grantHelperBefore,
      after: grantHelperAfter.replace("  'role_permissions',", "  'different_table',")
    },
    {
      before: grantHelperBefore,
      after: grantHelperAfter.replace(
        "const RUNTIME_USERNAME = 'id_business_app';",
        "const RUNTIME_USERNAME = 'other';"
      )
    },
    {
      before: grantHelperBefore + '\n',
      after: grantHelperAfter + '\n'
    }
  ];
  for (const snapshot of invalid)
    assert.equal(checkMode([productionDatabaseAccessHelper], schema, schema, snapshot), 'full');
  assert.equal(isCiOnly([productionDatabaseAccessHelper]), false);
});

test('the fixed recovery policy and grant test are bounded controls and never authorize mixed apps', () => {
  for (const path of [onlineRechargeRecoveryPolicy, productionDatabaseAccessTest]) {
    assert.equal(isCiOnly([path]), true);
    assert.equal(checkMode([path], schema, schema), 'ci-only');
  }
  for (const path of [
    onlineRechargeRecoveryPolicy + '.backup',
    onlineRechargeRecoveryPolicy.replace('recovery.json', 'recovery-other.json'),
    onlineRechargeRecoveryPolicy.replace('production-release/', ''),
    productionDatabaseAccessTest.replace('.test.mjs', '.mjs'),
    productionDatabaseAccessHelper + '.backup'
  ]) {
    assert.equal(isCiOnly([path]), false);
    assert.equal(checkMode([path], schema, schema), 'full');
    assert.equal(
      checkMode([productionDatabaseAccessHelper, path], schema, schema, grantProof),
      'full'
    );
  }
  for (const path of [
    'apps/api/src/id-business-v2/online-recharge/online-recharge.service.ts',
    'apps/admin/src/v2/features/online-recharge/OnlineResourceView.vue',
    'apps/api/src/auth/auth.service.ts',
    'apps/api/prisma-mysql/schema.prisma'
  ])
    assert.equal(
      checkMode(
        [onlineRechargeRecoveryPolicy, productionDatabaseAccessHelper, path],
        schema,
        schema,
        grantProof
      ),
      'full',
      path
    );
});

test('the exact BitBrowser source mapping and its five control files retain only guards', () => {
  const policy = 'deploy/aws/bitbrowser-reviewed-release-20261012.json';
  const controls = [
    policy,
    'scripts/production-release/online-recharge-scope.py',
    'scripts/production-release/online-recharge-scope.test.py',
    'scripts/ci-recharge-scope.mjs',
    'scripts/ci-recharge-scope.test.mjs'
  ];
  for (const paths of [[policy], controls]) {
    assert.equal(isCiOnly(paths), true);
    assert.equal(checkMode(paths, schema, schema), 'ci-only');
    assert.deepEqual(selectedParts(paths), ['guards']);
    for (const eventName of ['pull_request', 'push']) {
      const { result } = recordScopeClassification(paths, {}, eventName);
      assert.equal(result.mode, 'ci-only');
      assert.deepEqual(result.checkParts, ['guards']);
      assert.equal(result.reuseMain, eventName === 'push');
    }
  }
  for (const outside of [
    policy + '.backup',
    policy.replace('20261012', '20261013'),
    policy.replace('reviewed-release', 'unreviewed-release'),
    policy.replace('deploy/aws/', 'deploy/'),
    'apps/api/src/main.ts',
    'apps/admin/src/App.vue',
    'apps/api/prisma-mysql/schema.prisma',
    'apps/api/prisma-mysql/migrations/unreviewed/migration.sql'
  ]) {
    for (const paths of [[outside], [...controls, outside]]) {
      assert.equal(isCiOnly(paths), false, outside);
      assert.equal(checkMode(paths, schema, schema), 'full', outside);
      for (const eventName of ['pull_request', 'push'])
        assert.equal(recordScopeClassification(paths, {}, eventName).result.mode, 'full', outside);
    }
  }
});

test('PR and same-tree main CLI classification both read raw BASE_SHA and HEAD helper snapshots', () => {
  const paths = [
    onlineRechargeRecoveryPolicy,
    productionDatabaseAccessHelper,
    productionDatabaseAccessTest
  ];
  for (const eventName of ['pull_request', 'push']) {
    const { result, gitCalls, writes } = recordScopeClassification(paths, grantProof, eventName);
    assert.equal(result.mode, 'ci-only');
    assert.deepEqual(result.checkParts, ['guards']);
    assert.equal(result.reuseMain, eventName === 'push');
    assert.ok(
      gitCalls.some(
        (args) => args.join(' ') === 'show ' + 'a'.repeat(40) + ':' + productionDatabaseAccessHelper
      )
    );
    assert.ok(
      gitCalls.some((args) => args.join(' ') === 'show HEAD:' + productionDatabaseAccessHelper)
    );
    assert.ok(writes.some(({ contents }) => contents.startsWith('mode=ci-only\n')));
  }
});

test('PR and main CLI classification retain full mode for missing blobs, wider grants and mixed apps', () => {
  for (const eventName of ['pull_request', 'push']) {
    for (const { paths, snapshot } of [
      { paths: [productionDatabaseAccessHelper], snapshot: {} },
      {
        paths: [productionDatabaseAccessHelper],
        snapshot: { before: grantHelperBefore, after: grantHelperAfter + '\n' }
      },
      {
        paths: [productionDatabaseAccessHelper, 'apps/api/src/auth/auth.service.ts'],
        snapshot: grantProof
      }
    ])
      assert.equal(recordScopeClassification(paths, snapshot, eventName).result.mode, 'full');
  }
  const noHelper = recordScopeClassification([onlineRechargeRecoveryPolicy], {}, 'pull_request');
  assert.equal(noHelper.result.mode, 'ci-only');
  assert.equal(
    noHelper.gitCalls.some(
      (args) => args[0] === 'show' && args[1].endsWith(':' + productionDatabaseAccessHelper)
    ),
    false
  );
});
const files = [
  'apps/admin/src/v2/features/auto-recharge/example.vue',
  'apps/api/prisma-mysql/schema.prisma'
];
test('线上代充界面改动会保留所有公共检查并执行专项浏览器验收', () => {
  const paths = ['apps/admin/src/v2/features/online-recharge/OnlineResourceView.vue'];
  const commands = adminCheckCommands('admin', paths);
  assert.ok(commands.some((args) => args.includes('acceptance:v2-online-recharge-ui')));
  assert.ok(adminUiGuardChecks('admin', paths).includes('check:v2-table-standard'));
  assert.ok(adminUiGuardChecks('admin', paths).includes('check:v2-loading-standard'));
  assert.ok(
    !adminCheckCommands('admin', ['docs/V2_TASKS.md']).some((args) =>
      args.includes('acceptance:v2-online-recharge-ui')
    )
  );
});
test('fixed pricing 045 carries only the exact main5b sources and metadata without expanding services or database suites', () => {
  const profile = 'deploy/aws/recharge-pro-pricing-045-20261008.json';
  const sources = [
    'plan_selection.py',
    'test_pro.py',
    'registration_browser.py',
    'test_registration_browser.py'
  ].map((name) => 'apps/api/src/id-business-v2/auto-recharge/worker/' + name);
  const controls = [
    profile,
    'docs/V2_TASKS.md',
    '.github/workflows/production-release.yml',
    'scripts/ci-recharge-scope.mjs',
    'scripts/ci-recharge-scope.test.mjs',
    'scripts/ci-recharge-release.test.mjs',
    ...[
      'build-images.sh',
      'push-images.sh',
      'dispatch.sh',
      'validate-release-selection.sh',
      'remote-deploy.py',
      'remote-deploy.test.py',
      'maintain-image-cache.py',
      'maintain-image-cache.test.py'
    ].map((name) => 'scripts/production-release/' + name)
  ];
  controls.push(
    'deploy/aws/registration-baseline-96-20261008.json',
    'deploy/aws/registration-worker-96-20261008.json',
    'scripts/ci-recharge-check.mjs',
    'scripts/production-release/registration-onboarding-96.py',
    'scripts/production-release/registration-onboarding-96.test.py',
    'scripts/production-release/registration-only-transport.test.py'
  );
  assert.equal(hasRegistrationOnboardingScope(controls), false);
  assert.equal(checkMode(controls, schema, schema), 'ci-only');
  assert.deepEqual(selectedParts(controls), ['guards']);
  for (const selected of [sources, ...sources.map((source) => [source])]) {
    const paths = [...controls, ...selected];
    assert.equal(isCiOnly(paths), false);
    assert.equal(isRechargeOnly(paths, schema, schema), true);
    assert.equal(isTargetedOnly(paths, schema, schema), true);
    assert.equal(checkMode(paths, schema, schema), 'recharge');
    assert.deepEqual(selectedParts(paths), ['guards', 'connector']);
    assert.deepEqual(adminUiGuardChecks('recharge', paths), []);
    assert.deepEqual(backendArchitectureGuardChecks('recharge', paths), []);
  }
  for (const outside of [
    'deploy/aws/recharge-pro-6f5-20261008.json',
    profile + '.backup',
    'deploy/aws/registration-worker-95-20261008.json',
    'apps/api/prisma-mysql/schema.prisma',
    'apps/api/src/id-business-v2/auto-recharge/worker/server.py',
    'scripts/production-release/service-image-retention.py',
    'apps/admin/src/v2/features/auto-recharge/AutoRechargePage.vue'
  ]) {
    assert.equal(checkMode([...controls, ...sources, outside], schema, schema), 'full');
    assert.equal(hasRegistrationOnboardingScope([...controls, ...sources, outside]), true);
    assert.equal(isCiOnly([...controls, outside]), false);
  }
});
test('registration96 uses its fifteen exact release controls and only the reviewed browser pair', () => {
  const controls = [...registrationOnboardingControls];
  const pair = [
    'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py',
    'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py'
  ];
  assert.equal(controls.length, 15);
  assert.equal(checkMode(controls, schema, schema), 'ci-only');
  assert.deepEqual(selectedParts(controls), ['guards']);
  for (const identity of [controls[0], controls[1], controls[2], controls[3]]) {
    assert.equal(hasRegistrationOnboardingScope([identity]), true);
    assert.equal(checkMode([identity], schema, schema), 'ci-only');
    assert.deepEqual(selectedParts([identity]), ['guards']);
  }
  for (const sources of [pair, ...pair.map((path) => [path])]) {
    const paths = [...controls, ...sources];
    assert.equal(isCiOnly(paths), false);
    assert.equal(isRechargeOnly(paths, schema, schema), true);
    assert.equal(isTargetedOnly(paths, schema, schema), true);
    assert.equal(checkMode(paths, schema, schema), 'recharge');
    assert.deepEqual(selectedParts(paths), ['guards', 'connector']);
    assert.deepEqual(adminUiGuardChecks('recharge', paths), []);
    assert.deepEqual(backendArchitectureGuardChecks('recharge', paths), []);
  }
  for (const outside of [
    'deploy/aws/registration-worker-96-20261009.json',
    'deploy/aws/registration-worker-96-20261008.json.backup',
    'deploy/aws/registration-baseline-96-unreviewed.json',
    'deploy/aws/registration-worker-95-20261008.json',
    'scripts/production-release/registration-interstitial-95.py',
    'deploy/aws/recharge-pro-6f5-20261008.json',
    'scripts/production-release/remote-deploy.test.py',
    'scripts/production-release/registration-onboarding-96-other.py',
    'scripts/production-release/api-admin-scope.py',
    'apps/api/src/id-business-v2/auto-recharge/worker/server.py',
    'apps/api/src/id-business-v2/auto-recharge/worker/plan_selection.py',
    'apps/api/src/id-business-v2/auto-recharge/worker/Dockerfile',
    'apps/api/src/id-business-v2/auto-registration/registration-worker.ts',
    'apps/api/src/auth/auth.service.ts',
    'apps/api/prisma-mysql/schema.prisma',
    'apps/admin/src/v2/features/auto-registration/AutoRegistrationPage.vue',
    '.env.example',
    'package-lock.json'
  ]) {
    for (const paths of [
      [...controls, outside],
      [...controls, ...pair, outside]
    ]) {
      assert.equal(checkMode(paths, schema, schema), 'full', outside);
      assert.equal(isCiOnly(paths), false, outside);
      assert.equal(isRechargeOnly(paths, schema, schema), false, outside);
      assert.equal(isTargetedOnly(paths, schema, schema), false, outside);
    }
  }
});
test('documentation and CI selectors do not start business or database checks', () => {
  for (const path of ['docs/V2_TASKS.md', 'AGENTS.md', 'README.md', 'scripts/ci-change-scope.mjs'])
    assert.equal(checkMode([path], schema, schema), 'ci-only');
  for (const path of [
    'package-lock.json',
    'apps/api/prisma-mysql/schema.prisma',
    'apps/api/src/auth/auth.controller.ts'
  ])
    assert.equal(checkMode([path], schema, schema), 'full');
});
test('the fixed 2f recharge profile selects deployment controls without business or database suites', () => {
  const profile = 'deploy/aws/recharge-pro-2f-20261007.json';
  const controls = [
    profile,
    '.github/workflows/production-release.yml',
    'scripts/production-release/build-images.sh',
    'scripts/production-release/push-images.sh',
    'scripts/production-release/dispatch.sh',
    'scripts/production-release/validate-release-selection.sh',
    'scripts/production-release/remote-deploy.py',
    'scripts/production-release/remote-deploy.test.py',
    'docs/V2_TASKS.md'
  ];
  assert.equal(isCiOnly([profile]), true);
  assert.equal(checkMode(controls, schema, schema), 'ci-only');
  assert.deepEqual(selectedParts(controls), ['guards']);
  for (const unknown of [
    'deploy/aws/recharge-pro-2f-20261008.json',
    profile + '.backup',
    'deploy/aws/recharge-pro-2f-unreviewed.json'
  ]) {
    assert.equal(isCiOnly([unknown]), false);
    assert.equal(checkMode([...controls, unknown], schema, schema), 'full');
  }
  const worker = 'apps/api/src/id-business-v2/auto-recharge/worker/plan_selection.py';
  assert.equal(checkMode([...controls, worker], schema, schema), 'recharge');
  assert.deepEqual(selectedParts([...controls, worker]), ['guards', 'connector']);
});
for (const identity of ['recharge-pro-4c-20261008', 'recharge-pro-6f5-20261008']) {
  test(`the fixed ${identity} successor keeps its two Worker sources and reviewed controls in a single service scope`, () => {
    const profile = `deploy/aws/${identity}.json`;
    const sources = [
      'apps/api/src/id-business-v2/auto-recharge/worker/plan_selection.py',
      'apps/api/src/id-business-v2/auto-recharge/worker/test_pro.py'
    ];
    const controls = [
      profile,
      '.github/workflows/production-release.yml',
      'scripts/production-release/build-images.sh',
      'scripts/production-release/push-images.sh',
      'scripts/production-release/dispatch.sh',
      'scripts/production-release/validate-release-selection.sh',
      'scripts/production-release/remote-deploy.py',
      'scripts/production-release/remote-deploy.test.py',
      'scripts/production-release/maintain-image-cache.py',
      'scripts/production-release/maintain-image-cache.test.py',
      'scripts/ci-recharge-scope.mjs',
      'scripts/ci-recharge-scope.test.mjs',
      'scripts/ci-recharge-release.test.mjs',
      'docs/V2_TASKS.md'
    ];
    assert.equal(isCiOnly([profile]), true);
    assert.equal(checkMode(controls, schema, schema), 'ci-only');
    assert.deepEqual(selectedParts(controls), ['guards']);
    for (const selected of [sources, ...sources.map((source) => [source])]) {
      const paths = [...controls, ...selected];
      assert.equal(isCiOnly(paths), false);
      assert.equal(isRechargeOnly(paths, schema, schema), true);
      assert.equal(isTargetedOnly(paths, schema, schema), true);
      assert.equal(checkMode(paths, schema, schema), 'recharge');
      assert.deepEqual(selectedParts(paths), ['guards', 'connector']);
      assert.deepEqual(adminUiGuardChecks('recharge', paths), []);
      assert.deepEqual(backendArchitectureGuardChecks('recharge', paths), []);
    }
    for (const outside of [
      `deploy/aws/${identity === 'recharge-pro-4c-20261008' ? 'recharge-pro-6f5-20261008' : 'recharge-pro-4c-20261008'}.json`,
      'deploy/aws/recharge-pro-6f5-20261009.json',
      'deploy/aws/recharge-pro-6f5-unreviewed.json',
      'deploy/aws/registration-worker-95-20261008.json',
      'deploy/aws/recharge-pro-4c-20261009.json',
      profile + '.backup',
      'deploy/aws/recharge-pro-4c-unreviewed.json',
      'deploy/aws/recharge-pro-815-20261007.json',
      'deploy/aws/recharge-pro-d3fb-20261007.json',
      'deploy/aws/recharge-pro-2f-20261007.json',
      'deploy/aws/registration-worker-93-20261007.json',
      'deploy/aws/registration-worker-94-20261007.json',
      'apps/api/src/id-business-v2/auto-recharge/worker/Dockerfile',
      'apps/api/src/id-business-v2/auto-recharge/worker/payment.py',
      'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py',
      'apps/api/src/id-business-v2/auto-registration/registration-worker.ts',
      'apps/api/src/auth/auth.service.ts',
      'apps/admin/src/v2/features/auto-recharge/AutoRechargePage.vue',
      'apps/api/prisma-mysql/schema.prisma',
      'scripts/ci-recharge-check.mjs',
      'scripts/production-release/service-image-retention.py',
      'scripts/production-release/browser-cache-input.py',
      'scripts/production-release/browser-cache-input.test.py',
      'scripts/production-release/build-image-cache.test.py',
      'scripts/production-release/api-admin-scope.py',
      'scripts/production-release/api-admin-readonly.py',
      'scripts/production-release/api-admin-scope.test.py',
      'scripts/check-v2-module-architecture.mjs',
      'scripts/check-v2-prisma-runtime-boundary.mjs',
      'scripts/check-v2-concurrency-standard.mjs',
      'apps/admin/src/components/ui/AppButton.vue',
      'scripts/admin-skin-rules.mjs',
      'scripts/acceptance-v2-skin-consistency.mjs',
      'docs/AUTO_REGISTRATION.md',
      '.env.example',
      'package-lock.json'
    ]) {
      for (const paths of [
        [...controls, outside],
        [...controls, ...sources, outside]
      ]) {
        assert.equal(checkMode(paths, schema, schema), 'full', outside);
        assert.equal(isCiOnly(paths), false, outside);
        assert.equal(isRechargeOnly(paths, schema, schema), false, outside);
        assert.equal(isTargetedOnly(paths, schema, schema), false, outside);
      }
    }
    for (const unknown of [
      'deploy/aws/recharge-pro-4c-20261009.json',
      profile + '.backup',
      'deploy/aws/recharge-pro-4c-unreviewed.json',
      'deploy/aws/recharge-pro-815-20261007.json',
      'deploy/aws/recharge-pro-d3fb-20261007.json'
    ]) {
      assert.equal(isCiOnly([unknown]), false);
      assert.equal(checkMode([unknown], schema, schema), 'full');
    }
  });
}

test('historical audit controls use their four exact reviewed paths', () => {
  const controls = [
    'deploy/aws/historical-finance-20261005-registration-continuation.json',
    'scripts/lib/v2-release-history-policy.mjs',
    'scripts/v2-release-history-audit.mjs',
    'scripts/v2-release-history-policy.test.mjs'
  ];
  for (const path of controls) {
    assert.equal(isCiOnly([path]), true, path);
    assert.equal(checkMode([path], schema, schema), 'ci-only', path);
    assert.deepEqual(selectedParts([path]), ['guards'], path);
  }
  assert.equal(checkMode(controls, schema, schema), 'ci-only');
  const worker = 'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py';
  assert.equal(checkMode([...controls, worker], schema, schema), 'recharge');
  assert.deepEqual(selectedParts([...controls, worker]), ['guards', 'connector']);
  const security = 'apps/api/src/auth/auth.service.ts';
  assert.equal(checkMode([...controls, security], schema, schema), 'recharge');
  assert.deepEqual(selectedParts([...controls, security]), ['guards', 'api', 'security']);
  const admin = 'apps/admin/src/v2/features/orders/Orders.vue';
  assert.equal(checkMode([...controls, admin], schema, schema), 'admin');
  assert.deepEqual(selectedParts([...controls, admin]), ['guards', 'admin']);
  for (const path of [
    'deploy/aws/historical-finance-20261005.json',
    'deploy/aws/historical-finance-unreviewed.json',
    'deploy/aws/historical-finance-20261005-registration-continuation-other.json',
    'deploy/aws/historical-finance-20261005-registration-continuation.json.backup',
    'scripts/lib/v2-release-history-policy-other.mjs',
    'scripts/v2-release-history-audit-other.mjs',
    'scripts/v2-release-history-policy-other.test.mjs',
    'scripts/lib/v2-data-integrity-audit.mjs'
  ]) {
    assert.equal(isCiOnly([path]), false, path);
    assert.equal(checkMode([path], schema, schema), 'full', path);
    assert.equal(checkMode([...controls, worker, path], schema, schema), 'full', path);
    assert.equal(checkMode([...controls, security, path], schema, schema), 'full', path);
  }
});
test('the complete registration continuation candidate retains targeted checks with exact production controls', () => {
  const productionControls = [
    '.github/workflows/production-release.yml',
    'scripts/production-release/dispatch.sh',
    'scripts/production-release/remote-deploy.py',
    'scripts/production-release/remote-deploy.test.py',
    'scripts/production-release/maintain-image-cache.py',
    'scripts/production-release/maintain-image-cache.test.py'
  ];
  const candidate = [
    'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py',
    'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py',
    'docs/V2_TASKS.md',
    'docs/PRODUCTION_RELEASE_OIDC.md',
    'scripts/ci-recharge-scope.mjs',
    'scripts/ci-recharge-scope.test.mjs',
    'scripts/ci-recharge-check.mjs',
    'scripts/ci-recharge-release.test.mjs',
    'deploy/aws/historical-finance-20261005-registration-continuation.json',
    'scripts/lib/v2-release-history-policy.mjs',
    'scripts/v2-release-history-audit.mjs',
    'scripts/v2-release-history-policy.test.mjs',
    ...productionControls
  ];
  assert.equal(candidate.length, 18);
  assert.equal(checkMode(candidate, schema, schema), 'recharge');
  assert.deepEqual(selectedParts(candidate), ['guards', 'admin', 'api', 'connector']);
  assert.equal(
    checkMode(
      candidate.filter((path) => !path.startsWith('apps/')),
      schema,
      schema
    ),
    'ci-only'
  );
  for (const path of productionControls) {
    assert.equal(checkMode([path], schema, schema), 'ci-only', path);
    assert.deepEqual(selectedParts([path]), ['guards'], path);
  }
  for (const path of [
    'scripts/production-release/unreviewed.py',
    'scripts/production-release/remote-deploy-other.py',
    'scripts/production-release/maintain-image-cache-other.test.py',
    'deploy/aws/historical-finance-unreviewed.json',
    'scripts/lib/v2-data-integrity-audit.mjs',
    'apps/api/src/id-business-v2/orders/order.service.ts'
  ]) {
    assert.equal(checkMode([path], schema, schema), 'full', path);
    assert.equal(checkMode([...candidate, path], schema, schema), 'full', path);
  }
  for (const path of [
    'scripts/production-release/storage-maintenance.py',
    'scripts/production-release/reuse-images.py',
    'scripts/production-release/cleanup-reviewed-cache.py'
  ]) {
    assert.equal(isCiOnly([path]), true, path);
    assert.equal(checkMode([...candidate, path], schema, schema), 'full', path);
  }
});
test('approved audit trigger migration runs isolated MySQL guards without hiding other changes', () => {
  const migration =
    'apps/api/prisma-mysql/migrations/20261002123500_routine_audit_retention_exception/migration.sql';
  assert.equal(
    checkMode(
      [migration, 'scripts/production-release/audit-retention-mysql.test.py'],
      schema,
      schema
    ),
    'audit-retention'
  );
  assert.equal(checkMode([migration, 'apps/api/src/auth/auth.service.ts'], schema, schema), 'full');
  assert.equal(
    checkMode(['apps/api/prisma-mysql/migrations/other/migration.sql'], schema, schema),
    'full'
  );
});
test('disk retention scripts and reviewed policy use release control checks', () => {
  const paths = [
    'scripts/production-release/disk-retention.py',
    'scripts/production-release/disk-retention.test.py',
    'scripts/production-release/disk-retention-install.py',
    'scripts/production-release/disk-retention-install.test.py',
    'scripts/production-release/disk-retention-transport.py',
    'scripts/production-release/disk-retention-transport.test.py',
    '.github/workflows/disk-retention-maintenance.yml',
    'scripts/production-release/candidate-retention.py',
    'scripts/production-release/candidate-retention.test.py',
    'scripts/production-release/disk-lifecycle.test.py',
    'scripts/production-release/release-storage.py',
    'scripts/production-release/release-storage.test.py',
    'deploy/aws/disk-retention-policy-20261014.json'
  ];
  for (const path of paths) assert.equal(checkMode([path], schema, schema), 'ci-only');
  assert.equal(checkMode(paths, schema, schema), 'ci-only');
});

test('ordinary admin modules use frontend checks instead of backend and financial suites', () => {
  const paths = ['apps/admin/src/v2/features/orders/Orders.vue', 'docs/V2_TASKS.md'];
  assert.equal(checkMode(paths, schema, schema), 'admin');
  const commands = adminCheckCommands('admin', paths);
  assert.deepEqual(commands, [
    ['run', 'build', '--workspace', '@apple-business/shared'],
    ['run', 'test', '--workspace', '@apple-business/admin'],
    ['run', 'build', '--workspace', '@apple-business/admin'],
    ['exec', '--', 'node', 'scripts/acceptance-v2-order-archive-ui.mjs']
  ]);
  assert.ok(
    adminCheckCommands('admin', [...paths, files[0]]).some((args) =>
      args.includes('acceptance:v2-auto-recharge')
    )
  );
  assert.equal(
    checkMode([...paths, 'apps/api/src/id-business-v2/orders/order.service.ts'], schema, schema),
    'full'
  );
  assert.equal(checkMode(['apps/admin/src/auth/login.ts'], schema, schema), 'full');
  assert.equal(checkMode([files[0]], schema, schema), 'recharge');
});
test('release workflow diagnostics retain control checks and do not hide application changes', () => {
  const paths = [
    '.github/workflows/production-release.yml',
    'scripts/production-release/cleanup-reviewed-cache.py',
    'scripts/production-release/cleanup-reviewed-cache.test.py',
    'scripts/production-release/maintain-image-cache.py',
    'scripts/production-release/maintain-image-cache.test.py',
    'scripts/production-release/cleanup-verified-backups.py',
    'scripts/production-release/cleanup-verified-backups.test.py',
    'scripts/production-release/storage-maintenance.py',
    'scripts/production-release/storage-maintenance.test.py',
    'deploy/aws/cache-cleanup-storage-20261002.json',
    'deploy/aws/cache-cleanup-bitbrowser-direct-20261003.json',
    'deploy/aws/cache-cleanup-unused-legacy-20261003.json',
    'deploy/aws/cache-cleanup-20261001.json',
    'deploy/aws/cache-cleanup-fx-subscription-20261002.json',
    'deploy/aws/cache-cleanup-unified-20261002.json',
    'deploy/aws/cache-cleanup-unified-recovery-20261002.json',
    'deploy/aws/cache-cleanup-recharge-names-20261002.json',
    'deploy/aws/cache-cleanup-recharge-execution-20261002.json',
    'scripts/production-release/reuse-images.py',
    'docs/PRODUCTION_RELEASE_OIDC.md'
  ];
  assert.equal(checkMode(paths, schema, schema), 'ci-only');
  assert.deepEqual(selectedParts(paths), ['guards']);
  assert.equal(isCiOnly(['deploy/aws/cache-cleanup-unreviewed.json']), false);
  assert.notEqual(checkMode([...paths, 'docker-compose.aws-mysql.yml'], schema, schema), 'ci-only');
  assert.equal(
    checkMode([...paths, 'apps/api/src/auth/auth.controller.ts'], schema, schema),
    'full'
  );
  assert.equal(
    checkMode(
      [...paths, 'apps/admin/src/v2/components/workspace/V2QuickActions.vue'],
      schema,
      schema
    ),
    'admin'
  );
});
test('fixed mailbox diagnostics run controls without selecting business or database suites', () => {
  const paths = [
    '.github/workflows/production-release.yml',
    'scripts/production-release/mailbox-diagnostic.mjs',
    'scripts/production-release/mailbox-diagnostic.test.mjs',
    'scripts/production-release/mailbox-diagnostic.py',
    'scripts/production-release/mailbox-diagnostic.test.py'
  ];
  assert.equal(checkMode(paths, schema, schema), 'ci-only');
  assert.deepEqual(selectedParts(paths), ['guards']);
  assert.equal(isCiOnly(['scripts/production-release/mailbox-diagnostic-arbitrary.mjs']), false);
  assert.notEqual(
    checkMode([...paths, 'apps/api/src/auth/auth.service.ts'], schema, schema),
    'ci-only'
  );
});
test('every scoped V2 frontend route runs the same UI, skin, loading and draft guards', () => {
  const required = [
    'check:admin-ui',
    'check:v2-ui-language',
    'check:v2-color-contrast',
    'check:v2-table-standard',
    'check:v2-loading-standard',
    'check:v2-module-architecture',
    'check:v2-isolation'
  ];
  for (const path of [
    'apps/admin/src/v2/features/customers/NewCustomerView.vue',
    'apps/admin/src/v2/features/auto-recharge/NewRechargeView.vue',
    'apps/admin/src/v2/features/auto-recharge/VendureMailboxManager.vue',
    'apps/admin/src/v2/styles/base.css'
  ]) {
    const mode = checkMode([path], schema, schema);
    const checks = adminUiGuardChecks(mode, [path]);
    for (const name of required) assert.ok(checks.includes(name), `${mode}: missing ${name}`);
    assert.equal(new Set(checks).size, checks.length);
    assert.deepEqual(selectedParts([path]), ['guards', 'admin']);
  }
});
test('documentation and backend-only recharge changes do not start frontend UI guards', () => {
  for (const path of [
    'AGENTS.md',
    'docs/UI_DESIGN.md',
    'scripts/ci-recharge-check.mjs',
    'apps/api/src/id-business-v2/auto-recharge/example.service.ts'
  ]) {
    assert.deepEqual(adminUiGuardChecks(checkMode([path], schema, schema), [path]), []);
  }
});
test('backend architecture gates run without frontend changes in recharge and mailbox scopes', () => {
  for (const file of [
    'apps/api/src/id-business-v2/auto-recharge/recharge.service.ts',
    'apps/api/src/id-business-v2/workspace/id-business-v2-vendure-mailbox.service.ts',
    'packages/shared/src/v2/auto-recharge.ts',
    'packages/shared/src/v2/vendure-mailbox.ts'
  ]) {
    const paths = [file];
    assert.deepEqual(backendArchitectureGuardChecks(checkMode(paths, schema, schema), paths), [
      'check:v2-module-architecture',
      'check:v2-prisma-runtime-boundary',
      'check:v2-concurrency-standard'
    ]);
  }
  assert.equal(
    backendArchitectureGuardChecks('recharge', ['apps/api/prisma-mysql/schema.prisma']).length,
    3
  );
  for (const file of [
    'docs/V2_TASKS.md',
    'scripts/ci-recharge-check.mjs',
    'apps/admin/src/v2/features/auto-recharge/useAutoRecharge.ts',
    'apps/api/src/id-business-v2/auto-recharge/worker/test_registration.py'
  ]) {
    assert.deepEqual(backendArchitectureGuardChecks(checkMode([file], schema, schema), [file]), []);
  }
});
test('architecture guard repairs run only the affected control gate', () => {
  for (const guard of ['module-architecture', 'prisma-runtime-boundary', 'concurrency-standard']) {
    const paths = [`scripts/check-v2-${guard}.mjs`];
    assert.equal(checkMode(paths, schema, schema), 'ci-only');
    assert.deepEqual(selectedParts(paths), ['guards']);
    assert.deepEqual(backendArchitectureGuardChecks('ci-only', paths), [`check:v2-${guard}`]);
  }
});
test('public static information pages stay in admin checks without widening auth or API scope', () => {
  const paths = [
    'apps/admin/public/google-sheets.html',
    'apps/admin/public/google-sheets-info.css',
    'docs/V2_TASKS.md'
  ];
  assert.equal(checkMode(paths, schema, schema), 'admin');
  assert.deepEqual(selectedParts(paths), ['guards', 'admin']);
  assert.equal(checkMode([...paths, 'apps/admin/public/v2-boot.js'], schema, schema), 'full');
  assert.equal(checkMode([...paths, 'apps/admin/src/auth/login.ts'], schema, schema), 'full');
  assert.equal(
    checkMode([...paths, 'apps/api/src/id-business-v2/workspace/example.ts'], schema, schema),
    'full'
  );
});
test('shared record spacing and its browser acceptance stay in the admin scope', () => {
  const paths = [
    'apps/admin/src/v2/styles/records.css',
    'apps/admin/src/v2/features/auto-recharge/vendure-mailbox.css',
    'scripts/acceptance-v2-table-layout.mjs',
    'scripts/check-v2-table-standard.mjs',
    'docs/UI_DESIGN.md',
    'scripts/ci-recharge-scope.mjs'
  ];
  assert.equal(checkMode(paths, schema, schema), 'admin');
  assert.deepEqual(selectedParts(paths), ['guards', 'admin']);
  assert.ok(
    adminCheckCommands('admin', paths).some((args) => args.includes('acceptance:v2-table-layout'))
  );
});
test('direct login and workspace browser acceptance stay in exact admin scope', () => {
  const scripts = [
    'scripts/acceptance-v2-online-recharge-ui.mjs',
    'scripts/acceptance-v2-bitbrowser-direct.mjs',
    'scripts/acceptance-v2-refresh-interaction.mjs'
  ];
  const paths = [
    ...scripts,
    'apps/admin/src/v2/components/workspace/useV2QuickActions.ts',
    'apps/admin/src/v2/features/auto-recharge/bitbrowser-direct-login.ts',
    'docs/V2_TASKS.md'
  ];
  for (const script of scripts) {
    assert.equal(isAdminOnly([script]), true);
    assert.equal(checkMode([script], schema, schema), 'admin');
    assert.deepEqual(selectedParts([script]), ['guards', 'admin']);
    assert.equal(affectsPart('admin', [script]), true);
    for (const part of ['api', 'connector', 'migration', 'security'])
      assert.equal(affectsPart(part, [script]), false);
  }
  assert.equal(checkMode(paths, schema, schema), 'admin');
  assert.deepEqual(selectedParts(paths), ['guards', 'admin']);
  const checks = adminUiGuardChecks('admin', paths);
  for (const guard of [
    'check:admin-ui',
    'check:v2-ui-language',
    'check:v2-color-contrast',
    'check:v2-table-standard',
    'check:v2-loading-standard',
    'check:v2-module-architecture',
    'check:v2-isolation'
  ])
    assert.ok(checks.includes(guard));
  const commands = adminCheckCommands('admin', paths);
  assert.ok(
    commands.some((args) => args.join(' ') === 'run test --workspace @apple-business/admin')
  );
  assert.ok(
    commands.some((args) => args.join(' ') === 'run build --workspace @apple-business/admin')
  );
  assert.ok(commands.some((args) => args.includes('acceptance:v2-auto-recharge')));
  for (const other of [
    'scripts/acceptance-v2-bitbrowser-direct-other.mjs',
    'scripts/acceptance-v2-refresh-interaction-other.mjs',
    'apps/api/src/id-business-v2/workspace/example.ts',
    'apps/admin/src/auth/login.ts',
    'apps/api/prisma-mysql/schema.prisma',
    'packages/shared/src/index.ts',
    'package-lock.json'
  ])
    assert.equal(checkMode([...paths, other], schema, schema), 'full', other);
});
test('published recharge router and exact input controls retain the complete admin scope', () => {
  const frontend = [
    'apps/admin/src/v2-router.ts',
    'scripts/check-v2-input-retention.mjs',
    'scripts/check-v2-online-recharge-controls.test.mjs'
  ];
  const paths = [
    ...frontend,
    'apps/admin/src/v2/features/online-recharge/V2OnlineRedeemView.vue',
    'apps/admin/src/v2/features/auto-recharge/bitbrowser-direct-login.ts',
    'scripts/ci-recharge-scope.mjs',
    'scripts/ci-recharge-scope.test.mjs',
    'docs/V2_TASKS.md'
  ];
  for (const changed of [...frontend.map((path) => [path]), paths]) {
    assert.equal(isAdminOnly(changed), true);
    assert.equal(checkMode(changed, schema, schema), 'admin');
    assert.deepEqual(selectedParts(changed), ['guards', 'admin']);
    assert.deepEqual(adminUiGuardChecks('admin', changed), [
      'check:admin-ui',
      'check:v2-ui-language',
      'check:v2-color-contrast',
      'check:v2-table-standard',
      'check:v2-loading-standard',
      'check:v2-module-architecture',
      'check:v2-isolation',
      'check:v2-decimal-standard'
    ]);
    for (const part of ['api', 'connector', 'migration', 'security'])
      assert.equal(affectsPart(part, changed), false, part);
  }
  const commands = adminCheckCommands('admin', paths);
  assert.ok(
    commands.some((args) => args.join(' ') === 'run test --workspace @apple-business/admin')
  );
  assert.ok(commands.some((args) => args.includes('acceptance:v2-auto-recharge')));
  for (const outside of [
    'apps/admin/src/v2-router-other.ts',
    'scripts/check-v2-input-retention-write.mjs',
    'scripts/check-v2-input-retention.mjs.backup',
    'scripts/check-v2-online-recharge-controls.mjs',
    'scripts/check-v2-online-recharge-controls.test.mjs.backup',
    'apps/admin/src/auth/login.ts',
    'apps/api/src/id-business-v2/auto-recharge/recharge.service.ts',
    'apps/api/src/id-business-v2/online-recharge/online-recharge.service.ts',
    'apps/api/prisma-mysql/schema.prisma',
    'apps/api/prisma-mysql/migrations/new/migration.sql',
    'packages/shared/src/v2/auto-recharge.ts',
    'package.json',
    'package-lock.json'
  ]) {
    assert.equal(isAdminOnly([...paths, outside]), false, outside);
    assert.equal(checkMode([...paths, outside], schema, schema), 'full', outside);
  }
});
test('workspace dock acceptance stays in exact admin scope and retains every shared UI guard', () => {
  const acceptance = 'scripts/acceptance-v2-workspace-dock.mjs';
  const paths = [
    acceptance,
    'apps/admin/src/v2/components/workspace/V2WorkspaceDock.vue',
    'apps/admin/src/v2/components/workspace/V2QuickActions.vue',
    'apps/admin/src/v2/layouts/V2AdminLayout.vue',
    'apps/admin/src/v2/styles/v2.css',
    'apps/admin/src/v2/testing/workspace-design-fixture.ts',
    'scripts/ci-recharge-scope.mjs',
    'scripts/ci-recharge-scope.test.mjs',
    'docs/V2_TASKS.md'
  ];
  for (const changed of [[acceptance], paths]) {
    assert.equal(isCiOnly(changed), false);
    assert.equal(isAdminOnly(changed), true);
    assert.equal(checkMode(changed, schema, schema), 'admin');
    assert.deepEqual(selectedParts(changed), ['guards', 'admin']);
    for (const part of ['api', 'connector', 'migration', 'security'])
      assert.equal(affectsPart(part, changed), false, part);
    for (const guard of [
      'check:admin-ui',
      'check:v2-ui-language',
      'check:v2-color-contrast',
      'check:v2-table-standard',
      'check:v2-loading-standard',
      'check:v2-module-architecture',
      'check:v2-isolation'
    ])
      assert.ok(adminUiGuardChecks('admin', changed).includes(guard), guard);
  }
  for (const outside of [
    'scripts/acceptance-v2-workspace-dock-other.mjs',
    'scripts/acceptance-v2-workspace-dock.mjs.backup',
    'scripts/acceptance-v2-workspace.mjs',
    'apps/api/src/id-business-v2/workspace/example.ts',
    'apps/admin/src/auth/login.ts',
    'apps/api/prisma-mysql/schema.prisma',
    'package-lock.json'
  ]) {
    assert.equal(checkMode([outside], schema, schema), 'full', outside);
    assert.equal(checkMode([...paths, outside], schema, schema), 'full', outside);
  }
});

test('workspace sources and acceptance script select one complete browser acceptance command', () => {
  const acceptance = 'scripts/acceptance-v2-workspace-dock.mjs';
  const sources = [
    acceptance,
    'apps/admin/src/v2/components/workspace/V2WorkspaceDock.vue',
    'apps/admin/src/v2/components/workspace/V2WorkspaceLauncher.vue',
    'apps/admin/src/v2/components/workspace/V2QuickActions.vue',
    'apps/admin/src/v2/components/workspace/V2QuickActionsDrawer.vue',
    'apps/admin/src/v2/components/workspace/useV2QuickActions.ts',
    'apps/admin/src/v2/layouts/V2AdminLayout.vue',
    ...['base', 'layout', 'records', 'v2'].map((name) => `apps/admin/src/v2/styles/${name}.css`),
    'apps/admin/src/v2/testing/V2WorkspaceDesignFixture.vue',
    'apps/admin/src/v2/testing/workspace-design-fixture.ts'
  ];
  for (const changed of [...sources.map((source) => [source]), sources]) {
    const selected = adminCheckCommands('admin', changed).filter((args) =>
      args.includes(acceptance)
    );
    assert.deepEqual(selected, [['exec', '--', 'node', acceptance]], changed.join(', '));
  }
  for (const unrelated of [
    'docs/V2_TASKS.md',
    'scripts/ci-recharge-scope.mjs',
    'apps/admin/src/v2/features/orders/Orders.vue',
    'apps/admin/src/v2/components/workspace-other/V2WorkspaceDock.vue',
    'apps/admin/src/v2/testing/workspace-design-fixture-other.ts',
    'apps/admin/src/v2/styles/v2.css.backup'
  ])
    assert.equal(
      adminCheckCommands('admin', [unrelated]).some((args) => args.includes(acceptance)),
      false,
      unrelated
    );
});

test('workspace-only PR and main CLI output require browser installation for admin acceptance', () => {
  for (const eventName of ['pull_request', 'push']) {
    const { result, writes } = recordScopeClassification(
      ['scripts/acceptance-v2-workspace-dock.mjs'],
      {},
      eventName
    );
    assert.equal(result.mode, 'admin');
    assert.deepEqual(result.checkParts, ['guards', 'admin']);
    assert.ok(writes.some(({ contents }) => /(?:^|\n)admin_acceptance=true\n/.test(contents)));
  }
  const unrelated = recordScopeClassification(
    ['apps/admin/src/v2/features/customers/V2CustomersView.vue'],
    {},
    'pull_request'
  );
  assert.ok(
    unrelated.writes.some(({ contents }) => /(?:^|\n)admin_acceptance=false\n/.test(contents))
  );
});

test('exact Vite acceptance runners preserve the existing joint Apple and recharge scope', () => {
  const runners = [
    'scripts/acceptance-v2-auto-recharge.mjs',
    'scripts/acceptance-v2-bank-recharge-ui.mjs',
    'scripts/lib/vite-cli.mjs'
  ];
  const business = [
    'apps/admin/src/v2/features/auto-registration/V2AppleMailboxes.vue',
    'apps/api/src/id-business-v2/auto-registration/apple-mailboxes.service.ts',
    'apps/api/src/id-business-v2/auto-recharge/worker/bitbrowser_connector.py'
  ];
  for (const path of runners) {
    assert.equal(
      checkMode([path], schema, schema),
      path.includes('auto-recharge') ? 'recharge' : 'admin'
    );
    assert.deepEqual(selectedParts([path]), ['guards', 'admin']);
    assert.equal(isCiOnly([path]), false);
    assert.equal(checkMode([...business, path], schema, schema), 'recharge');
    assert.deepEqual(selectedParts([...business, path]), ['guards', 'admin', 'api', 'connector']);
  }
  assert.equal(checkMode([...business, ...runners], schema, schema), 'recharge');
  for (const path of [
    'scripts/acceptance-v2-auto-recharge-other.mjs',
    'scripts/acceptance-v2-bank-recharge-ui-other.mjs',
    'scripts/lib/vite-cli-other.mjs',
    'scripts/lib/vite-cli.test.mjs',
    'scripts/lib/vite-cli.mjs.backup',
    'scripts/lib/unknown.mjs'
  ]) {
    assert.equal(checkMode([path], schema, schema), 'full', path);
    assert.equal(checkMode([...business, ...runners, path], schema, schema), 'full', path);
  }
});

test('Vendure mailbox integration runs only its shared, admin, API and guard checks', () => {
  const paths = [
    '.env.example',
    '.env.aws.production.example',
    'docker-compose.aws-mysql.yml',
    'apps/admin/src/api/requestPolicy.ts',
    'apps/admin/src/v2/features/auto-recharge/VendureMailboxManager.vue',
    'apps/api/src/id-business-v2/workspace/id-business-v2-vendure-mailbox.service.ts',
    'apps/api/src/id-business-v2/workspace/providers/id-business-v2-vendure-mailbox.client.ts',
    'packages/shared/src/v2/vendure-mailbox.ts',
    'docs/V2_VENDURE_MAILBOX_INTEGRATION.md',
    '.github/workflows/quality.yml',
    'scripts/ci-recharge-check.mjs',
    'scripts/ci-recharge-scope.mjs'
  ];
  assert.equal(isMailboxOnly(paths), true);
  assert.equal(checkMode(paths, schema, schema), 'mailbox');
  assert.deepEqual(adminCheckCommands('mailbox', paths), [
    ['run', 'build', '--workspace', '@apple-business/shared'],
    [
      'run',
      'test',
      '--workspace',
      '@apple-business/admin',
      '--',
      'src/api/requestPolicy.spec.ts',
      'src/v2/features/registry.spec.ts',
      'src/v2/features/auto-recharge/vendure-mailbox-ui.contract.spec.ts'
    ],
    ['run', 'build', '--workspace', '@apple-business/admin']
  ]);
  assert.equal(
    isMailboxOnly([...paths, 'apps/api/src/id-business-v2/orders/order.service.ts']),
    false
  );
});
test('CI-only repairs do not select application or migration suites', () => {
  assert.equal(
    isCiOnly(['.github/workflows/quality.yml', 'scripts/ci-recharge-evidence.mjs']),
    true
  );
  assert.equal(isCiOnly(['.github/workflows/quality.yml', files[0]]), false);
  assert.equal(isCiOnly([]), false);
});
test('immutable source evidence survives a cleared PR association and rejects mismatches', () => {
  const run = { id: 42, run_attempt: 1, pull_requests: [] };
  const pr = { number: 192, head: { sha: 'head' } };
  const proof = {
    repository: 'owner/repo',
    runId: 42,
    runAttempt: 1,
    pullRequest: 192,
    headSha: 'head',
    baseSha: 'a'.repeat(40),
    testedTree: 'tree'
  };
  const expected = { repo: 'owner/repo', run, pr, tree: 'tree' };
  assert.equal(matchesSourceEvidence(proof, expected), true);
  for (const change of [
    { repository: 'other/repo' },
    { runId: 43 },
    { runAttempt: 2 },
    { pullRequest: 191 },
    { headSha: 'other' },
    { testedTree: 'different' }
  ]) {
    assert.equal(matchesSourceEvidence({ ...proof, ...change }, expected), false);
  }
});
test('main reuse rejects a different tree or an incomplete required gate', () => {
  assert.equal(canReuseMain('tree', 'tree', [{ name: 'quality', conclusion: 'success' }]), true);
  assert.equal(canReuseMain('old', 'new', [{ name: 'quality', conclusion: 'success' }]), false);
  assert.equal(canReuseMain('tree', 'tree', [{ name: 'quality', conclusion: 'failure' }]), false);
  assert.equal(
    canReuseMain('tree', 'tree', [{ name: 'recharge (api)', conclusion: 'success' }]),
    false
  );
  assert.equal(canReuseMain('tree', 'tree', []), false);
});
test('recharge settings schema changes stay scoped but other model changes do not', () => {
  assert.equal(
    isRechargeOnly(files, schema, schema.replace('ownerId String', 'ownerId String extra Json?')),
    true
  );
  assert.equal(isRechargeOnly(files, schema, schema.replace('id String', 'id Int')), false);
  assert.equal(
    isRechargeOnly([...files, 'apps/api/src/auth/auth.service.ts'], schema, schema),
    false
  );
  assert.equal(
    isRechargeOnly(
      [...files, 'apps/api/prisma-mysql/migrations/other/migration.sql'],
      schema,
      schema
    ),
    false
  );
  assert.equal(isRechargeOnly([], schema, schema), false);
});
test('a frontend-only fix retains API and connector evidence', () => {
  const changed = [files[0]];
  assert.equal(affectsPart('guards', changed), true);
  assert.equal(affectsPart('admin', changed), true);
  for (const part of ['api', 'connector', 'migration'])
    assert.equal(affectsPart(part, changed), false);
  for (const part of ['guards', 'admin', 'api', 'connector', 'migration']) {
    assert.equal(affectsPart(part, ['.github/workflows/quality.yml']), true);
    assert.equal(affectsPart(part, ['scripts/ci-recharge-check.mjs']), true);
  }
});
test('evidence is bound to the same PR, source SHA and workflow', () => {
  const run = {
    event: 'pull_request',
    path: '.github/workflows/quality.yml',
    status: 'completed',
    head_sha: 'abc',
    pull_requests: [{ number: 191, head: { sha: 'abc' } }]
  };
  assert.equal(matchingRun(run, 191, 'abc'), true);
  assert.equal(matchingRun(run, 192, 'abc'), false);
  assert.equal(matchingRun(run, 191, 'def'), false);
  assert.equal(matchingRun({ ...run, event: 'push' }, 191, 'abc'), false);
  assert.equal(matchingRun({ ...run, path: 'other.yml' }, 191, 'abc'), false);
  assert.equal(matchingRun({ ...run, status: 'in_progress' }, 191, 'abc'), false);
  assert.equal(
    matchingRun(
      { ...run, pull_requests: [{ number: 191, head: { sha: 'later-head' } }] },
      191,
      'abc'
    ),
    true
  );
});

function recordImmutableTestedTree(run, proof, options = {}) {
  const script = `
    import childProcess from 'node:child_process';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const data = JSON.parse(process.env.IMMUTABLE_TREE_FIXTURE);
    const calls = [];
    const originalRead = fs.readFileSync;
    fs.readFileSync = (path, ...args) => String(path).endsWith('/evidence.json')
      ? (data.options.badJson ? '{' : JSON.stringify(data.proof)) : originalRead(path, ...args);
    childProcess.execFileSync = (file, args) => {
      calls.push({ file, args });
      if (file === 'gh' && args[0] === 'api') return JSON.stringify({ artifacts:
        data.options.missingArtifact ? [] : [{ name: 'quality-source-evidence-1', expired: !!data.options.expired }] });
      if (file === 'gh' && args[0] === 'run') {
        if (data.options.downloadFailure) throw new Error('Synthetic missing artifact bytes');
        return '';
      }
      if (file === 'git' && args[0] === 'cat-file') return '';
      if (file === 'git' && args[0] === 'merge-tree') return data.options.actualTree || data.proof.testedTree;
      throw new Error('Unexpected process');
    };
    syncBuiltinESMExports();
    const { testedTree } = await import('./scripts/ci-recharge-scope.mjs');
    const tree = testedTree(data.run, 460, 'owner/repo');
    process.stdout.write(JSON.stringify({ tree: tree ?? null, calls }));
  `;
  return JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, IMMUTABLE_TREE_FIXTURE: JSON.stringify({ run, proof, options }) }
    })
  );
}

const immutableRun = {
  id: 123,
  run_attempt: 1,
  event: 'pull_request',
  path: '.github/workflows/quality.yml',
  status: 'completed',
  head_sha: 'a'.repeat(40),
  pull_requests: [{ number: 460, head: { sha: 'd'.repeat(40) }, base: { sha: 'e'.repeat(40) } }]
};
const immutableProof = {
  repository: 'owner/repo',
  runId: 123,
  runAttempt: 1,
  pullRequest: 460,
  headSha: immutableRun.head_sha,
  baseSha: 'b'.repeat(40),
  testedTree: 'c'.repeat(40)
};

test('PR reuse reconstructs the exact immutable artifact tree after provider head and base updates', () => {
  const result = recordImmutableTestedTree(immutableRun, immutableProof);
  assert.equal(result.tree, immutableProof.testedTree);
  assert.deepEqual(
    result.calls.filter(({ file }) => file === 'git').map(({ args }) => args),
    [
      ['cat-file', '-e', immutableProof.baseSha],
      ['cat-file', '-e', immutableRun.head_sha],
      ['merge-tree', '--write-tree', immutableProof.baseSha, immutableRun.head_sha]
    ]
  );
  assert.deepEqual(result.calls.find(({ file, args }) => file === 'gh' && args[0] === 'run').args, [
    'run',
    'download',
    '123',
    '--repo',
    'owner/repo',
    '--name',
    'quality-source-evidence-1',
    '--dir',
    '.deploy/ci-source-evidence/123-1'
  ]);
});

test('PR reuse rejects wrong immutable repository run attempt PR head base and tree evidence', () => {
  for (const change of [
    { repository: 'other/repo' },
    { runId: 124 },
    { runAttempt: 2 },
    { pullRequest: 461 },
    { headSha: 'd'.repeat(40) },
    { baseSha: 'unknown' },
    { testedTree: 'unknown' }
  ]) {
    const result = recordImmutableTestedTree(immutableRun, { ...immutableProof, ...change });
    assert.equal(result.tree, null, JSON.stringify(change));
    assert.equal(
      result.calls.some(({ file }) => file === 'git'),
      false
    );
  }
  const wrongTree = recordImmutableTestedTree(immutableRun, immutableProof, {
    actualTree: 'f'.repeat(40)
  });
  assert.equal(wrongTree.tree, null);
});

test('PR reuse rejects missing expired malformed or unavailable artifacts without mutable fallback', () => {
  for (const options of [
    { missingArtifact: true },
    { expired: true },
    { badJson: true },
    { downloadFailure: true }
  ]) {
    const result = recordImmutableTestedTree(immutableRun, immutableProof, options);
    assert.equal(result.tree, null, JSON.stringify(options));
    assert.equal(
      result.calls.some(({ file }) => file === 'git'),
      false
    );
  }
  for (const change of [
    { id: '../other' },
    { run_attempt: 2 },
    { head_sha: 'invalid' },
    { pull_requests: [] },
    { pull_requests: [{ number: 461 }] }
  ])
    assert.equal(
      recordImmutableTestedTree({ ...immutableRun, ...change }, immutableProof).tree,
      null
    );
});

test('PR reuse CLI pins the job attempt and reruns only changed business source inputs', () => {
  const paths = [
    'apps/admin/src/v2/features/auto-recharge/useAutoRecharge.ts',
    'apps/api/src/id-business-v2/auto-recharge/recharge.service.ts',
    'apps/api/src/id-business-v2/auto-recharge/worker/pay.py'
  ];
  for (const [extra, expected] of [
    [[], ['admin', 'api', 'connector']],
    [['apps/admin/src/v2/features/auto-recharge/useAutoRecharge.ts'], ['api', 'connector']],
    [['apps/api/src/id-business-v2/auto-recharge/recharge.service.ts'], ['admin', 'connector']],
    [['apps/api/src/id-business-v2/auto-recharge/worker/pay.py'], ['admin', 'api']],
    [['packages/shared/src/v2/auto-recharge.ts'], ['connector']]
  ]) {
    const result = recordScopeClassification(paths, {}, 'pull_request', {
      historical: true,
      changed: ['scripts/ci-recharge-scope.mjs', ...extra]
    });
    assert.equal(result.result.mode, 'recharge');
    assert.deepEqual(result.result.checkParts, ['guards', 'admin', 'api', 'connector']);
    assert.deepEqual(result.result.reusedParts, expected);
    assert.deepEqual(
      result.apiCalls.filter((endpoint) => endpoint.endsWith('/jobs?per_page=100')),
      ['repos/fixture/id-business/actions/runs/123/attempts/1/jobs?per_page=100']
    );
    assert.ok(
      result.gitCalls.some(
        (args) => args.join(' ') === `merge-tree --write-tree ${'f'.repeat(40)} ${'a'.repeat(40)}`
      )
    );
  }
});

test('combined security and retry release selects affected modules without a migration run', () => {
  const changed = [
    'apps/api/src/auth/auth.service.ts',
    'apps/api/src/id-business-v2/auto-recharge/worker/bitbrowser_retry.py',
    'apps/api/src/id-business-v2/workspace/media-resolver/Dockerfile',
    'packages/shared/src/v2/auto-recharge.ts',
    '.github/workflows/quality.yml'
  ];
  assert.equal(isTargetedOnly(changed, schema, schema), true);
  assert.deepEqual(selectedParts(changed), ['guards', 'admin', 'api', 'connector', 'security']);
  assert.equal(
    isTargetedOnly([...changed, 'apps/api/src/auth/auth.controller.ts'], schema, schema),
    false
  );
  assert.equal(
    isTargetedOnly([...changed, 'apps/api/prisma-mysql/schema.prisma'], schema, schema),
    false
  );
  assert.deepEqual(selectedParts([files[0]]), ['guards', 'admin']);
});

test('CI selector and Python-only changes retain unrelated API and frontend checks', () => {
  const changed = [
    'scripts/ci-recharge-scope.mjs',
    'scripts/ci-recharge-python-image.mjs',
    'apps/api/src/id-business-v2/auto-recharge/worker/test_connector_health.py'
  ];
  assert.equal(affectsPart('api', changed), false);
  assert.equal(affectsPart('admin', changed), false);
  assert.equal(affectsPart('connector', changed), true);
});

test('combined BitBrowser orders and Apple scope retains every affected check without unrelated suites', () => {
  const changed = [
    'apps/admin/src/v2/components/V2Table.vue',
    'apps/admin/src/v2/features/auto-recharge/RechargeSensitiveInput.vue',
    'apps/admin/src/v2/features/auto-registration/V2AppleMailboxes.vue',
    'apps/admin/src/v2/features/customers/useCustomersPage.ts',
    'apps/admin/src/v2/features/tableSchemas.ts',
    'apps/admin/src/v2/styles/records.css',
    'apps/admin/src/v2/features/online-recharge/OnlineOrderBackfill.vue',
    'apps/api/src/id-business-v2/auto-recharge/bank-recharge-finance.service.ts',
    'apps/api/src/id-business-v2/auto-recharge/worker/bitbrowser_connector.py',
    'apps/api/src/id-business-v2/auto-registration/apple-mailboxes.service.ts',
    'apps/api/src/id-business-v2/auto-registration/worker/workspace.py',
    'scripts/acceptance-v2-auto-recharge.mjs',
    'scripts/acceptance-v2-bank-recharge-ui.mjs',
    'scripts/acceptance-v2-bit-orders-mysql.mjs',
    'scripts/acceptance-v2-table-layout.mjs',
    'scripts/production-release/api-admin-scope.py',
    'docs/V2_TASKS.md'
  ];
  assert.equal(hasAppleMailboxScope(changed), true);
  assert.equal(checkMode(changed, schema, schema), 'recharge');
  assert.deepEqual(selectedParts(changed), ['guards', 'admin', 'api', 'connector']);
  assert.deepEqual(adminCheckCommands('recharge', changed)[1], [
    'run',
    'test',
    '--workspace',
    '@apple-business/admin'
  ]);
  for (const name of [
    'check:admin-ui',
    'check:v2-ui-language',
    'check:v2-color-contrast',
    'check:v2-table-standard',
    'check:v2-loading-standard',
    'check:v2-module-architecture',
    'check:v2-isolation'
  ])
    assert.ok(adminUiGuardChecks('recharge', changed).includes(name), name);
  for (const path of [
    'apps/api/prisma-mysql/schema.prisma',
    'apps/api/prisma-mysql/migrations/unknown/migration.sql',
    'apps/api/src/id-business-v2/auto-registration/unknown.service.ts',
    'apps/api/src/id-business-v2/auto-registration/worker/requirements.lock.txt',
    'apps/api/src/id-business-v2/orders/order.service.ts',
    'apps/api/src/auth/auth.controller.ts',
    'package-lock.json'
  ])
    assert.equal(checkMode([...changed, path], schema, schema), 'full', path);
});

test('Apple worker-only scope selects API worker verification while frontend-only keeps existing admin scope', () => {
  const worker = 'apps/api/src/id-business-v2/auto-registration/worker/release_safety.py';
  assert.equal(checkMode([worker], schema, schema), 'recharge');
  assert.deepEqual(selectedParts([worker]), ['guards', 'api']);
  const frontend = 'apps/admin/src/v2/features/auto-registration/V2AppleMailboxes.vue';
  assert.equal(checkMode([frontend], schema, schema), 'admin');
  assert.deepEqual(selectedParts([frontend]), ['guards', 'admin']);
  for (const path of [worker + '.backup', worker.replace('release_safety', 'unknown')]) {
    assert.equal(hasAppleMailboxScope([path]), false);
    assert.equal(checkMode([path], schema, schema), 'full');
  }
});

test('reviewed table, employee connections and closed-loop mailbox batch keeps every affected scoped check', () => {
  const changed = [
    '.github/workflows/quality.yml',
    'scripts/ci-recharge-check.mjs',
    'apps/admin/src/v2/components/tableContentWidth.ts',
    'apps/admin/src/v2/composables/useV2TableContentWidths.ts',
    'apps/admin/src/v2/features/auto-recharge/useRechargeBrowserSettings.ts',
    'apps/admin/src/v2/features/auto-registration/V2AutoRegistrationView.vue',
    'apps/admin/src/v2/features/audit-logs/audit-change-labels.ts',
    'apps/admin/src/v2/features/audit-logs/audit-log-presentation.ts',
    'apps/api/src/id-business-v2/auto-recharge/recharge-connection-access.ts',
    'apps/api/src/id-business-v2/auto-recharge/bank-recharge-registration-mirror.service.ts',
    'apps/api/src/id-business-v2/auto-registration/apple-mailboxes-task-bridge.service.ts',
    'apps/api/src/id-business-v2/auto-registration/worker/apple_closed_loop.py',
    'apps/api/src/id-business-v2/auto-registration/worker/apple_registration_diagnostics.py',
    'apps/api/src/id-business-v2/auto-registration/worker/id-workspace.js',
    'apps/api/src/id-business-v2/auto-registration/worker/upload_compat.py',
    'scripts/fixtures/registration-closed-loop-worker.py',
    'scripts/acceptance-v2-recharge-employee-concurrency.mjs',
    'scripts/acceptance-v2-registration-mirror-mysql.mjs',
    'scripts/check-v2-table-standard.mjs',
    'scripts/acceptance-v2-table-layout.mjs',
    'packages/shared/src/v2/auto-recharge.ts',
    'apps/api/prisma-mysql/schema.prisma',
    rechargeConnectionProfileMigration,
    ...unpublishedComponentSuccessorControlPaths
  ];
  assert.equal(checkMode(changed, schema, connectionProfileSchema), 'recharge');
  assert.deepEqual(selectedParts(changed), [
    'guards',
    'admin',
    'api',
    'connector',
    'migration',
    'security'
  ]);
  for (const name of [
    'check:admin-ui',
    'check:v2-ui-language',
    'check:v2-color-contrast',
    'check:v2-table-standard',
    'check:v2-loading-standard',
    'check:v2-module-architecture',
    'check:v2-isolation'
  ])
    assert.ok(adminUiGuardChecks('recharge', changed).includes(name), name);
  assert.deepEqual(backendArchitectureGuardChecks('recharge', changed), [
    'check:v2-module-architecture',
    'check:v2-prisma-runtime-boundary',
    'check:v2-concurrency-standard'
  ]);
  for (const unknown of [
    'apps/api/src/id-business-v2/auto-registration/unknown.service.ts',
    'apps/api/src/id-business-v2/auto-registration/worker/apple_closed_loop.py.backup',
    'apps/api/src/id-business-v2/auto-registration/worker/upstream/src/core/register.py',
    'apps/api/prisma-mysql/migrations/unknown/migration.sql',
    'scripts/fixtures/registration-closed-loop-worker-other.py',
    'scripts/acceptance-v2-registration-mirror-mysql-other.mjs',
    'apps/api/src/id-business-v2/orders/order.service.ts',
    'package-lock.json'
  ])
    assert.equal(
      checkMode([...changed, unknown], schema, connectionProfileSchema),
      'full',
      unknown
    );
  for (const driftedSchema of [
    connectionProfileSchema.replace('configuration Json', 'configuration String'),
    connectionProfileSchema.replace('id String', 'id Int'),
    connectionProfileModel + '\n\n' + connectionProfileSchema,
    connectionProfileSchema + 'model Foreign { id String }\n'
  ])
    assert.equal(checkMode(changed, schema, driftedSchema), 'full');
  assert.equal(
    checkMode(
      changed.filter((path) => path !== rechargeConnectionProfileMigration),
      schema,
      connectionProfileSchema
    ),
    'full'
  );
});

test('employee connection schema proof works without a mailbox change and rejects unrelated models', () => {
  const changed = [
    'apps/admin/src/v2/components/V2Table.vue',
    'apps/api/src/id-business-v2/auto-recharge/recharge-connection-access.ts',
    'apps/api/prisma-mysql/schema.prisma',
    rechargeConnectionProfileMigration,
    'scripts/acceptance-v2-recharge-employee-concurrency.mjs'
  ];
  assert.equal(checkMode(changed, schema, connectionProfileSchema), 'recharge');
  assert.equal(isRechargeOnly(changed, schema, connectionProfileSchema), true);
  assert.equal(
    checkMode(changed, schema, connectionProfileSchema.replace('id String', 'id Int')),
    'full'
  );
  assert.equal(checkMode(changed, undefined, connectionProfileSchema), 'full');
  assert.equal(checkMode(changed, schema, undefined), 'full');
  assert.equal(checkMode(changed, connectionProfileSchema, connectionProfileSchema), 'full');
});

test('finite unpublished successor controls do not admit adjacent scripts or business files', () => {
  for (const path of [
    ...unpublishedComponentSuccessorControlPaths,
    ...ownedMysqlTestControlPaths
  ]) {
    assert.equal(isCiOnly([path]), true);
    assert.equal(checkMode([path], schema, schema), 'ci-only');
  }
  for (const unknown of [
    'scripts/production-release/unpublished-component-successor.py.backup',
    'scripts/production-release/unpublished-component-successor-other.py',
    'scripts/production-release/unpublished-component-successor-readonly-other.py',
    'scripts/production-release/unpublished-component-runtime-diagnostic.py.backup',
    'scripts/production-release/unpublished-component-runtime-diagnostic-other.py',
    'scripts/lib/owned-mysql-test-instance.mjs.backup',
    'scripts/lib/owned-mysql-test-instance-other.mjs',
    'apps/api/src/id-business-v2/auto-registration/unknown.service.ts'
  ])
    assert.equal(
      checkMode([...unpublishedComponentSuccessorControlPaths, unknown], schema, schema),
      'full'
    );
});

test('recharge flow release controls remain finite and do not expand to adjacent controls or business', () => {
  for (const path of rechargeFlowSuccessorControlPaths) {
    assert.equal(isCiOnly([path]), true);
    assert.equal(checkMode([path], schema, schema), 'ci-only');
  }
  for (const path of [
    'scripts/production-release/recharge-flow-successor.py.backup',
    'scripts/production-release/recharge-flow-successor-other.py',
    'scripts/production-release/recharge-flow-successor-contract-other.json',
    'apps/api/src/id-business-v2/auto-registration/unknown.service.ts'
  ])
    assert.equal(checkMode([...rechargeFlowSuccessorControlPaths, path], schema, schema), 'full');
});

test('reviewed dispatcher bytes reuse only unchanged Admin/API business evidence, never connector checks', () => {
  const path = 'scripts/ci-recharge-check.mjs';
  const snapshot = {
    before: execFileSync('git', ['show', `bcd67c4dfe3944aa6c0498699a619395f04ed296:${path}`], {
      cwd: root,
      encoding: 'utf8'
    }),
    after: execFileSync('git', ['show', `957afa4e7d9c776b0109bf7f217150fd3c545e04:${path}`], {
      cwd: root,
      encoding: 'utf8'
    }),
    beforeMode: '100644',
    afterMode: '100644'
  };
  const changed = [path, ...rechargeFlowSuccessorControlPaths];
  for (const part of ['admin', 'api']) {
    assert.equal(hasRechargeFlowBusinessReuseProof(part, changed, snapshot), true);
    assert.equal(
      hasRechargeFlowBusinessReuseProof(part, changed, {
        ...snapshot,
        after: readFileSync(new URL('./ci-recharge-check.mjs', import.meta.url), 'utf8')
      }),
      false
    );
    for (const patch of [
      { before: snapshot.before + 'drift' },
      { after: snapshot.after + 'drift' },
      { beforeMode: '100755' },
      { afterMode: '100755' }
    ])
      assert.equal(
        hasRechargeFlowBusinessReuseProof(part, changed, { ...snapshot, ...patch }),
        false
      );
    assert.equal(hasRechargeFlowBusinessReuseProof(part, changed, undefined), false);
    assert.equal(
      hasRechargeFlowBusinessReuseProof(
        part,
        [...changed, '.github/workflows/quality.yml'],
        snapshot
      ),
      false
    );
    assert.equal(
      hasRechargeFlowBusinessReuseProof(
        part,
        [...changed, 'packages/shared/src/v2/auto-recharge.ts'],
        snapshot
      ),
      false
    );
  }
  for (const part of ['guards', 'connector', 'migration', 'security'])
    assert.equal(hasRechargeFlowBusinessReuseProof(part, changed, snapshot), false);
  assert.equal(
    hasRechargeFlowBusinessReuseProof(
      'admin',
      [...changed, 'apps/admin/src/v2/features/auto-recharge/api.ts'],
      snapshot
    ),
    false
  );
  assert.equal(
    hasRechargeFlowBusinessReuseProof(
      'api',
      [...changed, 'apps/api/src/id-business-v2/auto-recharge/recharge.service.ts'],
      snapshot
    ),
    false
  );
});

test('mirror and employee MySQL acceptance inputs select migration without a schema edit', () => {
  for (const path of [
    'apps/api/src/id-business-v2/auto-recharge/bank-recharge-registration-mirror.service.ts',
    'scripts/acceptance-v2-registration-mirror-mysql.mjs',
    'scripts/acceptance-v2-recharge-employee-concurrency.mjs'
  ]) {
    assert.equal(checkMode([path], schema, schema), 'recharge');
    assert.deepEqual(
      selectedParts([path]),
      path.startsWith('apps/api/') ? ['guards', 'api', 'migration'] : ['guards', 'migration']
    );
    assert.equal(affectsPart('migration', [path]), true);
  }
  for (const path of ownedMysqlTestControlPaths)
    assert.equal(affectsPart('migration', [path]), true);
});

test('image reuse requires unchanged complete inputs of that service', () => {
  assert.equal(
    imageInputsChanged('media-resolver', [
      'apps/api/src/id-business-v2/auto-recharge/worker/test_connector_health.py'
    ]),
    false
  );
  assert.equal(
    imageInputsChanged('auto-recharge', [
      'apps/api/src/id-business-v2/auto-recharge/worker/test_connector_health.py'
    ]),
    true
  );
  for (const service of ['media-resolver', 'auto-recharge']) {
    assert.equal(imageInputsChanged(service, ['scripts/audit-python-dependencies.py']), true);
    assert.equal(imageInputsChanged(service, ['docs/V2_TASKS.md']), false);
  }
});

test('keeps shared layout changes in the admin release and runs both layout regressions', () => {
  const paths = [
    'apps/admin/src/v2/components/V2ListToolbar.vue',
    'apps/admin/layout-contract-fixture.html',
    'scripts/admin-layout-rules.mjs',
    'scripts/admin-layout-rules.test.mjs',
    'scripts/check-admin-ui-guardrails.mjs',
    'scripts/acceptance-v2-filter-layout.mjs',
    'scripts/acceptance-v2-page-layout.mjs'
  ];
  assert.equal(isAdminOnly(paths), true);
  assert.equal(isAdminOnly([...paths, 'apps/api/src/id-business-v2/finance/example.ts']), false);
  const commands = adminCheckCommands('admin', paths).map((args) => args.join(' '));
  assert.ok(
    commands.some((command) => command.includes('scripts/acceptance-v2-filter-layout.mjs'))
  );
  assert.ok(commands.some((command) => command.includes('scripts/acceptance-v2-page-layout.mjs')));
});

test('recharge diagnostics adds only its exact reviewed historical policy path', () => {
  const path = 'deploy/aws/historical-finance-20261005-recharge-diagnostics.json';
  assert.equal(isCiOnly([path]), true);
  assert.equal(checkMode([path], schema, schema), 'ci-only');
  assert.deepEqual(selectedParts([path]), ['guards']);
  const candidate = [
    path,
    'apps/api/src/id-business-v2/auto-recharge/worker/plan_selection.py',
    'apps/api/src/id-business-v2/auto-recharge/worker/test_pro.py',
    'scripts/ci-recharge-check.mjs',
    'scripts/lib/v2-release-history-policy.mjs',
    'scripts/v2-release-history-policy.test.mjs',
    'scripts/production-release/dispatch.sh'
  ];
  assert.equal(checkMode(candidate, schema, schema), 'recharge');
  assert.deepEqual(selectedParts(candidate), ['guards', 'admin', 'api', 'connector']);
  for (const unreviewed of [
    'deploy/aws/historical-finance-20261005-recharge-diagnostics-other.json',
    'deploy/aws/historical-finance-20261005-recharge-diagnostics.json.backup',
    'deploy/aws/historical-finance-20261005-recharge-diagnostics/future.json',
    'deploy/aws/historical-finance-20261005.json',
    'deploy/aws/historical-finance-unreviewed.json'
  ]) {
    assert.equal(isCiOnly([unreviewed]), false, unreviewed);
    assert.equal(checkMode([unreviewed], schema, schema), 'full', unreviewed);
    assert.equal(checkMode([...candidate, unreviewed], schema, schema), 'full', unreviewed);
  }
});

test('maintenance continuation control is exact and preserves full compatibility checks', () => {
  const policy = 'deploy/aws/historical-finance-20261005-maintenance-continuation.json';
  for (const path of [
    policy,
    'scripts/lib/v2-release-maintenance-policy.mjs',
    'scripts/v2-release-maintenance-audit.mjs',
    'scripts/v2-release-maintenance-policy.test.mjs'
  ]) {
    assert.equal(checkMode([path], schema, schema), 'ci-only');
    assert.deepEqual(selectedParts([path]), ['guards']);
  }
  for (const path of [
    policy + '.backup',
    'scripts/lib/v2-release-maintenance-policy-other.mjs',
    'scripts/v2-release-maintenance-audit-other.mjs',
    'scripts/v2-release-maintenance-policy-other.test.mjs',
    'deploy/aws/historical-finance-20261005-maintenance-continuation-other.json',
    'scripts/lib/v2-data-integrity-audit.mjs',
    'scripts/v2-data-integrity-audit.test.mjs',
    'scripts/aws-mysql-backup.test.mjs'
  ]) {
    assert.equal(isCiOnly([path]), false, path);
    assert.equal(checkMode([policy, path], schema, schema), 'full', path);
  }
});

test('fixed b8 runtime scope uses one exact control path without business checks', () => {
  const path = 'deploy/aws/recharge-pro-menu-b8-20261005.json';
  assert.equal(isCiOnly([path]), true);
  assert.equal(checkMode([path], schema, schema), 'ci-only');
  assert.deepEqual(selectedParts([path]), ['guards']);
  const worker = 'apps/api/src/id-business-v2/auto-recharge/worker/plan_selection.py';
  assert.deepEqual(selectedParts([path, worker]), ['guards', 'connector']);
  for (const other of [
    'deploy/aws/recharge-pro-menu-b8-20261006.json',
    'deploy/aws/recharge-pro-menu-b8-20261005.json.backup',
    'deploy/aws/recharge-pro-menu-unapproved.json'
  ]) {
    assert.equal(isCiOnly([other]), false, other);
    assert.equal(checkMode([other], schema, schema), 'full', other);
  }
});

test('fixed 7f runtime scope is exact and retains worker checks', () => {
  const path = 'deploy/aws/recharge-pro-menu-7f-20261005.json';
  assert.equal(isCiOnly([path]), true);
  assert.equal(checkMode([path], schema, schema), 'ci-only');
  assert.deepEqual(selectedParts([path]), ['guards']);
  const worker = 'apps/api/src/id-business-v2/auto-recharge/worker/plan_selection.py';
  assert.deepEqual(selectedParts([path, worker]), ['guards', 'connector']);
  for (const other of [
    'deploy/aws/recharge-pro-menu-7f-20261006.json',
    path + '.backup',
    path + '/future.json',
    'deploy/aws/recharge-pro-menu-other-20261005.json'
  ]) {
    assert.equal(isCiOnly([other]), false, other);
    assert.equal(checkMode([path, other], schema, schema), 'full', other);
  }
});

test('fixed main80 recharge profile remains an exact control path and keeps Pro business checks', () => {
  const path = 'deploy/aws/recharge-pro-main80-20261006.json';
  assert.equal(isCiOnly([path]), true);
  assert.equal(checkMode([path], schema, schema), 'ci-only');
  assert.deepEqual(selectedParts([path]), ['guards']);
  for (const worker of ['plan_selection.py', 'test_pro.py']) {
    const changed = `apps/api/src/id-business-v2/auto-recharge/worker/${worker}`;
    assert.equal(checkMode([path, changed], schema, schema), 'recharge');
    assert.deepEqual(selectedParts([path, changed]), ['guards', 'connector']);
  }
  for (const other of [
    'deploy/aws/recharge-pro-main80-20261007.json',
    path + '.backup',
    path + '/future.json',
    'deploy/aws/recharge-pro-main81-20261006.json'
  ]) {
    assert.equal(isCiOnly([other]), false, other);
    assert.equal(checkMode([path, other], schema, schema), 'full', other);
  }
});

test('fixed registration 80, 956 and 85 controls retain worker checks and reject other baselines', () => {
  const profile = 'deploy/aws/registration-worker-b8-80-20261006.json';
  const continuation = 'deploy/aws/registration-worker-956-20261006.json';
  const initial = 'deploy/aws/registration-worker-85-20261006.json';
  const email = 'deploy/aws/registration-worker-86-20261006.json';
  const callback = 'deploy/aws/registration-worker-87-20261006.json';
  const emailRequest = 'deploy/aws/registration-worker-88-20261006.json';
  const emailObservation = 'deploy/aws/registration-worker-89-20261006.json';
  const transport = 'scripts/production-release/registration-only-transport.test.py';
  const auditors = [
    'scripts/v2-registration-finance-audit.mjs',
    'scripts/v2-registration-finance-audit.test.mjs'
  ];
  assert.equal(isCiOnly([profile, transport, ...auditors]), true);
  assert.equal(checkMode([profile, transport, ...auditors], schema, schema), 'ci-only');
  assert.deepEqual(selectedParts([profile, transport, ...auditors]), ['guards']);
  const worker = 'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py';
  assert.deepEqual(selectedParts([profile, worker]), ['guards', 'connector']);
  assert.equal(isCiOnly([continuation]), true);
  assert.equal(checkMode([continuation], schema, schema), 'ci-only');
  assert.deepEqual(selectedParts([continuation]), ['guards']);
  assert.deepEqual(selectedParts([continuation, worker]), ['guards', 'connector']);
  assert.equal(isCiOnly([initial]), true);
  assert.equal(checkMode([initial], schema, schema), 'ci-only');
  assert.deepEqual(selectedParts([initial]), ['guards']);
  assert.deepEqual(selectedParts([initial, worker]), ['guards', 'connector']);
  assert.equal(isCiOnly([email]), true);
  assert.equal(checkMode([email], schema, schema), 'ci-only');
  assert.deepEqual(selectedParts([email]), ['guards']);
  assert.deepEqual(selectedParts([email, worker]), ['guards', 'connector']);
  const autoCodeTest =
    'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_auto_code.py';
  assert.deepEqual(selectedParts([email, autoCodeTest]), ['guards', 'connector']);
  assert.equal(isCiOnly([callback]), true);
  assert.equal(checkMode([callback], schema, schema), 'ci-only');
  assert.deepEqual(selectedParts([callback]), ['guards']);
  assert.equal(isCiOnly([emailRequest]), true);
  assert.equal(checkMode([emailRequest], schema, schema), 'ci-only');
  assert.deepEqual(selectedParts([emailRequest]), ['guards']);
  assert.equal(isCiOnly([emailObservation]), true);
  assert.equal(checkMode([emailObservation], schema, schema), 'ci-only');
  assert.deepEqual(selectedParts([emailObservation]), ['guards']);
  for (const path of ['registration_browser.py', 'test_registration_browser.py'])
    assert.deepEqual(
      selectedParts([emailObservation, 'apps/api/src/id-business-v2/auto-recharge/worker/' + path]),
      ['guards', 'connector']
    );
  for (const path of ['registration_browser.py', 'test_registration_browser.py'])
    assert.deepEqual(
      selectedParts([emailRequest, 'apps/api/src/id-business-v2/auto-recharge/worker/' + path]),
      ['guards', 'connector']
    );
  for (const path of ['registration_job.py', 'test_registration.py'])
    assert.deepEqual(
      selectedParts([callback, 'apps/api/src/id-business-v2/auto-recharge/worker/' + path]),
      ['guards', 'connector']
    );
  for (const other of [
    'deploy/aws/registration-worker-b8-3ca-20261006.json',
    profile + '.backup',
    profile + '/future.json',
    'deploy/aws/registration-worker-b8-80-other.json',
    'deploy/aws/registration-worker-956-20261007.json',
    continuation + '.backup',
    'deploy/aws/registration-worker-85-20261007.json',
    initial + '.backup',
    'deploy/aws/registration-worker-86-20261007.json',
    email + '.backup',
    'deploy/aws/registration-worker-87-20261007.json',
    callback + '.backup',
    'deploy/aws/registration-worker-88-20261007.json',
    emailRequest + '.backup',
    'deploy/aws/registration-worker-89-20261007.json',
    emailObservation + '.backup',
    'scripts/production-release/registration-only-other.test.py',
    'scripts/v2-registration-finance-audit-other.mjs',
    'scripts/v2-registration-finance-audit.mjs.backup',
    'apps/api/prisma-mysql/schema.prisma',
    'package-lock.json'
  ]) {
    assert.equal(isCiOnly([other]), false, other);
    assert.equal(checkMode([profile, other], schema, schema), 'full', other);
  }
});

test('fixed 91 profile observation CI accepts only two Worker files and reviewed controls', () => {
  const profile = 'deploy/aws/registration-worker-91-20261007.json';
  const worker = 'apps/api/src/id-business-v2/auto-recharge/worker/';
  const sources = [worker + 'registration_browser.py', worker + 'test_registration_browser.py'];
  const controls = [
    profile,
    '.github/workflows/production-release.yml',
    'scripts/production-release/build-images.sh',
    'scripts/production-release/push-images.sh',
    'scripts/production-release/dispatch.sh',
    'scripts/production-release/validate-release-selection.sh',
    'scripts/production-release/remote-deploy.py',
    'scripts/production-release/remote-deploy.test.py',
    'scripts/production-release/registration-only-transport.test.py',
    'scripts/ci-recharge-scope.mjs',
    'scripts/ci-recharge-check.mjs',
    'scripts/ci-recharge-release.test.mjs',
    'scripts/ci-recharge-scope.test.mjs',
    'scripts/v2-registration-finance-audit.mjs',
    'scripts/v2-registration-finance-audit.test.mjs',
    'docs/AUTO_REGISTRATION.md',
    'docs/PRODUCTION_RELEASE_OIDC.md',
    'docs/V2_TASKS.md'
  ];
  assert.equal(isCiOnly([profile]), true);
  assert.equal(checkMode(controls), 'ci-only');
  assert.deepEqual(selectedParts(controls), ['guards']);
  for (const inputs of [sources, sources.slice(0, 1), sources.slice(1)]) {
    const paths = [...controls, ...inputs];
    assert.equal(checkMode(paths), 'recharge');
    assert.equal(isRechargeOnly(paths), true);
    assert.deepEqual(selectedParts(paths), ['guards', 'connector']);
    assert.deepEqual(adminUiGuardChecks('recharge', paths), []);
  }
  for (const extra of [
    worker + 'test_registration_auto_code.py',
    worker + 'registration_job.py',
    worker + 'plan_selection.py',
    worker + 'test_pro.py',
    worker + 'Dockerfile',
    'apps/api/src/auth/auth.service.ts',
    'apps/api/src/id-business-v2/auto-recharge/id-business-v2-auto-recharge.service.ts',
    'apps/api/prisma-mysql/schema.prisma',
    'apps/admin/src/api/requestPolicy.ts',
    'apps/admin/src/v2/features/auto-registration/useRegistrationStart.ts',
    'deploy/aws/registration-worker-90-20261007.json',
    'deploy/aws/recharge-pro-main80-20261006.json',
    'scripts/production-release/reuse-images.py',
    'scripts/production-release/maintain-image-cache.py',
    'scripts/production-release/unreviewed.py',
    'scripts/ci-recharge-unreviewed.mjs',
    'docker-compose.aws-mysql.yml',
    'package-lock.json'
  ]) {
    const paths = [...controls, ...sources, extra];
    assert.equal(checkMode(paths), 'full', extra);
    assert.equal(isRechargeOnly(paths), false, extra);
    assert.equal(isTargetedOnly(paths), false, extra);
    assert.equal(checkMode([profile, extra]), 'full', extra);
    assert.equal(isCiOnly([profile, extra]), false, extra);
  }
});

test('fixed 974 recharge profile and twelve controls stay exact without weakening worker checks', () => {
  const profile = 'deploy/aws/recharge-pro-974-20261007.json';
  const controls = [
    '.github/workflows/production-release.yml',
    'scripts/production-release/build-images.sh',
    'scripts/production-release/push-images.sh',
    'scripts/production-release/dispatch.sh',
    'scripts/production-release/validate-release-selection.sh',
    'scripts/production-release/remote-deploy.py',
    'scripts/production-release/remote-deploy.test.py',
    'scripts/ci-recharge-release.test.mjs',
    'scripts/ci-recharge-scope.mjs',
    'scripts/ci-recharge-scope.test.mjs',
    'scripts/ci-recharge-check.mjs',
    'docs/PRODUCTION_RELEASE_OIDC.md'
  ];
  assert.equal(checkMode([profile, ...controls], schema, schema), 'ci-only');
  assert.deepEqual(selectedParts([profile]), ['guards']);
  // The existing shared CI command path retains all module evidence; ci-only mode selects control execution.
  assert.deepEqual(selectedParts([profile, ...controls]), ['guards', 'admin', 'api', 'connector']);
  const workers = [
    'plan_selection.py',
    'server.py',
    'test_pro.py',
    'test_server.py',
    'test_worker_isolation.py'
  ].map((name) => `apps/api/src/id-business-v2/auto-recharge/worker/${name}`);
  for (const path of workers) {
    assert.equal(checkMode([profile, path], schema, schema), 'recharge', path);
    assert.deepEqual(selectedParts([profile, path]), ['guards', 'connector'], path);
  }
  assert.equal(
    checkMode([profile, ...controls, ...workers, 'docs/V2_TASKS.md'], schema, schema),
    'recharge'
  );
  assert.deepEqual(selectedParts([profile, ...workers, 'docs/V2_TASKS.md']), [
    'guards',
    'connector'
  ]);
  for (const wrong of [
    'deploy/aws/recharge-pro-974-20261008.json',
    'deploy/aws/recharge-pro-c4-20261007.json',
    profile + '.backup',
    profile + '/future.json',
    'deploy/aws/../aws/recharge-pro-974-20261007.json'
  ]) {
    assert.equal(isCiOnly([wrong]), false, wrong);
    assert.equal(checkMode([profile, wrong], schema, schema), 'full', wrong);
  }
});

test('fixed92 accepts only four API files, three Worker files, owned tests and exact controls', () => {
  const profile = 'deploy/aws/registration-worker-92-20261007.json';
  const api = 'apps/api/src/id-business-v2/auto-registration/registration-validation.ts';
  const worker = 'apps/api/src/id-business-v2/auto-recharge/worker/registration_job.py';
  const controls = [
    profile,
    'scripts/production-release/remote-deploy.py',
    'docs/AUTO_REGISTRATION.md',
    'docs/V2_TASKS.md'
  ];
  assert.equal(checkMode(controls, schema, schema), 'ci-only');
  assert.deepEqual(selectedParts(controls), ['guards']);
  assert.equal(checkMode([...controls, api, worker], schema, schema), 'recharge');
  assert.deepEqual(selectedParts([...controls, api, worker]), ['guards', 'api', 'connector']);
  assert.deepEqual(adminUiGuardChecks('recharge', [...controls, api, worker]), []);
  assert.deepEqual(selectedParts([...controls, api]), ['guards', 'api']);
  assert.deepEqual(selectedParts([...controls, worker]), ['guards', 'connector']);
  for (const foreign of [
    'apps/api/src/id-business-v2/auto-recharge/worker/server.py',
    'apps/api/src/id-business-v2/auto-recharge/worker/plan_selection.py',
    'apps/api/prisma-mysql/schema.prisma',
    'package-lock.json',
    'apps/api/src/auth/auth.service.ts',
    'apps/admin/src/v2/features/orders/Orders.vue',
    'deploy/aws/registration-worker-91-20261007.json',
    'docs/UNREVIEWED.md'
  ]) {
    assert.equal(checkMode([...controls, api, worker, foreign], schema, schema), 'full', foreign);
    assert.equal(isCiOnly([...controls, foreign]), false, foreign);
  }
});

test('shared button skin and exact skin controls stay frontend only without omitting UI guards', () => {
  const paths = [
    'apps/admin/src/components/ui/AppButton.vue',
    'apps/admin/src/v2/styles/base.css',
    'scripts/admin-skin-rules.mjs',
    'scripts/admin-skin-rules.test.mjs',
    'scripts/check-v2-color-contrast.mjs',
    'scripts/acceptance-v2-color-contrast.mjs',
    'scripts/acceptance-v2-skin-consistency.mjs',
    'scripts/acceptance-v2-business-skin.mjs',
    'scripts/ci-recharge-check.mjs',
    'docs/UI_DESIGN.md'
  ];
  assert.equal(checkMode(paths, schema, schema), 'admin');
  assert.deepEqual(selectedParts(paths.filter((path) => !isCiOnly([path]))), ['guards', 'admin']);
  const required = [
    'check:admin-ui',
    'check:v2-ui-language',
    'check:v2-color-contrast',
    'check:v2-table-standard',
    'check:v2-loading-standard',
    'check:v2-module-architecture',
    'check:v2-isolation'
  ];
  for (const guard of required) assert.ok(adminUiGuardChecks('admin', paths).includes(guard));
  for (const other of [
    'apps/api/src/id-business-v2/finance/finance.ts',
    'apps/admin/src/auth/login.ts',
    'apps/admin/src/components/ui/PermissionGate.vue',
    'scripts/admin-skin-rules-unknown.mjs',
    'packages/shared/src/v2/finance.ts',
    'package-lock.json',
    'package.json',
    'apps/api/prisma-mysql/migrations/new/migration.sql'
  ])
    assert.equal(checkMode([...paths, other], schema, schema), 'full', other);
});

test('explicit API Admin controls stay in control-only CI', () => {
  for (const path of [
    'scripts/production-release/api-admin-scope.py',
    'scripts/production-release/api-admin-readonly.py',
    'scripts/production-release/api-admin-scope.test.py'
  ]) {
    assert.equal(isCiOnly([path]), true);
    assert.equal(checkMode([path], schema, schema), 'ci-only');
    assert.deepEqual(selectedParts([path]), ['guards']);
  }
});

test('fixed93 permits only two registration browser files and exact new release controls', () => {
  const profile = 'deploy/aws/registration-worker-93-20261007.json';
  const browser = 'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py';
  const unit = 'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py';
  const controls = [
    profile,
    'scripts/production-release/remote-deploy.py',
    'scripts/production-release/maintain-image-cache.py'
  ];
  assert.equal(checkMode(controls, schema, schema), 'ci-only');
  assert.deepEqual(selectedParts(controls), ['guards']);
  assert.equal(checkMode([...controls, browser, unit], schema, schema), 'recharge');
  assert.deepEqual(selectedParts([...controls, browser, unit]), ['guards', 'connector']);
  for (const foreign of [
    'apps/api/src/id-business-v2/auto-registration/registration-worker.ts',
    'apps/api/src/id-business-v2/auto-recharge/worker/server.py',
    'apps/api/src/id-business-v2/auto-recharge/worker/Dockerfile',
    'package-lock.json',
    'apps/api/prisma-mysql/schema.prisma',
    'deploy/aws/registration-worker-92-20261007.json',
    'docs/UNREVIEWED.md'
  ]) {
    assert.equal(checkMode([...controls, browser, foreign], schema, schema), 'full', foreign);
    assert.equal(isCiOnly([...controls, foreign]), false, foreign);
  }
});

test('fixed94 control-only runtime followup never widens unchanged Worker or API checks', () => {
  const profile = 'deploy/aws/registration-worker-94-20261007.json';
  const controls = [
    profile,
    'scripts/production-release/remote-deploy.py',
    'scripts/production-release/api-admin-scope.py',
    'scripts/production-release/api-admin-scope.test.py',
    'scripts/production-release/maintain-image-cache.py',
    'scripts/ci-recharge-release.test.mjs'
  ];
  assert.equal(checkMode(controls, schema, schema), 'ci-only');
  assert.equal(isCiOnly(controls), true);
  assert.deepEqual(selectedParts(controls), ['guards']);
  for (const foreign of [
    'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py',
    'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py',
    'apps/api/src/id-business-v2/auto-registration/registration-worker.ts',
    'deploy/aws/registration-worker-93-20261007.json',
    'deploy/aws/recharge-pro-2f-20261007.json',
    'deploy/aws/recharge-pro-815-20261007.json',
    'deploy/aws/recharge-pro-4c-20261008.json',
    'package-lock.json',
    'apps/api/prisma-mysql/schema.prisma',
    'docs/UNREVIEWED.md',
    'scripts/production-release/api-admin-readonly.py'
  ]) {
    assert.equal(checkMode([...controls, foreign], schema, schema), 'full', foreign);
    assert.equal(isCiOnly([...controls, foreign]), false, foreign);
  }
});

test('fixed95 control-only interstitial never widens unchanged Worker or API checks', () => {
  const profile = 'deploy/aws/registration-worker-95-20261008.json';
  const controls = [
    profile,
    'scripts/production-release/remote-deploy.py',
    'scripts/production-release/api-admin-scope.py',
    'scripts/production-release/api-admin-scope.test.py',
    'scripts/production-release/maintain-image-cache.py',
    'scripts/ci-recharge-release.test.mjs'
  ];
  assert.equal(checkMode(controls, schema, schema), 'ci-only');
  assert.equal(isCiOnly(controls), true);
  assert.deepEqual(selectedParts(controls), ['guards']);
  for (const foreign of [
    'apps/api/src/id-business-v2/auto-registration/registration-worker.ts',
    'deploy/aws/registration-worker-93-20261007.json',
    'deploy/aws/registration-worker-94-20261007.json',
    'deploy/aws/recharge-pro-2f-20261007.json',
    'package-lock.json',
    'apps/api/prisma-mysql/schema.prisma',
    'docs/UNREVIEWED.md',
    'scripts/production-release/api-admin-readonly.py'
  ]) {
    assert.equal(checkMode([...controls, foreign], schema, schema), 'full', foreign);
    assert.equal(isCiOnly([...controls, foreign]), false, foreign);
  }
});

test('fixed95 exact browser pair selects only guards connector and rejects other runtime sources', () => {
  const controls = [
    'deploy/aws/registration-worker-95-20261008.json',
    'scripts/production-release/remote-deploy.py'
  ];
  for (const file of ['registration_browser.py', 'test_registration_browser.py']) {
    const paths = [...controls, 'apps/api/src/id-business-v2/auto-recharge/worker/' + file];
    assert.equal(checkMode(paths, schema, schema), 'recharge');
    assert.equal(isCiOnly(paths), false);
    assert.equal(isRechargeOnly(paths, schema, schema), true);
    assert.deepEqual(selectedParts(paths), ['guards', 'connector']);
  }
  for (const file of ['server.py', 'registration_builtin.py', 'plan_selection.py', 'Dockerfile']) {
    const paths = [...controls, 'apps/api/src/id-business-v2/auto-recharge/worker/' + file];
    assert.equal(checkMode(paths, schema, schema), 'full');
    assert.equal(isRechargeOnly(paths, schema, schema), false);
  }
});

test('fixed95 plaintext module remains a finite control and rejects mixed Pro approval', () => {
  const module = 'scripts/production-release/registration-interstitial-95.py';
  const profile = 'deploy/aws/registration-worker-95-20261008.json';
  const pro = 'deploy/aws/recharge-pro-4c-20261008.json';
  const control = [profile, module, 'scripts/production-release/remote-deploy.py'];
  assert.equal(checkMode(control, schema, schema), 'ci-only');
  assert.equal(isCiOnly(control), true);
  assert.deepEqual(selectedParts(control), ['guards']);
  const business = [
    ...control,
    'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py'
  ];
  assert.equal(checkMode(business, schema, schema), 'recharge');
  assert.deepEqual(selectedParts(business), ['guards', 'connector']);
  for (const drift of [
    [...control, pro],
    [...business, pro],
    [...control, 'scripts/production-release/registration-interstitial-96.py']
  ]) {
    assert.equal(checkMode(drift, schema, schema), 'full');
    assert.equal(isCiOnly(drift), false);
    assert.equal(isTargetedOnly(drift, schema, schema), false);
  }
});

test('pending online bridge control names are finite and preserve business scope', () => {
  const paths = [
    'scripts/production-release/api-admin-pending-projection.py',
    'scripts/production-release/api-admin-pending-projection.test.py',
    'scripts/production-release/api-admin-pending-online.test.py',
    'scripts/production-release/api-admin-pending-receipt-wire.py',
    'scripts/production-release/api-admin-pending-receipt-wire.test.py',
    'scripts/production-release/api-workspace-declaration-readonly.py',
    'scripts/production-release/api-workspace-declaration-readonly.test.py',
    'scripts/production-release/api-workspace-declaration-artifacts.py',
    'scripts/production-release/api-workspace-declaration-artifacts.test.py',
    'scripts/production-release/online-recharge-declaration-measurement.py',
    'scripts/production-release/online-recharge-declaration-measurement.test.py',
    'scripts/production-release/online-recharge-daemon-identity.py',
    'scripts/production-release/online-recharge-daemon-identity.test.py',
    'scripts/production-release/online-recharge-daemon-listener.py',
    'scripts/production-release/online-recharge-daemon-listener.test.py',
    'scripts/production-release/online-recharge-daemon-socket.py',
    'scripts/production-release/online-recharge-daemon-socket.test.py',
    'scripts/production-release/online-recharge-source-permission-repair.py',
    'scripts/production-release/online-recharge-source-permission-repair.test.py',
    'scripts/production-release/online-recharge-source-permission-repair-transport.py',
    'scripts/production-release/online-recharge-source-permission-repair-transport.test.py',
    'scripts/production-release/api-workspace-public-permission-repair.py',
    'scripts/production-release/api-workspace-public-permission-repair-transport.py',
    'scripts/production-release/api-workspace-public-permission-repair.test.py',
    'scripts/production-release/online-recharge-backup-source-recovery.py',
    'scripts/production-release/online-recharge-backup-source-recovery.test.py',
    'scripts/production-release/online-recharge-backup-source-recovery-transport.py',
    'scripts/production-release/online-recharge-backup-source-recovery-transport.test.py',
    'scripts/production-release/online-recharge-backup-parent-owner-repair.py',
    'scripts/production-release/online-recharge-backup-parent-owner-repair.test.py'
  ];
  for (const path of paths) {
    assert.equal(isCiOnly([path]), true);
    assert.equal(checkMode([path], schema, schema), 'ci-only');
  }
  assert.equal(isCiOnly([...paths, 'apps/api/src/auth/unknown.ts']), false);
  for (const unknown of [
    'scripts/production-release/api-admin-pending-online.py',
    'scripts/production-release/api-admin-pending-anything.py',
    'scripts/production-release/api-admin-pending-receipt-wire.py.backup',
    'scripts/production-release/api-admin-pending-receipt-wire-other.py',
    'scripts/production-release/api-admin-pending-projection.py.backup',
    'scripts/production-release/api-workspace-declaration-write.py',
    'scripts/production-release/online-recharge-declaration-measurement.py.backup',
    'scripts/production-release/online-recharge-source-permission-repair.py.backup',
    'scripts/production-release/online-recharge-source-permission-repair-transport-other.py',
    'scripts/production-release/api-workspace-public-permission-repair.py.backup',
    'scripts/production-release/api-workspace-public-permission-repair-transport-other.py',
    'scripts/production-release/online-recharge-backup-source-recovery.py.backup',
    'scripts/production-release/online-recharge-backup-source-recovery-transport-other.py',
    'scripts/production-release/online-recharge-backup-parent-owner-repair.py.backup',
    'scripts/production-release/online-recharge-backup-parent-owner-repair-other.py'
  ]) {
    assert.equal(isCiOnly([unknown]), false);
    assert.equal(checkMode([unknown], schema, schema), 'full');
  }
});

test('reviewed backup retention leaf paths are control-only without widening neighboring source', () => {
  const paths = [
    'scripts/backup-aws-mysql.sh',
    'scripts/backup-retention-protection.py',
    'scripts/backup-retention-protection.test.py',
    'scripts/production-release/backup-retention-install.py',
    'scripts/production-release/backup-retention-install.test.py'
  ];
  assert.equal(checkMode(paths, '', ''), 'ci-only');
  assert.deepEqual(selectedParts(paths), ['guards']);
  for (const path of [
    'scripts/verify-aws-mysql-backup.sh',
    'scripts/mysql-dump-restore-normalizer.sed',
    'scripts/backup-retention-protection-other.py',
    'scripts/production-release/backup-retention-install.py.backup'
  ])
    assert.equal(checkMode([path], '', ''), 'full');
});

function syntheticPreflightReceiptFixNative() {
  // Synthetic validator metadata only; it cannot grant operational authority.
  // The real reader hashes the original complete artifact/log bytes itself.
  const b = onlinePreflightReceiptFixGuardBinding;
  const passed = (name) => ({ name, status: 'completed', conclusion: 'success' });
  const run = {
    id: b.run,
    run_attempt: 1,
    event: 'pull_request',
    path: '.github/workflows/quality.yml',
    status: 'completed',
    conclusion: 'success',
    head_sha: b.originalHead,
    repository: { full_name: b.repository },
    pull_requests: []
  };
  return {
    run,
    jobs: [
      {
        id: b.job,
        run_id: b.run,
        run_attempt: 1,
        name: 'recharge (guards)',
        head_sha: b.originalHead,
        status: 'completed',
        conclusion: 'success',
        steps: [
          ...[
            'Checkout',
            'Setup Node.js',
            'Install package dependencies',
            'Check affected recharge part'
          ].map(passed),
          ...[
            'Install browser for recharge acceptance',
            'Install existing connector dependencies'
          ].map((name) => ({ name, status: 'completed', conclusion: 'skipped' }))
        ]
      },
      {
        id: b.qualityJob,
        run_id: b.run,
        run_attempt: 1,
        name: 'quality',
        head_sha: b.originalHead,
        status: 'completed',
        conclusion: 'success',
        steps: [
          'Checkout the tested source tree for its evidence',
          'Record successful PR source evidence',
          'Preserve successful source evidence'
        ].map(passed)
      }
    ],
    originalPr: {
      number: 471,
      state: 'closed',
      merged: true,
      head: { sha: b.originalHead },
      base: { sha: b.originalBase },
      merge_commit_sha: b.originalMergedMain
    },
    mainRun: { ...run, id: b.mainRun, event: 'push', head_sha: b.originalMergedMain },
    integrationMainRun: {
      ...run,
      id: b.integrationMainRun,
      event: 'push',
      head_sha: b.integrationBase,
      head_branch: 'main',
      head_commit: { id: b.integrationBase, tree_id: b.integrationTree }
    },
    artifact: {
      id: b.artifact,
      name: 'quality-source-evidence-1',
      expired: false,
      size_in_bytes: 355,
      digest: 'sha256:' + b.artifactSha256,
      workflow_run: { id: b.run, head_sha: b.originalHead }
    },
    proof: {
      repository: b.repository,
      runId: b.run,
      runAttempt: 1,
      pullRequest: 471,
      headSha: b.originalHead,
      baseSha: b.originalBase,
      testedTree: b.tree
    },
    proofSha256: b.proofSha256,
    facts: {
      sha256: b.rawLogSha256,
      checkout: b.checkout,
      scope: true,
      environment: true,
      errors: [],
      failedCommands: []
    },
    qualityLog: { sha256: b.rawQualityLogSha256, checkout: b.checkout },
    currentEnvironment: {
      node: 'v24.21.0',
      npm: '11.19.0',
      imageOS: 'ubuntu24',
      imageVersion: '20261004.327.1',
      platform: 'linux'
    },
    baselineTree: b.integrationTree,
    currentHeadTree: 'a'.repeat(40),
    currentTree: 'a'.repeat(40),
    changed: [...onlinePreflightReceiptFixGuardPaths],
    runtimeSha256: b.runtimeSha256,
    runtimeTestSha256: b.runtimeTestSha256,
    scopeUnchanged: true,
    dispatcherUnchanged: true,
    runtimeUnchanged: true,
    modesUnchanged: true
  };
}

test('finite failure-receipt guard binds authentic closed-PR source artifact logs jobs and exact repairs without mutable PR aliases', () => {
  const original = syntheticPreflightReceiptFixNative();
  assert.equal(validateOnlinePreflightReceiptFixGuardNative(original), true);
  for (const mutate of [
    (v) => {
      v.run.id++;
    },
    (v) => {
      v.run.run_attempt = 2;
    },
    (v) => {
      v.run.head_sha = v.currentHeadTree;
    },
    (v) => {
      v.run.conclusion = 'failure';
    },
    (v) => {
      v.run.event = 'push';
    },
    (v) => {
      v.run.path = '.github/workflows/production-release.yml';
    },
    (v) => {
      v.originalPr.merged = false;
    },
    (v) => {
      v.originalPr.head.sha = v.currentHeadTree;
    },
    (v) => {
      v.originalPr.merge_commit_sha = v.currentHeadTree;
    },
    (v) => {
      v.mainRun.conclusion = 'failure';
    },
    (v) => {
      v.mainRun.head_sha = onlinePreflightReceiptFixGuardBinding.integrationBase;
    },
    (v) => {
      delete v.integrationMainRun;
    },
    (v) => {
      v.integrationMainRun.id++;
    },
    (v) => {
      v.integrationMainRun.run_attempt = 2;
    },
    (v) => {
      v.integrationMainRun.event = 'pull_request';
    },
    (v) => {
      v.integrationMainRun.head_sha = onlinePreflightReceiptFixGuardBinding.originalMergedMain;
    },
    (v) => {
      v.integrationMainRun.head_branch = 'other';
    },
    (v) => {
      delete v.integrationMainRun.head_commit;
    },
    (v) => {
      v.integrationMainRun.head_commit.id =
        onlinePreflightReceiptFixGuardBinding.originalMergedMain;
    },
    (v) => {
      v.integrationMainRun.head_commit.tree_id = onlinePreflightReceiptFixGuardBinding.tree;
    },
    (v) => {
      v.integrationMainRun.conclusion = 'failure';
    },
    (v) => {
      v.integrationMainRun.path = '.github/workflows/production-release.yml';
    },
    (v) => {
      v.integrationMainRun.repository.full_name = 'foreign/project';
    },
    (v) => {
      v.jobs[0].conclusion = 'failure';
    },
    (v) => {
      v.jobs[0].steps[0].conclusion = 'skipped';
    },
    (v) => {
      v.jobs.push({ ...v.jobs[0] });
    },
    (v) => {
      v.jobs[1].steps.pop();
    },
    (v) => {
      v.artifact.expired = true;
    },
    (v) => {
      v.artifact.id++;
    },
    (v) => {
      v.artifact.digest = 'sha256:' + '0'.repeat(64);
    },
    (v) => {
      v.proof.baseSha = v.currentHeadTree;
    },
    (v) => {
      v.proof.testedTree = v.currentHeadTree;
    },
    (v) => {
      v.proof.extra = true;
    },
    (v) => {
      v.proofSha256 = '0'.repeat(64);
    },
    (v) => {
      v.facts.sha256 = '0'.repeat(64);
    },
    (v) => {
      v.facts.errors.push('ERROR: unknown');
    },
    (v) => {
      v.facts.environment = false;
    },
    (v) => {
      v.qualityLog.checkout = v.currentHeadTree;
    },
    (v) => {
      v.qualityLog.sha256 = '0'.repeat(64);
    },
    (v) => {
      v.currentHeadTree = 'b'.repeat(40);
    },
    (v) => {
      v.baselineTree = v.currentTree;
    },
    (v) => {
      v.changed.push('apps/api/src/main.ts');
    },
    (v) => {
      v.changed.shift();
    },
    (v) => {
      v.currentEnvironment.imageVersion = 'changed';
    },
    (v) => {
      v.currentEnvironment.platform = 'darwin';
    },
    (v) => {
      v.currentEnvironment.node = 'v24.19.0';
    },
    (v) => {
      v.runtimeSha256 = (v.runtimeSha256[0] === '0' ? '1' : '0') + v.runtimeSha256.slice(1);
    },
    (v) => {
      v.runtimeTestSha256 =
        (v.runtimeTestSha256[0] === '0' ? '1' : '0') + v.runtimeTestSha256.slice(1);
    },
    (v) => {
      v.scopeUnchanged = false;
    },
    (v) => {
      v.dispatcherUnchanged = false;
    },
    (v) => {
      v.runtimeUnchanged = false;
    },
    (v) => {
      v.modesUnchanged = false;
    }
  ]) {
    const changed = structuredClone(original);
    mutate(changed);
    assert.equal(validateOnlinePreflightReceiptFixGuardNative(changed), false, mutate.toString());
  }
});

test('finite failure-receipt diagnostics retain native privacy and fail closed on every source boundary', () => {
  const value = syntheticPreflightReceiptFixNative();
  assert.deepEqual(onlinePreflightReceiptFixGuardFailureCodes(value), []);
  value.secret = 'PRIVATE_SENTINEL';
  value.currentEnvironment.secret = 'PRIVATE_SENTINEL';
  assert.equal(requireOnlinePreflightReceiptFixGuardNative(value), true);
  value.facts.errors.push('ERROR: PRIVATE_SENTINEL');
  value.runtimeSha256 = 'PRIVATE_SENTINEL';
  assert.equal(validateOnlinePreflightReceiptFixGuardNative(value), false);
  assert.deepEqual(onlinePreflightReceiptFixGuardFailureCodes(value), [
    'GUARD_LOG_ERRORS',
    'RUNTIME_SOURCE'
  ]);
  assert.throws(
    () => requireOnlinePreflightReceiptFixGuardNative(value),
    (error) => {
      assert.equal(
        error.message,
        'Original failure-receipt source or guard evidence changed; predicates=GUARD_LOG_ERRORS,RUNTIME_SOURCE'
      );
      assert.equal(error.message.includes('PRIVATE_SENTINEL'), false);
      return true;
    }
  );
  assert.equal(canResumeOnlinePreflightReceiptFixGuard('0'.repeat(40)), false);
});

test('historical failure-receipt normalization authenticates frozen typed repair and rejects subsequent hardening', () => {
  const b = onlinePreflightReceiptFixGuardBinding;
  for (const [path, verify] of [
    ['scripts/ci-recharge-scope.mjs', onlinePreflightReceiptFixScopeBytesUnchanged],
    ['scripts/ci-recharge-check.mjs', onlinePreflightReceiptFixDispatcherBytesUnchanged],
    [
      'scripts/production-release/online-recharge-component-runtime.py',
      onlinePreflightReceiptFixRuntimeBytesUnchanged
    ]
  ]) {
    const before = execFileSync('git', ['show', b.integrationBase + ':' + path], {
      encoding: 'utf8'
    });
    const after = execFileSync(
      'git',
      ['show', '619b04c240eed836b1db76a9fe330634de1fecbf:' + path],
      { encoding: 'utf8' }
    );
    assert.equal(verify(before, after), true, path);
    const current = readFileSync(path, 'utf8');
    if (current !== after) assert.equal(verify(before, current), false, path);
    for (const altered of [
      ' ' + after,
      after + '\n',
      after.replace('const git =', 'const modifiedGit ='),
      after.replace('def authority(', 'def modified_authority('),
      after.replace('def prepare(', 'def modified_prepare('),
      after.replace('resumeOnlinePrepareFixGuard', 'resumeOldGuardChanged'),
      after.replace('rawLogSha256:', 'changedRawLogSha256:'),
      after.replace('releaseArtifactRetentionControls', 'changedStorageControls'),
      after.replace('releaseArtifactOnly', 'changedStorageOnly')
    ])
      if (altered !== after) assert.equal(verify(before, altered), false, path);
    assert.equal(verify(before, before), false);
  }
  const runtime = execFileSync(
    'git',
    [
      'show',
      '619b04c240eed836b1db76a9fe330634de1fecbf:scripts/production-release/online-recharge-component-runtime.py'
    ],
    { encoding: 'utf8' }
  );
  const before = execFileSync(
    'git',
    [
      'show',
      b.integrationBase + ':scripts/production-release/online-recharge-component-runtime.py'
    ],
    { encoding: 'utf8' }
  );
  for (const altered of [
    runtime.replace('import subprocess\n', ''),
    runtime.replace('import subprocess\n', 'import subprocess\nimport subprocess\n'),
    runtime.replace('import urllib.error\n', 'import urllib.request\n'),
    runtime.replace('        code = rejection_code(error)\n', '        code = str(error)\n'),
    runtime.replace('def cli(', 'def changed_cli(')
  ])
    assert.equal(onlinePreflightReceiptFixRuntimeBytesUnchanged(before, altered), false);
});

test('finite failure-receipt raw transport pins exactly the passed PR471 platform artifacts', () => {
  const b = onlinePreflightReceiptFixGuardBinding;
  assert.equal(b.run, 38508638260);
  assert.equal(b.originalMergedMain, 'a9829b443fe5c0cf6f4803366d06c5f8e3357318');
  assert.equal(b.integrationBase, 'b9f2e2b75a753b86a5057dd798d651c57496554e');
  assert.equal(b.integrationTree, 'd7a012ba01d59d37ccf79141bc9055332c3978fc');
  assert.equal(b.integrationMainRun, 38518628653);
  assert.equal(b.mainRun, 38511580891);
  assert.equal(b.tree, 'a473264b8821ebe72471979614ba7983c531e309');
  assert.equal(b.job, 115671848013);
  assert.equal(b.qualityJob, 115680672303);
  assert.equal(b.artifact, 11869619286);
  assert.equal(b.rawLogSha256, '33b7dd17b66f825aea10dc6b6f1dcda61baf053d39ae71c370986baf10a84318');
  assert.equal(
    b.rawQualityLogSha256,
    '2f46b3bf0ad7a1ab19c42c1dd9751283c8927611bb90a75ab8470d8fe85d36aa'
  );
  const source = readFileSync('scripts/ci-recharge-scope.mjs', 'utf8');
  const start = source.indexOf('export function canResumeOnlinePreflightReceiptFixGuard(');
  const reader = source.slice(
    start,
    source.indexOf('// END finite ONLINE failure-receipt guard continuation', start)
  );
  assert.ok(
    reader
      .replace(/\s/g, '')
      .includes(
        "['api', '--allow-escape-sequences', 'repos/' + b.repository + '/actions/jobs/' + job + '/logs']".replace(
          /\s/g,
          ''
        )
      )
  );
  assert.equal(reader.includes("['run', 'view'"), false);
  const lines = [
    '[command]/usr/bin/git log -1 --format=%H',
    b.checkout,
    '  CHECK_BASE: ' + b.originalBase,
    '  CHECK_MODE: ci-only',
    '  CHECK_PART: guards',
    '##[group]Run node scripts/ci-recharge-check.mjs "$CHECK_PART" "$CHECK_BASE"',
    '  NODE_ENV: test',
    'Image: ubuntu-24.04',
    'Version: 20261004.327.1',
    'node: v24.21.0',
    'npm: 11.19.0',
    '\x1b[36;1mPUBLIC_FIXTURE\x1b[0m'
  ];
  const text =
    lines
      .map((line, index) => (index ? '' : '\uFEFF') + '2026-10-14T00:00:00.1234567Z ' + line)
      .join('\n') + '\n';
  const facts = onlinePreflightReceiptFixGuardRawLogFacts(Buffer.from(text));
  assert.equal(facts.checkout, b.checkout);
  assert.equal(facts.scope, true);
  assert.equal(facts.environment, true);
  assert.notEqual(
    facts.sha256,
    onlinePreflightReceiptFixGuardRawLogFacts(Buffer.from(text.replaceAll('\x1b', '^['))).sha256
  );
  for (const invalid of [
    undefined,
    Buffer.alloc(0),
    Buffer.from([255]),
    Buffer.from('job\tstep\t' + text),
    Buffer.from(text + 'tail')
  ])
    assert.equal(onlinePreflightReceiptFixGuardRawLogFacts(invalid), undefined);
  assert.equal(
    validateOnlinePreflightReceiptFixGuardNative({
      ...syntheticPreflightReceiptFixNative(),
      facts
    }),
    false
  );
});

test('artifact retention is a finite operational scope with mixed changes retaining all guards', () => {
  const paths = [
    ...releaseArtifactRetentionControls,
    'docs/DISK_STORAGE_POLICY.md',
    'scripts/ci-recharge-check.mjs'
  ];
  assert.equal(isReleaseArtifactRetentionOnly(paths), true);
  assert.equal(checkMode(paths, '', ''), 'ci-only');
  assert.deepEqual(selectedParts(paths), ['guards']);
  assert.equal(isReleaseArtifactRetentionOnly(['docs/DISK_STORAGE_POLICY.md']), false);
  assert.equal(isReleaseArtifactRetentionOnly(['scripts/ci-recharge-check.mjs']), false);
  for (const extra of [
    'scripts/production-release/remote-deploy.py',
    '.github/workflows/production-release.yml',
    'apps/api/src/auth/auth.service.ts',
    'scripts/production-release/release-artifact-retention.py.backup',
    'scripts/production-release/release-artifact-retention-anything.py'
  ])
    assert.equal(isReleaseArtifactRetentionOnly([...paths, extra]), false);
  for (const unknown of [
    'scripts/production-release/release-artifact-retention.py.backup',
    'scripts/production-release/release-artifact-retention-anything.py'
  ])
    assert.equal(checkMode([unknown], '', ''), 'full');
});
// BEGIN finite ONLINE build-proof reuse guard tests
const {
  onlinePreflightReceiptFixGuardCommands,
  onlineBuildProofReuseGuardBinding,
  onlineBuildProofReuseGuardPaths,
  onlineBuildProofReuseCommands,
  onlineBuildProofReuseScopeBytesUnchanged,
  onlineBuildProofReuseScopeTestBytesUnchanged,
  onlineBuildProofReuseDispatcherBytesUnchanged,
  onlineBuildProofReusePythonBytesUnchanged,
  onlineBuildProofReuseGuardRawLogFacts,
  onlineBuildProofReuseGuardFailureCodes,
  validateOnlineBuildProofReuseGuardNative,
  requireOnlineBuildProofReuseGuardNative,
  canResumeOnlineBuildProofReuseGuard
} = await import('./ci-recharge-scope.mjs');

function syntheticBuildProofReuseNative() {
  // Synthetic metadata validates the contract. Only original remote bytes and
  // the reader's actual Git snapshots can authorize the finite CI lane.
  const b = onlineBuildProofReuseGuardBinding;
  const passed = (name) => ({ name, status: 'completed', conclusion: 'success' });
  const run = {
    id: b.run,
    run_attempt: 1,
    event: 'pull_request',
    path: '.github/workflows/quality.yml',
    status: 'completed',
    conclusion: 'success',
    head_sha: b.originalHead,
    repository: { full_name: b.repository },
    pull_requests: []
  };
  return {
    run,
    jobs: [
      {
        id: b.job,
        run_id: b.run,
        run_attempt: 1,
        name: 'recharge (guards)',
        head_sha: b.originalHead,
        status: 'completed',
        conclusion: 'success',
        steps: [
          ...[
            'Checkout',
            'Setup Node.js',
            'Install package dependencies',
            'Check affected recharge part',
            'Build and verify sealed ONLINE images without production access',
            'Preserve CI-only ONLINE image verification'
          ].map(passed),
          ...[
            'Install browser for recharge acceptance',
            'Install existing connector dependencies'
          ].map((name) => ({ name, status: 'completed', conclusion: 'skipped' }))
        ]
      },
      {
        id: b.qualityJob,
        run_id: b.run,
        run_attempt: 1,
        name: 'quality',
        head_sha: b.originalHead,
        status: 'completed',
        conclusion: 'success',
        steps: [
          'Checkout the tested source tree for its evidence',
          'Record successful PR source evidence',
          'Preserve successful source evidence'
        ].map(passed)
      }
    ],
    originalPr: {
      number: 475,
      state: 'closed',
      merged: true,
      head: { sha: b.originalHead },
      base: { sha: b.originalBase },
      merge_commit_sha: b.originalMergedMain
    },
    mainRun: {
      ...run,
      id: b.originalMainRun,
      event: 'push',
      head_sha: b.originalMergedMain,
      head_branch: 'main',
      head_commit: { id: b.originalMergedMain, tree_id: b.originalMergedTree }
    },
    integrationMainRun: {
      ...run,
      id: b.integrationMainRun,
      event: 'push',
      head_sha: b.base,
      head_branch: 'main',
      head_commit: { id: b.base, tree_id: b.tree }
    },
    artifact: {
      id: b.artifact,
      name: 'quality-source-evidence-1',
      expired: false,
      size_in_bytes: b.artifactBytes,
      digest: 'sha256:' + b.artifactSha256,
      workflow_run: { id: b.run, head_sha: b.originalHead }
    },
    proof: {
      repository: b.repository,
      runId: b.run,
      runAttempt: 1,
      pullRequest: 475,
      headSha: b.originalHead,
      baseSha: b.originalBase,
      testedTree: b.originalMergedTree
    },
    proofSha256: b.proofSha256,
    facts: {
      sha256: b.rawLogSha256,
      checkout: b.checkout,
      scope: true,
      environment: true,
      errors: [],
      failedCommands: []
    },
    qualityLog: { sha256: b.rawQualityLogSha256, checkout: b.checkout },
    currentEnvironment: {
      node: 'v24.21.0',
      npm: '11.19.0',
      imageOS: 'ubuntu24',
      imageVersion: '20261004.327.1',
      platform: 'linux'
    },
    baselineTree: b.tree,
    currentHeadTree: 'a'.repeat(40),
    currentTree: 'a'.repeat(40),
    changed: [...onlineBuildProofReuseGuardPaths],
    ...Object.fromEntries(
      [
        'runtimeSha256',
        'runtimeTestSha256',
        'readonlySha256',
        'readonlyTestSha256',
        'helperSha256',
        'helperTestSha256',
        'dispatcherTestSha256'
      ].map((key) => [key, b[key]])
    ),
    scopeUnchanged: true,
    scopeTestUnchanged: true,
    dispatcherUnchanged: true,
    runtimeUnchanged: true,
    readonlyUnchanged: true,
    modesUnchanged: true
  };
}

test('finite build-proof reuse authenticates actual merged PR475, original raw quality and exact twelve candidate paths', () => {
  const original = syntheticBuildProofReuseNative();
  assert.equal(validateOnlineBuildProofReuseGuardNative(original), true);
  for (const [path, replacement] of [
    [['run', 'id'], 38519927084],
    [['run', 'run_attempt'], 2],
    [['run', 'event'], 'push'],
    [['run', 'status'], 'in_progress'],
    [['run', 'conclusion'], 'failure'],
    [['run', 'path'], '.github/workflows/production-release.yml'],
    [['run', 'head_sha'], 'a'.repeat(40)],
    [['run', 'repository', 'full_name'], 'foreign/project'],
    [['originalPr', 'number'], 476],
    [['originalPr', 'state'], 'open'],
    [['originalPr', 'merged'], false],
    [['originalPr', 'head', 'sha'], 'a'.repeat(40)],
    [['originalPr', 'base', 'sha'], 'a'.repeat(40)],
    [['originalPr', 'merge_commit_sha'], 'a'.repeat(40)],
    [['mainRun', 'id'], 38523835751],
    [['mainRun', 'run_attempt'], 2],
    [['mainRun', 'event'], 'pull_request'],
    [['mainRun', 'conclusion'], 'failure'],
    [['mainRun', 'head_sha'], original.proof.baseSha],
    [['mainRun', 'head_branch'], 'other'],
    [['mainRun', 'head_commit', 'id'], 'a'.repeat(40)],
    [['mainRun', 'head_commit', 'tree_id'], 'a'.repeat(40)],
    [['jobs', 0, 'id'], 1],
    [['jobs', 0, 'run_id'], 1],
    [['jobs', 0, 'run_attempt'], 2],
    [['jobs', 0, 'name'], 'full-quality'],
    [['jobs', 0, 'head_sha'], 'a'.repeat(40)],
    [['jobs', 0, 'conclusion'], 'failure'],
    [['jobs', 0, 'steps', 0, 'conclusion'], 'skipped'],
    [['jobs', 0, 'steps', 4, 'conclusion'], 'failure'],
    [['jobs', 0, 'steps', 7, 'conclusion'], 'success'],
    [['jobs', 1, 'steps'], []],
    [['artifact', 'id'], 1],
    [['artifact', 'name'], 'online-ci-build-only-1'],
    [['artifact', 'expired'], true],
    [['artifact', 'size_in_bytes'], 355],
    [['artifact', 'digest'], 'sha256:' + '0'.repeat(64)],
    [['artifact', 'workflow_run', 'head_sha'], 'a'.repeat(40)],
    [['proof', 'runId'], 1],
    [['proof', 'runAttempt'], 2],
    [['proof', 'pullRequest'], 476],
    [['proof', 'baseSha'], 'a'.repeat(40)],
    [['proof', 'headSha'], 'a'.repeat(40)],
    [['proof', 'testedTree'], 'a'.repeat(40)],
    [['proofSha256'], '0'.repeat(64)],
    [['facts', 'sha256'], 'cf6b67e573fa4219f6bfa87389727a33f2773a0006e5917903d113fd90e8fc9b'],
    [['facts', 'checkout'], 'a'.repeat(40)],
    [['facts', 'scope'], false],
    [['facts', 'environment'], false],
    [['facts', 'errors'], ['ERROR: private']],
    [['facts', 'failedCommands'], ['Error: Command failed: private']],
    [['qualityLog', 'sha256'], 'fe663f3c2281c2d9868a62a5c0e5f5ddf60870632f3ddfa1960cf2b23ab0702a'],
    [['qualityLog', 'checkout'], 'a'.repeat(40)],
    [['baselineTree'], 'a'.repeat(40)],
    [['currentHeadTree'], 'b'.repeat(40)],
    [['currentTree'], 'invalid'],
    ...[
      'runtimeSha256',
      'runtimeTestSha256',
      'readonlySha256',
      'readonlyTestSha256',
      'helperSha256',
      'helperTestSha256',
      'dispatcherTestSha256'
    ].map((key) => [[key], '0'.repeat(64)]),
    ...[
      'scopeUnchanged',
      'scopeTestUnchanged',
      'dispatcherUnchanged',
      'runtimeUnchanged',
      'readonlyUnchanged',
      'modesUnchanged'
    ].map((key) => [[key], false]),
    ...['node', 'npm', 'imageOS', 'imageVersion', 'platform'].map((key) => [
      ['currentEnvironment', key],
      'changed'
    ])
  ]) {
    const value = structuredClone(original);
    let parent = value;
    for (const key of path.slice(0, -1)) parent = parent[key];
    parent[path.at(-1)] = replacement;
    assert.equal(validateOnlineBuildProofReuseGuardNative(value), false, path.join('.'));
  }
  for (const mutate of [
    (v) => v.jobs.push({ ...v.jobs[0] }),
    (v) => v.jobs[0].steps.push({ ...v.jobs[0].steps[0] }),
    (v) => (v.proof.extra = true),
    (v) => v.changed.pop(),
    (v) => v.changed.push('apps/api/src/auth/auth.service.ts'),
    (v) => (v.changed[0] = v.changed[1]),
    (v) => (v.changed[0] += '.backup'),
    (v) => (v.currentHeadTree = v.currentTree = original.baselineTree)
  ]) {
    const value = structuredClone(original);
    mutate(value);
    assert.equal(validateOnlineBuildProofReuseGuardNative(value), false, mutate.toString());
  }
  const value = structuredClone(original);
  value.run.pull_requests = [
    { number: 999, head: { sha: 'b'.repeat(40) }, base: { sha: 'c'.repeat(40) } }
  ];
  assert.equal(validateOnlineBuildProofReuseGuardNative(value), true);
  assert.equal(onlineBuildProofReuseCommands.length, 22);
  assert.deepEqual(
    onlineBuildProofReuseCommands.slice(0, 19),
    onlinePreflightReceiptFixGuardCommands
  );
  assert.equal(checkMode(onlineBuildProofReuseGuardPaths, '', ''), 'ci-only');
  assert.equal(needsOnlineRechargeCiBuild(onlineBuildProofReuseGuardPaths), true);
});

test('finite build-proof integration authenticates latest 5f storage quality without relabeling original PR475 artifact tree', () => {
  const b = onlineBuildProofReuseGuardBinding;
  const original = syntheticBuildProofReuseNative();
  assert.equal(b.base, '5f458e7ac7cd0dfab0f99d2a6d07c20baa8b6e53');
  assert.equal(b.tree, 'bcc614bd53dbf4ddf8e3d7d6ba85d5a4ed1f1a3a');
  assert.equal(b.originalMergedMain, 'fff7b257fa402e14da5d9aa43aa4ea22095695c5');
  assert.equal(b.originalMergedTree, '04637480488076dc891c822e79864f8ff96bbf06');
  assert.equal(b.originalMainRun, 38530643303);
  assert.equal(b.integrationMainRun, 38544086836);
  assert.equal(original.proof.testedTree, b.originalMergedTree);
  assert.equal(original.baselineTree, b.tree);
  assert.notEqual(original.proof.testedTree, original.baselineTree);
  assert.deepEqual(onlineBuildProofReuseGuardFailureCodes(original), []);
  for (const [keys, replacement, expected] of [
    [['integrationMainRun'], undefined, 'INTEGRATION_MAIN_QUALITY'],
    [['integrationMainRun', 'id'], b.originalMainRun, 'INTEGRATION_MAIN_QUALITY'],
    [['integrationMainRun', 'run_attempt'], 2, 'INTEGRATION_MAIN_QUALITY'],
    [['integrationMainRun', 'event'], 'pull_request', 'INTEGRATION_MAIN_QUALITY'],
    [['integrationMainRun', 'status'], 'in_progress', 'INTEGRATION_MAIN_QUALITY'],
    [['integrationMainRun', 'conclusion'], 'failure', 'INTEGRATION_MAIN_QUALITY'],
    [
      ['integrationMainRun', 'path'],
      '.github/workflows/production-release.yml',
      'INTEGRATION_MAIN_QUALITY'
    ],
    [['integrationMainRun', 'head_sha'], b.originalMergedMain, 'INTEGRATION_MAIN_QUALITY'],
    [['integrationMainRun', 'head_branch'], 'foreign-branch', 'INTEGRATION_MAIN_QUALITY'],
    [['integrationMainRun', 'head_commit'], undefined, 'INTEGRATION_MAIN_QUALITY'],
    [['integrationMainRun', 'head_commit', 'id'], b.originalMergedMain, 'INTEGRATION_MAIN_QUALITY'],
    [
      ['integrationMainRun', 'head_commit', 'tree_id'],
      b.originalMergedTree,
      'INTEGRATION_MAIN_QUALITY'
    ],
    [
      ['integrationMainRun', 'repository', 'full_name'],
      'foreign/project',
      'INTEGRATION_MAIN_QUALITY'
    ],
    [['mainRun'], original.integrationMainRun, 'MAIN_QUALITY'],
    [['mainRun', 'head_commit', 'tree_id'], b.tree, 'MAIN_QUALITY'],
    [['originalPr', 'merge_commit_sha'], b.base, 'CLOSED_PR_SOURCE'],
    [['proof', 'testedTree'], b.tree, 'PROOF_SOURCE'],
    [['proof', 'baseSha'], b.base, 'PROOF_SOURCE'],
    [['artifact', 'workflow_run', 'id'], b.integrationMainRun, 'SOURCE_ARTIFACT'],
    [['artifact', 'workflow_run', 'head_sha'], b.base, 'SOURCE_ARTIFACT'],
    [['artifact', 'digest'], 'sha256:' + '0'.repeat(64), 'SOURCE_ARTIFACT'],
    [['proofSha256'], '0'.repeat(64), 'PROOF_BYTES'],
    [['baselineTree'], b.originalMergedTree, 'BASELINE_TREE']
  ]) {
    const value = structuredClone(original);
    let parent = value;
    for (const key of keys.slice(0, -1)) parent = parent[key];
    parent[keys.at(-1)] = replacement;
    assert.ok(onlineBuildProofReuseGuardFailureCodes(value).includes(expected), keys.join('.'));
    assert.throws(() => requireOnlineBuildProofReuseGuardNative(value), /predicates=/);
  }
});

test('finite build-proof diagnostics expose only closed predicate codes and cannot grant production authority', () => {
  const value = syntheticBuildProofReuseNative();
  value.secret = 'PRIVATE_SENTINEL';
  value.currentEnvironment.secret = 'PRIVATE_SENTINEL';
  assert.deepEqual(onlineBuildProofReuseGuardFailureCodes(value), []);
  assert.equal(requireOnlineBuildProofReuseGuardNative(value), true);
  value.facts.errors.push('ERROR: PRIVATE_SENTINEL');
  value.helperSha256 = 'PRIVATE_SENTINEL';
  assert.deepEqual(onlineBuildProofReuseGuardFailureCodes(value), [
    'GUARD_LOG_ERRORS',
    'HELPER_SOURCE'
  ]);
  assert.throws(
    () => requireOnlineBuildProofReuseGuardNative(value),
    (error) => {
      assert.equal(
        error.message,
        'Original build-proof source or guard evidence changed; predicates=GUARD_LOG_ERRORS,HELPER_SOURCE'
      );
      assert.equal(error.message.includes('PRIVATE_SENTINEL'), false);
      return true;
    }
  );
  assert.equal(typeof canResumeOnlineBuildProofReuseGuard, 'function');
});

test('finite build-proof source normalization preserves every published selector byte and excludes only repaired Python function boundaries', () => {
  const b = onlineBuildProofReuseGuardBinding;
  const source = (path) => execFileSync('git', ['show', b.base + ':' + path], { encoding: 'utf8' });
  // The admitted upstream repair remains an immutable positive fixture. Later
  // recovery controls must require their own guards, rather than broaden it.
  const admitted = (path) =>
    execFileSync('git', ['show', 'adb541c9c70757464a0f7fc31dce91f93f6d36d6:' + path], {
      encoding: 'utf8'
    });
  for (const [path, verify] of [
    ['scripts/ci-recharge-scope.mjs', onlineBuildProofReuseScopeBytesUnchanged],
    ['scripts/ci-recharge-scope.test.mjs', onlineBuildProofReuseScopeTestBytesUnchanged],
    ['scripts/ci-recharge-check.mjs', onlineBuildProofReuseDispatcherBytesUnchanged]
  ]) {
    const before = source(path),
      after = admitted(path);
    assert.equal(verify(before, after), true, path);
    const mutations = [' ' + after, after + '\n'];
    for (const [from, to] of [
      ['const git =', 'const modifiedGit ='],
      ['releaseArtifactOnly', 'changedArchiveOnly'],
      ['onlineCiBuildInputs =', 'changedCiBuildInputs ='],
      ['rawLogSha256:', 'changedHistoricalLogSha256:']
    ])
      if (before.includes(from)) mutations.push(after.replace(from, to));
    for (const changed of mutations) assert.equal(verify(before, changed), false, path);
    assert.equal(verify(before, before), false, path);
  }
  for (const [path, name] of [
    ['scripts/production-release/online-recharge-component-runtime.py', 'build_proof'],
    ['scripts/production-release/online-recharge-component-readonly.py', 'safe_failure']
  ]) {
    const before = source(path),
      after = admitted(path);
    assert.equal(onlineBuildProofReusePythonBytesUnchanged(before, after, name), true);
    assert.equal(
      onlineBuildProofReusePythonBytesUnchanged(before, after + '\nINJECTED = 1\n', name),
      false
    );
    assert.equal(
      onlineBuildProofReusePythonBytesUnchanged(
        before,
        after.replace('def ' + name + '(', 'def changed_' + name + '('),
        name
      ),
      false
    );
    assert.equal(onlineBuildProofReusePythonBytesUnchanged(before, after, 'cli'), false);
  }
});

test('protected recovery changes cannot borrow the earlier finite proof-reuse guard admission', () => {
  const source = (path) =>
    execFileSync('git', ['show', onlineBuildProofReuseGuardBinding.base + ':' + path], {
      encoding: 'utf8'
    });
  for (const [path, verify] of [
    ['scripts/ci-recharge-scope.mjs', onlineBuildProofReuseScopeBytesUnchanged],
    ['scripts/ci-recharge-scope.test.mjs', onlineBuildProofReuseScopeTestBytesUnchanged],
    ['scripts/ci-recharge-check.mjs', onlineBuildProofReuseDispatcherBytesUnchanged]
  ])
    assert.equal(verify(source(path), readFileSync(path, 'utf8')), false, path);
  const runtime = 'scripts/production-release/online-recharge-component-runtime.py';
  assert.equal(
    onlineBuildProofReusePythonBytesUnchanged(
      source(runtime),
      readFileSync(runtime, 'utf8'),
      'build_proof'
    ),
    false
  );
});

test('finite build-proof raw logs require original UTC bytes and the authenticated actual PR475 checkout', () => {
  const b = onlineBuildProofReuseGuardBinding;
  const lines = [
    '[command]/usr/bin/git log -1 --format=%H',
    b.checkout,
    '  CHECK_BASE: ' + b.originalBase,
    '  CHECK_MODE: ci-only',
    '  CHECK_PART: guards',
    '##[group]Run node scripts/ci-recharge-check.mjs "$CHECK_PART" "$CHECK_BASE"',
    '  NODE_ENV: test',
    'Image: ubuntu-24.04',
    'Version: 20261004.327.1',
    'node: v24.21.0',
    'npm: 11.19.0',
    '\x1b[36;1mPUBLIC_FIXTURE\x1b[0m'
  ];
  const raw = Buffer.from(
    lines
      .map((line, index) => (index ? '' : '\uFEFF') + '2026-10-14T00:00:00.1234567Z ' + line)
      .join('\n') + '\n'
  );
  const facts = onlineBuildProofReuseGuardRawLogFacts(raw);
  assert.equal(facts.checkout, b.checkout);
  assert.equal(facts.scope, true);
  assert.equal(facts.environment, true);
  assert.notEqual(facts.sha256, b.rawLogSha256);
  assert.equal(
    validateOnlineBuildProofReuseGuardNative({ ...syntheticBuildProofReuseNative(), facts }),
    false
  );
  for (const invalid of [
    undefined,
    Buffer.alloc(0),
    Buffer.from([255]),
    Buffer.from('job\tstep\t' + raw),
    Buffer.concat([raw, Buffer.from('tail')])
  ])
    assert.equal(onlineBuildProofReuseGuardRawLogFacts(invalid), undefined);
  assert.notEqual(
    facts.sha256,
    onlineBuildProofReuseGuardRawLogFacts(Buffer.from(raw.toString().replaceAll('\x1b', '^[')))
      .sha256
  );
  assert.equal(
    onlineBuildProofReuseGuardRawLogFacts(Buffer.concat([raw, raw])).checkout,
    undefined
  );
  const source = readFileSync('scripts/ci-recharge-scope.mjs', 'utf8');
  const start = source.indexOf('export function canResumeOnlineBuildProofReuseGuard(');
  const reader = source.slice(
    start,
    source.indexOf('// END finite ONLINE build-proof reuse guard continuation', start)
  );
  assert.ok(
    reader
      .replace(/\s/g, '')
      .includes(
        "['api', '--allow-escape-sequences', 'repos/' + b.repository + '/actions/jobs/' + job + '/logs']".replace(
          /\s/g,
          ''
        )
      )
  );
  assert.equal(reader.includes("['run', 'view'"), false);
  assert.ok(source.includes("canResumeOnlineBuildProofReuseGuard(base, 'scope')"));
});
function recordBuildProofReuseAdmission(options = {}) {
  const b = onlineBuildProofReuseGuardBinding;
  const fixture = {
    base: b.base,
    branch: b.branch,
    repository: b.repository,
    tree: b.tree,
    phase: 'guards',
    mode: 'ci-only',
    nodeEnv: 'test',
    actions: 'true',
    headRepository: b.repository,
    paths: [...onlineBuildProofReuseGuardPaths],
    ...options
  };
  const script = `
    import fs from 'node:fs';
    import childProcess from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    const fixture = JSON.parse(process.env.FINITE_BUILD_PROOF_FIXTURE);
    const read = fs.readFileSync;
    const calls = [];
    process.env.GITHUB_ACTIONS = fixture.actions;
    process.env.GITHUB_EVENT_NAME = 'pull_request';
    process.env.GITHUB_REPOSITORY = fixture.repository;
    process.env.GITHUB_EVENT_PATH = 'finite-build-proof-synthetic-event';
    if (fixture.mode === null) delete process.env.CHECK_MODE;
    else process.env.CHECK_MODE = fixture.mode;
    if (fixture.nodeEnv === null) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = fixture.nodeEnv;
    fs.readFileSync = (path, ...args) => path === process.env.GITHUB_EVENT_PATH
      ? JSON.stringify({pull_request: {head: {ref: fixture.branch, sha: 'c'.repeat(40), repo: {full_name: fixture.headRepository}},
          base: {sha: fixture.base, repo: {full_name: fixture.repository}}}})
      : read(path, ...args);
    childProcess.execFileSync = (file, args) => {
      calls.push([file, ...args]);
      if (file !== 'git') throw new Error('SYNTHETIC_EXTERNAL_FORBIDDEN');
      if (args[0] === 'rev-parse') return args[1] === fixture.base + '^{tree}' ? fixture.tree : 'a'.repeat(40);
      if (args[0] === 'diff') return fixture.paths.join('\\n');
      throw new Error('SYNTHETIC_SOURCE_BYTES_UNAVAILABLE');
    };
    syncBuiltinESMExports();
    const {canResumeOnlineBuildProofReuseGuard} = await import('./scripts/ci-recharge-scope.mjs');
    try { console.log(JSON.stringify({accepted: canResumeOnlineBuildProofReuseGuard(fixture.base, fixture.phase), calls})); }
    catch (error) { console.log(JSON.stringify({error: error.message, calls})); }
  `;
  return JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, FINITE_BUILD_PROOF_FIXTURE: JSON.stringify(fixture) }
    })
  );
}

test('finite build-proof rejects same-branch drift before external reads and never falls back after scoped authentication fails', () => {
  assert.deepEqual(recordBuildProofReuseAdmission({ actions: 'false' }), {
    accepted: false,
    calls: []
  });
  assert.deepEqual(recordBuildProofReuseAdmission({ branch: 'codex/unrelated' }), {
    accepted: false,
    calls: []
  });
  for (const change of [
    { base: '0'.repeat(40) },
    { repository: 'foreign/project' },
    { headRepository: 'foreign/project' },
    { mode: 'full' },
    { nodeEnv: 'production' },
    { phase: 'unknown' },
    { phase: 'scope', mode: 'full' },
    { phase: 'scope', nodeEnv: 'production' }
  ]) {
    const result = recordBuildProofReuseAdmission(change);
    assert.equal(result.error, 'Build-proof continuation scope changed');
    assert.deepEqual(result.calls, []);
  }
  for (const change of [
    { paths: [] },
    { paths: [...onlineBuildProofReuseGuardPaths, 'apps/api/src/auth/auth.service.ts'] },
    { paths: onlineBuildProofReuseGuardPaths.slice(1) },
    { tree: 'b'.repeat(40) }
  ]) {
    const result = recordBuildProofReuseAdmission(change);
    assert.equal(result.error, 'Build-proof continuation evidence unavailable');
    assert.ok(result.calls.every((call) => call[0] === 'git'));
    assert.equal('accepted' in result, false);
  }
  const scope = recordBuildProofReuseAdmission({ phase: 'scope', mode: null, nodeEnv: null });
  assert.equal(scope.error, 'Build-proof continuation evidence unavailable');
  assert.ok(scope.calls.some((call) => call[0] === 'git'));
  assert.equal('accepted' in scope, false);
});
// END finite ONLINE build-proof reuse guard tests

test('reviewed HTML cache directives keep Admin and real Nginx checks without admitting unrelated sealed images', () => {
  const paths = [
    ...adminHtmlCachePaths,
    'scripts/ci-recharge-scope.mjs',
    'scripts/ci-recharge-scope.test.mjs',
    'scripts/ci-recharge-check.mjs',
    'scripts/ci-recharge-check.test.mjs'
  ];
  assert.equal(isAdminHtmlCacheOnly(paths), true);
  assert.equal(checkMode(paths, '', ''), 'admin');
  assert.deepEqual(selectedParts(paths), ['guards', 'admin']);
  assert.equal(needsOnlineRechargeCiBuild(paths), false);
  assert.equal(isAdminHtmlCacheOnly([]), false);
  assert.equal(isAdminHtmlCacheOnly(['scripts/ci-recharge-scope.mjs']), false);
  const current = readFileSync(new URL('../deploy/nginx/admin.conf', import.meta.url));
  for (const raw of [
    current.toString().replace('    etag off;\n', ''),
    current
      .toString()
      .replace('proxy_pass http://api:3000/api/;', 'proxy_pass http://other:3000/api/;'),
    current.toString().replace('immutable', 'no-store')
  ])
    assert.equal(isAdminHtmlCacheOnly(paths, raw), false);
  for (const extra of [
    'apps/api/src/id-business-v2/online-recharge/online-recharge.service.ts',
    'apps/admin/src/v2/features/customers/CustomerPage.vue',
    'apps/api/Dockerfile.mysql',
    'apps/admin/Dockerfile',
    'package-lock.json',
    'deploy/nginx/other.conf',
    'scripts/acceptance-nginx-admin-cache.py.backup'
  ]) {
    assert.equal(isAdminHtmlCacheOnly([...paths, extra]), false, extra);
    assert.equal(needsOnlineRechargeCiBuild([...paths, extra]), true, extra);
  }
});

test('registration closure admits only its exact nullable facts and immutable migration', () => {
  const after = readFileSync('apps/api/prisma-mysql/schema.prisma', 'utf8');
  const facts = `  registrationIpEncrypted String?                      @map("registration_ip_encrypted") @db.Text
  registeredAt        DateTime?                        @map("registered_at") @db.DateTime(6)
`;
  assert.equal(after.split(facts).length, 2);
  const before = after.replace(facts, '');
  const sql = readFileSync(registrationFactsMigration, 'utf8');
  const paths = [
    'apps/api/prisma-mysql/schema.prisma',
    registrationFactsMigration,
    'apps/api/src/id-business-v2/auto-registration/apple-mailboxes.service.ts',
    'apps/api/src/id-business-v2/proxy-pool/proxy-test.ts',
    'scripts/ci-registration-closure-scope.mjs'
  ];
  assert.equal(registrationFactsSchemaProof(paths, before, after, sql), true);
  assert.equal(isRegistrationClosureOnly(paths, before, after, sql), true);
  assert.equal(checkMode(paths, before, after), 'recharge');
  assert.deepEqual(selectedParts(paths), ['guards', 'api', 'migration']);
  for (const [changed, oldSource, newSource, migration] of [
    [paths.filter((path) => path !== registrationFactsMigration), before, after, sql],
    [paths.filter((path) => !path.endsWith('schema.prisma')), before, after, sql],
    [
      paths,
      before,
      after.replace('registeredAt        DateTime?', 'registeredAt        DateTime'),
      sql
    ],
    [paths, before, after + '\nmodel Extra { id String }\n', sql],
    [paths, before, after.replace(facts, '') + facts, sql],
    [paths, before, after, sql + '\nDELETE FROM secret;'],
    [paths, after, after, sql],
    [paths, undefined, after, sql]
  ])
    assert.equal(registrationFactsSchemaProof(changed, oldSource, newSource, migration), false);
  for (const extra of [
    'apps/api/src/id-business-v2/auto-recharge/worker/pay.py',
    'apps/api/src/auth/auth.service.ts',
    'apps/api/prisma-mysql/migrations/unreviewed/migration.sql',
    'apps/admin/src/v2/features/customers/CustomerPage.vue',
    'docker-compose.aws-mysql.yml',
    'package-lock.json',
    'scripts/production-release/registration-closure-unreviewed.py'
  ]) {
    assert.equal(isRegistrationClosureOnly([...paths, extra], before, after, sql), false, extra);
    assert.equal(checkMode([...paths, extra], before, after), 'full', extra);
  }
});

test('registration closure selects independent browser, API and both database responsibilities', () => {
  const paths = [
    'apps/admin/src/v2/features/auto-registration/V2AppleMailboxes.vue',
    'apps/api/src/id-business-v2/auto-registration/worker/test_registration_closed_loop_unit.py',
    'apps/api/src/id-business-v2/auto-registration/apple-mailbox-main-sync.ts',
    'apps/api/src/id-business-v2/auto-registration/apple-mailbox-manual-sync.ts',
    'apps/api/src/id-business-v2/auto-recharge/bank-recharge-registration-mirror.service.ts',
    'apps/api/src/id-business-v2/online-recharge/mysql.integration.spec.ts',
    'apps/api/src/id-business-v2/online-recharge/proxy-tests.mysql.integration.spec.ts',
    'scripts/acceptance-v2-registration-inventory-ui.mjs',
    'scripts/acceptance-v2-registration-native-ui.mjs',
    'scripts/acceptance-v2-shared-proxy-mysql.mjs'
  ];
  assert.equal(checkMode(paths, schema, schema), 'recharge');
  assert.deepEqual(selectedParts(paths), ['guards', 'admin', 'api', 'migration']);
  assert.equal(hasAppleMailboxScope(paths), true);
  const commands = adminCheckCommands('recharge', paths).map((args) => args.join(' '));
  for (const expected of [
    'exec -- node scripts/acceptance-v2-registration-inventory-ui.mjs',
    'run auto-registration:setup',
    'exec -- node scripts/acceptance-v2-registration-native-ui.mjs'
  ])
    assert.equal(commands.filter((command) => command === expected).length, 0, expected);
  assert.deepEqual(selectedParts(['scripts/acceptance-v2-shared-proxy-mysql.mjs']), [
    'guards',
    'migration'
  ]);
});

test('registration runtime acceptance selects the exact API fixture without admitting adjacent worker files', () => {
  const fixture = 'apps/api/src/id-business-v2/auto-registration/worker/acceptance_runtime.py';
  const paths = [registrationPublishedBindingPath, fixture];
  assert.equal(isRegistrationClosureOnly(paths, schema, schema), true);
  assert.equal(isRegistrationClosureControlsOnly(paths), false);
  assert.equal(checkMode(paths, schema, schema), 'recharge');
  assert.deepEqual(selectedParts(paths), ['guards', 'api']);
  assert.equal(hasAppleMailboxScope([fixture]), true);
  for (const unknown of [
    'apps/api/src/id-business-v2/auto-registration/worker/acceptance_unreviewed.py',
    'apps/api/src/id-business-v2/auto-registration/worker/upstream/acceptance_runtime.py'
  ]) {
    assert.equal(isRegistrationClosureOnly([...paths, unknown], schema, schema), false);
    assert.equal(checkMode([...paths, unknown], schema, schema), 'full');
    assert.equal(hasAppleMailboxScope([unknown]), false);
  }
});

test('registration closure controls stay finite without moving unrelated source into control-only checks', () => {
  const paths = [
    '.github/workflows/registration-closure-validation.yml',
    'scripts/production-release/registration-closure-release.py',
    'scripts/ci-registration-closure-scope.mjs',
    'docs/REGISTRATION_CLOSURE_RELEASE_20261016.md'
  ];
  assert.equal(isRegistrationClosureControlsOnly(paths), true);
  assert.equal(checkMode(paths, schema, schema), 'ci-only');
  assert.deepEqual(selectedParts(paths), ['guards']);
  assert.equal(isRegistrationClosureControlsOnly([]), false);
  assert.equal(isRegistrationClosureControlsOnly([...paths, 'package.json']), false);
  const business = [...paths, 'apps/api/src/id-business-v2/proxy-pool/proxy-test.ts'];
  assert.equal(isRegistrationClosureControlsOnly(business), false);
  assert.equal(checkMode(business, schema, schema), 'recharge');
});

test('registration closure uses its new image proof while unknown image and payment inputs keep historical checks', () => {
  const paths = [
    'apps/api/src/id-business-v2/online-recharge/engine/proxy-test.cjs',
    'scripts/ci-recharge-scope.mjs',
    '.github/workflows/registration-closure-validation.yml'
  ];
  assert.equal(needsOnlineRechargeCiBuild(paths), false);
  for (const extra of [
    'apps/api/Dockerfile.mysql',
    'apps/admin/Dockerfile',
    'package-lock.json',
    'apps/api/src/id-business-v2/online-recharge/engine/upstream/payment.js',
    'apps/api/src/id-business-v2/auto-recharge/worker/pay.py',
    'scripts/production-release/registration-closure-unreviewed.py'
  ])
    assert.equal(needsOnlineRechargeCiBuild([...paths, extra]), true, extra);
  assert.deepEqual(
    selectedParts([
      'apps/api/src/id-business-v2/online-recharge/proxy-tests.mysql.integration.spec.ts'
    ]),
    ['guards', 'api', 'migration']
  );
});

test('published recovery authenticates the exact source receipt and retained combined files', () => {
  const bindingBytes = readFileSync(registrationPublishedBindingPath);
  const binding = JSON.parse(bindingBytes);
  const paths = [registrationPublishedBindingPath, ...Object.keys(binding.sources)];
  assert.equal(Object.keys(binding.sources).length, 69);
  assert.equal(Object.keys(binding.combinedSources).length, 10);
  assert.equal(Object.keys(binding.validationSources).length, 7);
  assert.equal(hasRegistrationPublishedRecovery(paths), true);
  assert.equal(registrationPublishedRecoveryProof(paths), true);
  assert.equal(
    binding.sources['apps/admin/src/v2/features/auto-recharge/recharge-proxies-manifest.ts'],
    undefined
  );
  for (const invalidBytes of [
    Buffer.alloc(0),
    Buffer.concat([bindingBytes, Buffer.from(' ')]),
    Buffer.from(JSON.stringify({ ...binding, nativeRunId: '0' }))
  ]) {
    assert.equal(registrationPublishedRecoveryProof(paths, { bindingBytes: invalidBytes }), false);
  }
  for (const changed of [
    'apps/api/src/id-business-v2/auto-recharge/bank-recharge-finance.service.ts',
    'apps/api/src/id-business-v2/auto-recharge/persistence/bank-recharge.repository.ts',
    'apps/api/src/id-business-v2/online-recharge/persistence/worker.repository.ts',
    'apps/api/prisma-mysql/migrations/20261015110000_online_recharge_pro_500/migration.sql',
    'apps/api/prisma-mysql/migrations/20261016090000_online_recharge_orders/migration.sql',
    ...Object.keys(binding.validationSources)
  ]) {
    const readSource = (path) =>
      path === changed ? Buffer.from('UNREVIEWED') : readFileSync(path);
    assert.equal(registrationPublishedRecoveryProof(paths, { readSource }), false, changed);
  }
  assert.equal(
    registrationPublishedRecoveryProof(paths, {
      readSource: () => {
        throw new Error('missing');
      }
    }),
    false
  );
});

test('historical registration recovery rejects current layout and proxy-country source bytes', () => {
  const paths = [
    registrationPublishedBindingPath,
    ...registrationLayoutPaths,
    ...registrationCountryPaths
  ];
  assert.equal(registrationPublishedRecoveryProof(paths), true);
  for (const changed of [...registrationLayoutPaths, ...registrationCountryPaths]) {
    const readSource = (path) =>
      path === changed ? actualReadFileSync(path) : readRegistrationFixture(path);
    assert.equal(registrationPublishedRecoveryProof(paths, { readSource }), false, changed);
  }
});

test('historical registration recovery rejects current Sales sources schema and migration', () => {
  const binding = JSON.parse(readFileSync(registrationPublishedBindingPath));
  const paths = [
    registrationPublishedBindingPath,
    ...Object.keys(binding.sources),
    registrationFactsMigration
  ];
  assert.equal(registrationPublishedRecoveryProof(paths), true);
  for (const changed of registrationSalesPaths) {
    const readSource = (path) =>
      path === changed ? actualReadFileSync(path) : readRegistrationFixture(path);
    assert.equal(registrationPublishedRecoveryProof(paths, { readSource }), false, changed);
  }
  const before = execFileSync(
    'git',
    ['show', '07e28beb3fbb1fc5c9dac8050e16b3f00e0b1083:apps/api/prisma-mysql/schema.prisma'],
    { encoding: 'utf8' }
  );
  const schemaPath = 'apps/api/prisma-mysql/schema.prisma';
  const historical = readRegistrationFixture(schemaPath, 'utf8');
  const current = actualReadFileSync(schemaPath, 'utf8');
  assert.notEqual(current, historical);
  assert.equal(registrationFactsSchemaProof(paths, before, historical), true);
  assert.equal(registrationFactsSchemaProof(paths, before, current), false);
  assert.equal(checkMode(paths, before, current), 'full');
  const withSaleMigration = [
    ...paths,
    'apps/api/prisma-mysql/migrations/20261016170000_chatgpt_account_sale_status/migration.sql'
  ];
  assert.equal(isRegistrationClosureOnly(withSaleMigration, before, historical), false);
  assert.equal(checkMode(withSaleMigration, before, historical), 'full');
});

test('published recovery proves only two new fields above the recovered deployed schema and exact prior migrations', () => {
  const binding = JSON.parse(readFileSync(registrationPublishedBindingPath));
  const before = execFileSync(
    'git',
    ['show', '07e28beb3fbb1fc5c9dac8050e16b3f00e0b1083:apps/api/prisma-mysql/schema.prisma'],
    { encoding: 'utf8' }
  );
  const after = readFileSync('apps/api/prisma-mysql/schema.prisma', 'utf8');
  const paths = [
    registrationPublishedBindingPath,
    ...Object.keys(binding.sources),
    registrationFactsMigration
  ];
  assert.equal(registrationFactsSchemaProof(paths, before, after), true);
  assert.equal(isRegistrationClosureOnly(paths, before, after), true);
  assert.equal(checkMode(paths, before, after), 'recharge');
  assert.deepEqual(selectedParts(paths), ['guards', 'admin', 'api', 'migration']);
  assert.equal(needsOnlineRechargeCiBuild(paths), false);
  for (const omitted of Object.keys(binding.migrations)) {
    const partial = paths.filter((path) => path !== omitted);
    assert.equal(registrationFactsSchemaProof(partial, before, after), false, omitted);
    assert.equal(checkMode(partial, before, after), 'full', omitted);
    assert.equal(isTargetedOnly(partial, before, after), false, omitted);
  }
  for (const drift of [before + '\n', before.replace('chargeAmount', 'unreviewedAmount')])
    assert.equal(registrationFactsSchemaProof(paths, drift, after), false);
  assert.equal(
    registrationFactsSchemaProof(paths, before, after.replace('pro_500', 'unreviewed_plan')),
    false
  );
  for (const unreviewed of [
    'apps/api/src/id-business-v2/auto-recharge/bank-recharge-payment-new.ts',
    'apps/admin/src/v2/features/auto-recharge/recharge-proxies-manifest.ts',
    'apps/api/prisma-mysql/migrations/20261016090000_online_recharge_orders/extra.sql',
    'apps/api/src/id-business-v2/online-recharge/engine/upstream/payment.js',
    'apps/api/src/auth/auth.service.ts',
    'package-lock.json'
  ]) {
    assert.equal(checkMode([...paths, unreviewed], before, after), 'full', unreviewed);
    assert.equal(isTargetedOnly([...paths, unreviewed], before, after), false, unreviewed);
  }
});

test('published dynamic table control recovery stays exact and control-only', () => {
  const controls = [
    'scripts/check-v2-table-standard.mjs',
    'scripts/lib/v2-table-schema-alias.mjs',
    'scripts/v2-table-schema-alias.test.mjs'
  ];
  const paths = [registrationPublishedBindingPath, ...controls];
  assert.equal(registrationPublishedRecoveryProof(paths), true);
  assert.equal(isRegistrationClosureControlsOnly(paths), true);
  assert.equal(checkMode(paths, schema, schema), 'ci-only');
  assert.deepEqual(selectedParts(paths), ['guards']);
  for (const changed of controls) {
    const readSource = (path) =>
      path === changed ? Buffer.from('UNREVIEWED') : readFileSync(path);
    assert.equal(registrationPublishedRecoveryProof(paths, { readSource }), false, changed);
  }
  assert.equal(
    registrationPublishedRecoveryProof(paths, {
      readSource: (path) =>
        path === 'scripts/check-v2-table-standard.mjs'
          ? actualReadFileSync(path)
          : readRegistrationFixture(path)
    }),
    false
  );
  assert.equal(
    checkMode([...paths, 'scripts/lib/unreviewed-table-alias.mjs'], schema, schema),
    'full'
  );
});

test('last published Admin layer preserves its real one-line successor without inventing native verification', () => {
  const binding = JSON.parse(readFileSync(registrationPublishedBindingPath));
  const [layer] = binding.publishedSuccessorLayers;
  const path = 'apps/admin/src/v2/features/online-recharge/OnlineOrderBackfill.vue';
  assert.equal(binding.publishedSuccessorLayers.length, 1);
  assert.deepEqual(Object.keys(layer.sources), [path]);
  assert.equal(layer.publicationCommit, '6d1db82cde92e8c02fea6254289c4b410e94016a');
  assert.equal(layer.frontendNativeVerification, 'NOT_RECORDED_IN_MANIFEST');
  assert.equal(layer.backendNativeRunId, binding.nativeRunId);
  assert.equal(
    createHash('sha256').update(readFileSync(path)).digest('hex'),
    layer.sources[path].publishedSha256
  );
  assert.notEqual(layer.sources[path].publishedSha256, binding.sources[path].publishedSha256);
  const readSource = (name) =>
    name === path
      ? execFileSync('git', ['show', binding.publicationCommit + ':' + name])
      : readFileSync(name);
  assert.equal(registrationPublishedRecoveryProof([registrationPublishedBindingPath, path]), true);
  assert.equal(
    registrationPublishedRecoveryProof([registrationPublishedBindingPath, path], { readSource }),
    false
  );
});

test('published fixture recovery admits only its three exact existing test sources', () => {
  const paths = [
    registrationPublishedBindingPath,
    'apps/api/src/id-business-v2/auto-recharge/bank-recharge-plan-catalog.spec.ts',
    'apps/api/src/id-business-v2/auto-recharge/persistence/bank-recharge-query.repository.spec.ts',
    'apps/api/src/id-business-v2/online-recharge/validation.spec.ts'
  ];
  assert.equal(registrationPublishedRecoveryProof(paths), true);
  assert.equal(checkMode(paths, schema, schema), 'recharge');
  assert.deepEqual(selectedParts(paths), ['guards', 'api']);
  for (const extra of [
    'apps/api/src/id-business-v2/auto-recharge/bank-recharge-plan-catalog.ts',
    'apps/api/src/id-business-v2/auto-recharge/persistence/unknown-query.repository.spec.ts'
  ]) {
    assert.equal(checkMode([...paths, extra], schema, schema), 'full', extra);
  }
});

test('registration closure real CLI preserves schema blob bytes for exact published recovery', () => {
  const { reviewBase: base } = JSON.parse(
    readFileSync('scripts/production-release/registration-closure-contract.json', 'utf8')
  );
  assert.match(base, /^[a-f0-9]{40}$/);
  const before = execFileSync('git', ['show', base + ':apps/api/prisma-mysql/schema.prisma'], {
    encoding: 'utf8'
  });
  const after = readFileSync('apps/api/prisma-mysql/schema.prisma', 'utf8');
  const paths = execFileSync('git', ['diff', '--name-only', base, registrationPublishedHead], {
    encoding: 'utf8'
  })
    .trim()
    .split('\n');
  assert.ok(before.endsWith('\n') && after.endsWith('\n'));
  assert.equal(checkMode(paths, before.trim(), after.trim()), 'full');
  const classify = (changed, oldSource = before) =>
    recordScopeClassification(changed, {}, 'pull_request', {
      schemaBefore: oldSource,
      schemaAfter: after
    }).result;
  const positive = classify(paths);
  assert.equal(positive.mode, 'recharge');
  assert.deepEqual(positive.checkParts, ['guards', 'admin', 'api', 'migration']);
  assert.equal(positive.onlineCiBuild, false);
  assert.equal(classify([...paths, 'apps/api/src/auth/auth.service.ts']).mode, 'full');
  assert.equal(classify(paths, before + '\n').mode, 'full');
});

test('scope CLI fixture transport preserves schema blobs larger than a Linux environment item', () => {
  const before = schema + '\n// ' + '原始字节'.repeat(20_000) + '\n';
  const after = before + '\n';
  assert.ok(Buffer.byteLength(before) > 128 * 1024);
  const value = recordScopeClassification(['scripts/ci-recharge-scope.mjs'], {}, 'pull_request', {
    schemaBefore: before,
    schemaAfter: after,
    fixtureTransferProbe: true
  });
  assert.equal(value.result.mode, 'ci-only');
  assert.deepEqual(value.fixtureTransfer, {
    beforeBytes: Buffer.byteLength(before),
    beforeSha256: createHash('sha256').update(before).digest('hex'),
    afterBytes: Buffer.byteLength(after),
    afterSha256: createHash('sha256').update(after).digest('hex')
  });
  const source = readFileSync('scripts/ci-recharge-scope.test.mjs', 'utf8');
  const fixture = source.slice(
    source.indexOf('function recordScopeClassification('),
    source.indexOf("test('bank-card policy controls")
  );
  assert.equal(/process\.env\.SCOPE_TEST_(?:PATHS|SNAPSHOT|OPTIONS|SCHEMA)/.test(fixture), false);
});

test('proxy-result identity source remains application scope and rejects schema or unknown source drift', () => {
  const paths = [...proxyResultIdentityPaths];
  const context = {
    base: proxyResultIdentityBase,
    baseTree: proxyResultIdentityTree,
    sourceDigest: (path) => proxyResultIdentityPins[path]
  };
  assert.equal(checkMode(paths, schema, schema, undefined, context), 'recharge');
  assert.deepEqual(selectedParts(paths, undefined, context), ['guards', 'online-engine']);
  assert.equal(needsOnlineRechargeCiBuild(paths, context), false);
  assert.equal(checkMode(paths, schema, schema + '\n', undefined, context), 'full');
  assert.equal(
    checkMode([...paths, 'apps/api/src/auth/auth.service.ts'], schema, schema, undefined, context),
    'full'
  );
});

test('historical recovery never accepts advanced main or online settings source bytes', () => {
  const paths = [registrationPublishedBindingPath, ...registrationAdvancedPaths];
  assert.equal(registrationPublishedRecoveryProof(paths), true);
  for (const changed of registrationAdvancedPaths) {
    const readSource = (path) =>
      path === changed ? actualReadFileSync(path) : readRegistrationFixture(path);
    assert.equal(registrationPublishedRecoveryProof(paths, { readSource }), false, changed);
  }
});

test('GPT integration cannot qualify the immutable historical registration receipt', () => {
  const path = 'apps/api/src/id-business-v2/online-recharge/online-recharge.module.ts';
  assert.equal(registrationPublishedRecoveryProof([registrationPublishedBindingPath, path]), true);
  const readSource = (name) =>
    name === path ? actualReadFileSync(name) : readRegistrationFixture(name);
  assert.equal(
    registrationPublishedRecoveryProof([registrationPublishedBindingPath, path], { readSource }),
    false
  );
});

test('terminal entry contract repair stays on its exact published tree and control paths', () => {
  const context = {
    ...terminalStopFixture(),
    base: registrationTerminalStopRepairBase,
    baseTree: registrationTerminalStopRepairTree
  };
  const paths = [...registrationTerminalStopRepairPaths];
  assert.equal(paths.length, 8);
  assert.equal(isRegistrationTerminalStopOnly(paths, context), true);
  assert.equal(checkMode(paths, 'same', 'same', undefined, context), 'recharge');
  assert.deepEqual(selectedParts(paths, undefined, context), [
    ...registrationTerminalStopRepairParts
  ]);
  assert.equal(needsOnlineRechargeCiBuild(paths, context), false);
  for (const changed of [
    paths.slice(1),
    [...paths, paths[0]],
    [...paths, ...registrationTerminalStopApplications],
    [...paths, 'scripts/production-release/registration-terminal-stop-release.py']
  ]) {
    assert.equal(isRegistrationTerminalStopOnly(changed, context), false);
    assert.equal(checkMode(changed, 'same', 'same', undefined, context), 'full');
  }
  for (const override of [
    { base: '0'.repeat(40) },
    { baseTree: '0'.repeat(40) },
    { sourceDigest: () => 'b'.repeat(64) }
  ]) {
    assert.equal(isRegistrationTerminalStopOnly(paths, { ...context, ...override }), false);
  }
  assert.equal(checkMode(paths, 'old', 'new', undefined, context), 'full');
});

test('fresh Session subscription preflight selects only Admin and cannot hide payment source edits', () => {
  const schema = 'unchanged';
  const paths = [...onlineSessionPreflightPaths, ...onlineSessionPreflightControls];
  assert.equal(checkMode(paths, schema, schema), 'recharge');
  assert.deepEqual(selectedParts(paths), ['guards', 'admin']);
  assert.equal(checkMode(paths, 'before', 'after'), 'full');
  const controls = onlineSessionPreflightControls.filter((name) => !name.startsWith('scripts/ci-'));
  assert.equal(checkMode(controls, schema, schema), 'ci-only');
  assert.deepEqual(selectedParts(controls), ['guards']);
  for (const extra of [
    'apps/api/src/id-business-v2/online-recharge/persistence/tasks.repository.ts',
    'apps/api/src/id-business-v2/online-recharge/engine/confirmation.cjs',
    'apps/admin/src/v2/features/online-recharge/api.ts',
    'scripts/production-release/online-session-preflight-arbitrary.py'
  ])
    assert.equal(checkMode([...paths, extra], schema, schema), 'full', extra);
});

test('initialization engine-only changes cannot hide an API or payment policy change', () => {
  const sources = [
    ...onlineCheckoutInitializationPaths,
    'docs/ONLINE_RECHARGE.md',
    'docs/V2_TASKS.md'
  ];
  const paths = [...sources, ...onlineCheckoutInitializationControls];
  assert.equal(checkMode(paths, 'same', 'same'), 'recharge');
  assert.deepEqual(selectedParts(paths), ['guards', 'online-engine']);
  assert.equal(needsOnlineRechargeCiBuild(paths), false);
  assert.equal(checkMode(paths, 'before', 'after'), 'full');
  assert.equal(onlineCheckoutInitializationPaths.length, 20);
  for (const name of ['checkout-form.cjs', 'test/checkout-form.test.cjs']) {
    const required = `apps/api/src/id-business-v2/online-recharge/engine/${name}`;
    assert.ok(paths.includes(required));
    assert.equal(
      checkMode(
        paths.filter((path) => path !== required),
        'same',
        'same'
      ),
      'full'
    );
  }
  for (const name of [
    'auth-navigation',
    'login-evidence-browser',
    'session-probe',
    'upstream-session-transition'
  ]) {
    const required = `apps/api/src/id-business-v2/online-recharge/engine/test/${name}.test.cjs`;
    assert.ok(paths.includes(required));
    assert.equal(
      checkMode(
        paths.filter((path) => path !== required),
        'same',
        'same'
      ),
      'full'
    );
  }
  for (const extra of [
    'apps/api/src/id-business-v2/online-recharge/tasks.service.ts',
    'apps/api/src/id-business-v2/online-recharge/engine/payment-limit.cjs',
    'package-lock.json'
  ])
    assert.equal(checkMode([...paths, extra], 'same', 'same'), 'full');
});

test('checkout actionability selects finite engine checks and cannot hide neighboring changes', () => {
  const sources = [...onlineCheckoutActionabilityPaths, 'docs/ONLINE_RECHARGE.md'];
  const paths = [...sources, ...onlineCheckoutActionabilityControls];
  for (const candidate of [sources, paths]) {
    assert.equal(checkMode(candidate, 'same', 'same'), 'recharge');
    assert.deepEqual(selectedParts(candidate), ['guards', 'online-engine']);
    assert.equal(needsOnlineRechargeCiBuild(candidate), false);
    assert.equal(checkMode(candidate, 'before', 'after'), 'full');
  }
  const controls = onlineCheckoutActionabilityControls.filter(
    (path) => !path.startsWith('scripts/ci-')
  );
  assert.equal(checkMode(controls, 'same', 'same'), 'ci-only');
  assert.deepEqual(selectedParts(controls), ['guards']);
  assert.equal(needsOnlineRechargeCiBuild(controls), false);
  for (const missing of sources)
    assert.equal(
      checkMode(
        sources.filter((path) => path !== missing),
        'same',
        'same'
      ),
      'full',
      missing
    );
  assert.equal(checkMode([...paths, paths[0]], 'same', 'same'), 'full');
  for (const extra of [
    'apps/api/src/id-business-v2/online-recharge/tasks.service.ts',
    'apps/admin/src/v2/features/online-recharge/sections.ts',
    'apps/api/prisma-mysql/schema.prisma',
    'package-lock.json',
    'apps/api/src/id-business-v2/online-recharge/engine/upstream/stripe-payment.js',
    'scripts/production-release/online-query-deadline-build.py',
    'scripts/ci-recharge-check.mjs'
  ])
    assert.equal(checkMode([...paths, extra], 'same', 'same'), 'full', extra);
});

test('query deadline repair selects only guards and engine without narrowing unrelated edits', () => {
  const paths = [...onlineQueryDeadlinePaths, ...onlineQueryDeadlineControls];
  assert.equal(checkMode(paths, 'same', 'same'), 'recharge');
  assert.deepEqual(selectedParts(paths), ['guards', 'online-engine']);
  assert.equal(needsOnlineRechargeCiBuild(paths), false);
  const controls = onlineQueryDeadlineControls.filter((path) => !path.startsWith('scripts/ci-'));
  assert.equal(checkMode(controls, 'same', 'same'), 'ci-only');
  assert.deepEqual(selectedParts(controls), ['guards']);
  assert.equal(needsOnlineRechargeCiBuild(controls), false);
  assert.equal(checkMode(paths, 'before', 'after'), 'full');
  for (const extra of [
    'apps/api/src/id-business-v2/online-recharge/tasks.service.ts',
    'apps/admin/src/v2/features/online-recharge/sections.ts',
    'apps/api/prisma-mysql/schema.prisma',
    'package-lock.json',
    'apps/api/src/id-business-v2/online-recharge/engine/upstream/payment-retry.js',
    'scripts/production-release/online-query-network-build.py'
  ])
    assert.equal(checkMode([...paths, extra], 'same', 'same'), 'full', extra);
});

test('query network repair keeps all four checks and rejects an unrelated core payment edit', () => {
  const paths = [...onlineQueryNetworkPaths, ...onlineQueryNetworkControls];
  assert.equal(checkMode(paths, 'same', 'same'), 'recharge');
  assert.deepEqual(selectedParts(paths), ['guards', 'api', 'admin', 'online-engine']);
  assert.equal(
    checkMode(
      [...paths, 'apps/api/src/id-business-v2/online-recharge/engine/upstream/payment-retry.js'],
      'same',
      'same'
    ),
    'full'
  );
});
import {
  isBitbrowserBillingControlsOnly as finiteBillingOnly,
  bitbrowserBillingControlPaths as finiteBillingPaths,
  isCiOnly as finiteBillingCiOnly,
  selectedParts as finiteBillingParts,
  needsOnlineRechargeCiBuild as finiteBillingNeedsEngine
} from './ci-recharge-scope.mjs';
import {
  isBitbrowserRecoveryControlsOnly as finiteRecoveryOnly,
  bitbrowserRecoveryControlPaths as finiteRecoveryPaths,
  bitbrowserRecoverySourceReviewCommit as finiteRecoveryCommit,
  bitbrowserRecoverySourceReviewTree as finiteRecoveryTree,
  isBitbrowserRecoveryControlRepair as finiteRecoveryRepair,
  bitbrowserRecoveryControlRepairBase as finiteRecoveryRepairBase,
  bitbrowserRecoveryControlRepairTree as finiteRecoveryRepairTree,
  bitbrowserRecoveryControlRepairPaths as finiteRecoveryRepairPaths
} from './ci-recharge-scope.mjs';
import {
  isBitbrowserHistoryControlsOnly as finiteHistoryOnly,
  bitbrowserHistoryControlPaths as finiteHistoryPaths,
  bitbrowserHistorySourceReviewCommit as finiteHistoryCommit,
  bitbrowserHistorySourceReviewTree as finiteHistoryTree
} from './ci-recharge-scope.mjs';

test('finite history controls reuse application QA only over their exact ten files and source base', () => {
  const context = { base: finiteHistoryCommit, baseTree: finiteHistoryTree };
  assert.equal(finiteHistoryPaths.length, 10);
  assert.equal(finiteHistoryOnly(finiteHistoryPaths, context), true);
  assert.equal(finiteHistoryOnly(finiteHistoryPaths, { ...context, base: 'b'.repeat(40) }), true);
  assert.equal(finiteBillingCiOnly(finiteHistoryPaths, context), true);
  assert.equal(checkMode(finiteHistoryPaths, 'same', 'same', undefined, context), 'ci-only');
  assert.deepEqual(finiteBillingParts(finiteHistoryPaths, undefined, context), [
    'guards',
    'release-controls'
  ]);
  assert.equal(finiteBillingNeedsEngine(finiteHistoryPaths, context), false);
  assert.equal(checkMode(finiteHistoryPaths, 'before', 'after', undefined, context), 'full');
  for (const invalid of [
    undefined,
    { base: finiteHistoryCommit },
    { ...context, base: 'main' },
    { ...context, base: 'b'.repeat(39) },
    { ...context, baseTree: 'a'.repeat(40) },
    { base: finiteRecoveryCommit, baseTree: finiteRecoveryTree }
  ]) {
    assert.equal(finiteHistoryOnly(finiteHistoryPaths, invalid), false);
    assert.equal(checkMode(finiteHistoryPaths, 'same', 'same', undefined, invalid), 'full');
  }
  for (const missing of finiteHistoryPaths) {
    const paths = finiteHistoryPaths.filter((name) => name !== missing);
    assert.equal(finiteHistoryOnly(paths, context), false, missing);
    assert.equal(checkMode(paths, 'same', 'same', undefined, context), 'full', missing);
  }
  for (const extra of [
    'apps/api/src/id-business-v2/auto-recharge/persistence/recharge.repository.ts',
    'apps/api/src/id-business-v2/auto-recharge/recharge-account-restore.ts',
    'apps/admin/src/v2/features/auto-recharge/recharge-form.ts',
    'packages/shared/src/v2/checkout-diagnostic.ts',
    'apps/api/prisma-mysql/schema.prisma',
    'package-lock.json',
    '.github/workflows/quality.yml',
    'scripts/production-release/bitbrowser-recovery-release.py',
    'scripts/production-release/bitbrowser-history-unreviewed.py'
  ]) {
    assert.equal(finiteHistoryOnly([...finiteHistoryPaths, extra], context), false, extra);
    assert.equal(
      checkMode([...finiteHistoryPaths, extra], 'same', 'same', undefined, context),
      'full',
      extra
    );
  }
  assert.equal(finiteHistoryOnly([], context), false);
  assert.equal(
    finiteHistoryOnly([...finiteHistoryPaths.slice(1), finiteHistoryPaths[1]], context),
    false
  );
});

test('finite history PR and same-tree main CLI publish both final control matrix entries', () => {
  for (const base of [finiteHistoryCommit, 'b'.repeat(40)]) {
    for (const eventName of ['pull_request', 'push']) {
      const { result, writes, gitCalls } = recordScopeClassification(
        finiteHistoryPaths,
        {},
        eventName,
        { base, baseTree: finiteHistoryTree }
      );
      assert.equal(result.mode, 'ci-only');
      assert.deepEqual(result.checkParts, ['guards', 'release-controls']);
      assert.equal(result.onlineCiBuild, false);
      assert.equal(result.reuseMain, eventName === 'push');
      assert.ok(
        writes.some(({ contents }) =>
          contents.includes('check_parts=["guards","release-controls"]\n')
        )
      );
      assert.ok(gitCalls.some((args) => args.join(' ') === 'rev-parse ' + base + '^{tree}'));
    }
  }
  for (const eventName of ['pull_request', 'push']) {
    for (const { paths, baseTree } of [
      { paths: finiteHistoryPaths, baseTree: 'a'.repeat(40) },
      ...finiteHistoryPaths.map((missing) => ({
        paths: finiteHistoryPaths.filter((name) => name !== missing),
        baseTree: finiteHistoryTree
      })),
      {
        paths: [
          ...finiteHistoryPaths,
          'apps/api/src/id-business-v2/auto-recharge/persistence/recharge.repository.ts'
        ],
        baseTree: finiteHistoryTree
      }
    ]) {
      const { result, writes } = recordScopeClassification(paths, {}, eventName, {
        base: 'b'.repeat(40),
        baseTree
      });
      assert.equal(result.mode, 'full');
      assert.notDeepEqual(result.checkParts, ['guards', 'release-controls']);
      assert.equal(
        writes.some(({ contents }) =>
          contents.includes('check_parts=["guards","release-controls"]\n')
        ),
        false
      );
    }
  }
});

test('finite recovery controls reuse reviewed business QA only over the exact frozen tree', () => {
  const context = { base: finiteRecoveryCommit, baseTree: finiteRecoveryTree };
  assert.equal(finiteRecoveryPaths.length, 10);
  assert.equal(finiteRecoveryOnly(finiteRecoveryPaths, context), true);
  assert.equal(finiteBillingCiOnly(finiteRecoveryPaths, context), true);
  assert.equal(checkMode(finiteRecoveryPaths, 'same', 'same', undefined, context), 'ci-only');
  assert.deepEqual(finiteBillingParts(finiteRecoveryPaths, undefined, context), ['guards']);
  assert.equal(finiteBillingNeedsEngine(finiteRecoveryPaths, context), false);
  // A squash merge changes the commit identity while preserving the tested source tree.
  assert.equal(finiteRecoveryOnly(finiteRecoveryPaths, { ...context, base: 'b'.repeat(40) }), true);
  assert.equal(checkMode(finiteRecoveryPaths, 'before', 'after', undefined, context), 'full');
  for (const invalid of [
    undefined,
    { base: finiteRecoveryCommit },
    { ...context, base: 'main' },
    { ...context, baseTree: 'a'.repeat(40) }
  ]) {
    assert.equal(finiteRecoveryOnly(finiteRecoveryPaths, invalid), false);
    assert.equal(checkMode(finiteRecoveryPaths, 'same', 'same', undefined, invalid), 'full');
  }
  for (const missing of finiteRecoveryPaths)
    assert.equal(
      finiteRecoveryOnly(
        finiteRecoveryPaths.filter((p) => p !== missing),
        context
      ),
      false
    );
  for (const extra of [
    'apps/admin/src/v2/features/auto-recharge/recharge-form.ts',
    'apps/api/src/id-business-v2/auto-recharge/recharge-resolution.ts',
    'packages/shared/src/v2/checkout-diagnostic.ts',
    'apps/api/prisma-mysql/schema.prisma',
    'package-lock.json',
    '.github/workflows/quality.yml',
    'scripts/production-release/bitbrowser-billing-release.py',
    'scripts/production-release/bitbrowser-recovery-unreviewed.py'
  ]) {
    assert.equal(finiteRecoveryOnly([...finiteRecoveryPaths, extra], context), false, extra);
    assert.equal(
      checkMode([...finiteRecoveryPaths, extra], 'same', 'same', undefined, context),
      'full',
      extra
    );
  }
  assert.equal(finiteRecoveryOnly([], context), false);
  assert.equal(
    finiteRecoveryOnly([...finiteRecoveryPaths.slice(1), finiteRecoveryPaths[1]], context),
    false
  );
});

test('finite recovery declaration control repair admits only its exact eight files and baseline', () => {
  const context = { base: finiteRecoveryRepairBase, baseTree: finiteRecoveryRepairTree };
  assert.equal(finiteRecoveryRepairPaths.length, 8);
  assert.equal(finiteRecoveryRepair(finiteRecoveryRepairPaths, context), true);
  assert.equal(finiteRecoveryOnly(finiteRecoveryRepairPaths, context), true);
  assert.equal(finiteBillingCiOnly(finiteRecoveryRepairPaths, context), true);
  assert.equal(checkMode(finiteRecoveryRepairPaths, 'same', 'same', undefined, context), 'ci-only');
  assert.deepEqual(finiteBillingParts(finiteRecoveryRepairPaths, undefined, context), ['guards']);
  assert.equal(finiteBillingNeedsEngine(finiteRecoveryRepairPaths, context), false);
  assert.equal(checkMode(finiteRecoveryRepairPaths, 'before', 'after', undefined, context), 'full');
  for (const invalid of [
    undefined,
    { base: finiteRecoveryRepairBase },
    { ...context, base: 'b'.repeat(40) },
    { ...context, base: finiteRecoveryCommit },
    { ...context, baseTree: finiteRecoveryTree },
    { ...context, baseTree: 'a'.repeat(40) }
  ]) {
    assert.equal(finiteRecoveryRepair(finiteRecoveryRepairPaths, invalid), false);
    assert.equal(checkMode(finiteRecoveryRepairPaths, 'same', 'same', undefined, invalid), 'full');
  }
  for (const missing of finiteRecoveryRepairPaths) {
    const paths = finiteRecoveryRepairPaths.filter((p) => p !== missing);
    assert.equal(finiteRecoveryRepair(paths, context), false);
    assert.equal(checkMode(paths, 'same', 'same', undefined, context), 'full');
  }
  for (const extra of [
    '.github/workflows/bitbrowser-recovery-validation.yml',
    'scripts/production-release/bitbrowser-recovery-dispatch.py',
    'apps/api/src/id-business-v2/auto-recharge/recharge-cycle-ledger.ts',
    'apps/admin/src/v2/features/auto-recharge/recharge-form.ts',
    'packages/shared/src/v2/checkout-diagnostic.ts',
    'apps/api/prisma-mysql/schema.prisma',
    'package-lock.json',
    '.github/workflows/quality.yml',
    'scripts/production-release/bitbrowser-billing-release.py'
  ]) {
    assert.equal(
      finiteRecoveryRepair([...finiteRecoveryRepairPaths, extra], context),
      false,
      extra
    );
    assert.equal(
      checkMode([...finiteRecoveryRepairPaths, extra], 'same', 'same', undefined, context),
      'full',
      extra
    );
  }
  assert.equal(finiteRecoveryRepair(finiteRecoveryPaths, context), false);
  assert.equal(
    finiteRecoveryRepair(
      [...finiteRecoveryRepairPaths.slice(1), finiteRecoveryRepairPaths[1]],
      context
    ),
    false
  );
});

test('finite BitBrowser publication controls reuse unchanged application checks', () => {
  assert.equal(finiteBillingOnly(finiteBillingPaths), true);
  assert.equal(finiteBillingCiOnly(finiteBillingPaths), true);
  assert.deepEqual(finiteBillingParts(finiteBillingPaths), ['guards']);
  assert.equal(finiteBillingNeedsEngine(finiteBillingPaths), false);
  for (const extra of [
    'apps/admin/src/v2/features/auto-recharge/recharge-form.ts',
    'apps/api/prisma-mysql/schema.prisma',
    'apps/api/src/id-business-v2/online-recharge/engine/checkout-form.cjs',
    'scripts/production-release/bitbrowser-billing-dispatch.py'
  ]) {
    assert.equal(finiteBillingOnly([...finiteBillingPaths, extra]), false);
  }
  assert.equal(finiteBillingOnly([]), false);
  assert.equal(finiteBillingOnly(['scripts/ci-recharge-scope.mjs']), false);
});

import {
  isBitbrowserFollowupControlsOnly as finiteFollowupOnly,
  bitbrowserFollowupControlPaths as finiteFollowupPaths,
  bitbrowserFollowupSourceReviewCommit as finiteFollowupCommit,
  bitbrowserFollowupSourceReviewTree as finiteFollowupTree
} from './ci-recharge-scope.mjs';

test('finite followup controls require frozen source tree and exactly ten controls', () => {
  const context = { base: finiteFollowupCommit, baseTree: finiteFollowupTree };
  const frozen =
    /^[a-f0-9]{40}$/.test(finiteFollowupCommit) && /^[a-f0-9]{40}$/.test(finiteFollowupTree);
  assert.equal(finiteFollowupPaths.length, 10);
  assert.equal(finiteFollowupOnly(finiteFollowupPaths, context), frozen);
  if (frozen) {
    assert.equal(checkMode(finiteFollowupPaths, 'same', 'same', undefined, context), 'ci-only');
    assert.deepEqual(finiteBillingParts(finiteFollowupPaths, undefined, context), [
      'guards',
      'release-controls'
    ]);
    assert.equal(finiteBillingNeedsEngine(finiteFollowupPaths, context), false);
    assert.equal(checkMode(finiteFollowupPaths, 'old', 'new', undefined, context), 'full');
  }
  for (const invalid of [
    undefined,
    { ...context, base: 'main' },
    { ...context, baseTree: finiteHistoryTree },
    { ...context, baseTree: 'a'.repeat(40) },
    { ...context, base: 'a'.repeat(39) }
  ]) {
    assert.equal(finiteFollowupOnly(finiteFollowupPaths, invalid), false);
  }
  for (const missing of finiteFollowupPaths)
    assert.equal(
      finiteFollowupOnly(
        finiteFollowupPaths.filter((n) => n !== missing),
        context
      ),
      false
    );
  for (const extra of [
    'apps/api/src/id-business-v2/auto-recharge/recharge-account-restore.ts',
    'apps/api/src/id-business-v2/auto-recharge/persistence/recharge.repository.ts',
    'apps/admin/src/v2/features/auto-recharge/bitbrowser-direct-payment.ts',
    'packages/shared/src/index.ts',
    'apps/api/prisma-mysql/schema.prisma',
    'package-lock.json',
    'scripts/production-release/bitbrowser-history-contract.json',
    '.github/workflows/quality.yml'
  ])
    assert.equal(finiteFollowupOnly([...finiteFollowupPaths, extra], context), false, extra);
  assert.equal(finiteFollowupOnly([], context), false);
  assert.equal(
    finiteFollowupOnly([...finiteFollowupPaths.slice(1), finiteFollowupPaths[1]], context),
    false
  );
  assert.equal(
    finiteHistoryOnly(finiteFollowupPaths, {
      base: finiteHistoryCommit,
      baseTree: finiteHistoryTree
    }),
    false
  );
});

test('finite followup PR and same-tree main CLI emit both final check_parts entries', () => {
  for (const base of [finiteFollowupCommit, 'b'.repeat(40)]) {
    for (const eventName of ['pull_request', 'push']) {
      const { result, writes, gitCalls } = recordScopeClassification(
        finiteFollowupPaths,
        {},
        eventName,
        { base, baseTree: finiteFollowupTree }
      );
      assert.equal(result.mode, 'ci-only');
      assert.deepEqual(result.checkParts, ['guards', 'release-controls']);
      assert.equal(result.onlineCiBuild, false);
      assert.equal(result.reuseMain, eventName === 'push');
      assert.ok(
        writes.some(({ contents }) =>
          contents.includes('check_parts=["guards","release-controls"]\n')
        )
      );
      assert.ok(gitCalls.some((args) => args.join(' ') === 'rev-parse ' + base + '^{tree}'));
    }
  }
  for (const eventName of ['pull_request', 'push']) {
    for (const { paths, baseTree } of [
      { paths: finiteFollowupPaths, baseTree: finiteHistoryTree },
      { paths: finiteFollowupPaths, baseTree: 'a'.repeat(40) },
      ...finiteFollowupPaths.map((missing) => ({
        paths: finiteFollowupPaths.filter((name) => name !== missing),
        baseTree: finiteFollowupTree
      })),
      ...[
        'apps/api/src/id-business-v2/auto-recharge/persistence/recharge.repository.ts',
        'apps/admin/src/v2/features/auto-recharge/bitbrowser-direct-payment.ts',
        'scripts/production-release/bitbrowser-history-contract.json'
      ].map((extra) => ({ paths: [...finiteFollowupPaths, extra], baseTree: finiteFollowupTree }))
    ]) {
      const { result, writes } = recordScopeClassification(paths, {}, eventName, {
        base: 'b'.repeat(40),
        baseTree
      });
      assert.equal(result.mode, 'full');
      assert.notDeepEqual(result.checkParts, ['guards', 'release-controls']);
      assert.equal(
        writes.some(({ contents }) =>
          contents.includes('check_parts=["guards","release-controls"]\n')
        ),
        false
      );
    }
  }
});

import {
  isBitbrowserEntryStartControlsOnly as finiteEntryOnly,
  bitbrowserEntryStartControlPaths as finiteEntryPaths,
  bitbrowserEntryStartSourceReviewCommit as finiteEntryCommit,
  bitbrowserEntryStartSourceReviewTree as finiteEntryTree
} from './ci-recharge-scope.mjs';

test('finite entry-start controls retain exactly ten controls and both real CLI matrix entries', () => {
  const context = { base: finiteEntryCommit, baseTree: finiteEntryTree };
  assert.equal(finiteEntryPaths.length, 10);
  assert.equal(finiteEntryOnly(finiteEntryPaths, context), true);
  assert.deepEqual(finiteBillingParts(finiteEntryPaths, undefined, context), [
    'guards',
    'release-controls'
  ]);
  for (const base of [finiteEntryCommit, 'b'.repeat(40)]) {
    for (const eventName of ['pull_request', 'push']) {
      const { result, writes } = recordScopeClassification(finiteEntryPaths, {}, eventName, {
        base,
        baseTree: finiteEntryTree
      });
      assert.equal(result.mode, 'ci-only');
      assert.deepEqual(result.checkParts, ['guards', 'release-controls']);
      assert.equal(result.onlineCiBuild, false);
      assert.ok(
        writes.some(({ contents }) =>
          contents.includes('check_parts=["guards","release-controls"]\n')
        )
      );
    }
  }
  for (const eventName of ['pull_request', 'push']) {
    for (const { paths, baseTree } of [
      { paths: finiteEntryPaths, baseTree: finiteFollowupTree },
      { paths: finiteEntryPaths, baseTree: 'a'.repeat(40) },
      ...finiteEntryPaths.map((missing) => ({
        paths: finiteEntryPaths.filter((n) => n !== missing),
        baseTree: finiteEntryTree
      })),
      ...[
        'apps/api/src/id-business-v2/auto-recharge/recharge-local.service.ts',
        'apps/admin/src/v2/features/auto-recharge/bitbrowser-direct-payment.ts',
        'scripts/production-release/bitbrowser-followup-contract.json',
        'scripts/production-release/bitbrowser-history-contract.json',
        'packages/shared/src/index.ts'
      ].map((extra) => ({ paths: [...finiteEntryPaths, extra], baseTree: finiteEntryTree }))
    ]) {
      const { result, writes } = recordScopeClassification(paths, {}, eventName, {
        base: 'b'.repeat(40),
        baseTree
      });
      assert.equal(result.mode, 'full');
      assert.notDeepEqual(result.checkParts, ['guards', 'release-controls']);
      assert.equal(
        writes.some(({ contents }) =>
          contents.includes('check_parts=["guards","release-controls"]\n')
        ),
        false
      );
    }
  }
  assert.equal(finiteEntryOnly(finiteEntryPaths, { ...context, base: 'main' }), false);
  assert.equal(
    finiteEntryOnly([...finiteEntryPaths.slice(1), finiteEntryPaths[1]], context),
    false
  );
});

import {
  isBitbrowserExistingAddressControlsOnly as finiteAddressOnly,
  bitbrowserExistingAddressControlPaths as finiteAddressPaths,
  bitbrowserExistingAddressSourceReviewCommit as finiteAddressCommit,
  bitbrowserExistingAddressSourceReviewTree as finiteAddressTree
} from './ci-recharge-scope.mjs';

test('finite existing-address controls retain exactly ten controls and both real CLI matrix entries', () => {
  const context = { base: finiteAddressCommit, baseTree: finiteAddressTree };
  assert.equal(finiteAddressPaths.length, 10);
  assert.equal(finiteAddressOnly(finiteAddressPaths, context), true);
  assert.deepEqual(finiteBillingParts(finiteAddressPaths, undefined, context), [
    'guards',
    'release-controls'
  ]);
  for (const base of [finiteAddressCommit, 'b'.repeat(40)]) {
    for (const eventName of ['pull_request', 'push']) {
      const { result, writes } = recordScopeClassification(finiteAddressPaths, {}, eventName, {
        base,
        baseTree: finiteAddressTree
      });
      assert.equal(result.mode, 'ci-only');
      assert.deepEqual(result.checkParts, ['guards', 'release-controls']);
      assert.equal(result.onlineCiBuild, false);
      assert.ok(
        writes.some(({ contents }) =>
          contents.includes('check_parts=["guards","release-controls"]\n')
        )
      );
    }
  }
  for (const eventName of ['pull_request', 'push']) {
    for (const { paths, baseTree } of [
      { paths: finiteAddressPaths, baseTree: finiteFollowupTree },
      { paths: finiteAddressPaths, baseTree: 'a'.repeat(40) },
      ...finiteAddressPaths.map((missing) => ({
        paths: finiteAddressPaths.filter((n) => n !== missing),
        baseTree: finiteAddressTree
      })),
      ...[
        'apps/api/src/id-business-v2/auto-recharge/recharge-local.service.ts',
        'apps/admin/src/v2/features/auto-recharge/bitbrowser-direct-payment.ts',
        'scripts/production-release/bitbrowser-followup-contract.json',
        'scripts/production-release/bitbrowser-history-contract.json',
        'packages/shared/src/index.ts'
      ].map((extra) => ({ paths: [...finiteAddressPaths, extra], baseTree: finiteAddressTree }))
    ]) {
      const { result, writes } = recordScopeClassification(paths, {}, eventName, {
        base: 'b'.repeat(40),
        baseTree
      });
      assert.equal(result.mode, 'full');
      assert.notDeepEqual(result.checkParts, ['guards', 'release-controls']);
      assert.equal(
        writes.some(({ contents }) =>
          contents.includes('check_parts=["guards","release-controls"]\n')
        ),
        false
      );
    }
  }
  assert.equal(finiteAddressOnly(finiteAddressPaths, { ...context, base: 'main' }), false);
  assert.equal(
    finiteAddressOnly([...finiteAddressPaths.slice(1), finiteAddressPaths[1]], context),
    false
  );
});

import {
  bitbrowserBoundedHoldSourceStatus,
  bitbrowserBoundedHoldSourceBase,
  bitbrowserBoundedHoldSourceBaseTree,
  bitbrowserBoundedHoldSourcePaths,
  isBitbrowserBoundedHoldSourceOnly,
  matchBitbrowserBoundedHoldSource,
  bitbrowserBoundedHoldSchemaMatches
} from './ci-recharge-scope.mjs';

test('bounded source admission is draft closed and its future frozen path set excludes schema and neighboring business', () => {
  const context = {
    base: bitbrowserBoundedHoldSourceBase,
    baseTree: bitbrowserBoundedHoldSourceBaseTree
  };
  assert.equal(
    isBitbrowserBoundedHoldSourceOnly(bitbrowserBoundedHoldSourcePaths, context),
    bitbrowserBoundedHoldSourceStatus === 'FROZEN_SOURCE_PATHS'
  );
  assert.equal(
    matchBitbrowserBoundedHoldSource(
      bitbrowserBoundedHoldSourcePaths,
      context,
      'DRAFT_SCOPE_PENDING'
    ),
    false
  );
  assert.equal(
    matchBitbrowserBoundedHoldSource(
      bitbrowserBoundedHoldSourcePaths,
      context,
      'FROZEN_SOURCE_PATHS'
    ),
    true
  );
  for (const paths of [
    ...bitbrowserBoundedHoldSourcePaths.map((missing) =>
      bitbrowserBoundedHoldSourcePaths.filter((n) => n !== missing)
    ),
    [...bitbrowserBoundedHoldSourcePaths, bitbrowserBoundedHoldSourcePaths[0]],
    ...[
      'apps/api/prisma-mysql/schema.prisma',
      'apps/api/prisma-mysql/migrations/unknown/migration.sql',
      'apps/api/src/id-business-v2/online-recharge/persistence/tasks.repository.ts',
      'apps/api/src/id-business-v2/bank-card-pool/shared-bank-card.controller.ts',
      'apps/api/src/auth/auth.service.ts',
      'package-lock.json',
      'scripts/production-release/bitbrowser-existing-address-contract.json'
    ].map((extra) => [...bitbrowserBoundedHoldSourcePaths, extra])
  ])
    assert.equal(matchBitbrowserBoundedHoldSource(paths, context, 'FROZEN_SOURCE_PATHS'), false);
  for (const changed of [
    { ...context, base: 'main' },
    { ...context, base: 'a'.repeat(40) },
    { ...context, baseTree: 'a'.repeat(40) }
  ])
    assert.equal(
      matchBitbrowserBoundedHoldSource(
        bitbrowserBoundedHoldSourcePaths,
        changed,
        'FROZEN_SOURCE_PATHS'
      ),
      false
    );
  assert.equal(bitbrowserBoundedHoldSchemaMatches(schema, schema), true);
  for (const [before, after] of [
    [undefined, undefined],
    ['', ''],
    [schema, schema + '\n'],
    [schema, schema.replace('model', 'model Changed')]
  ])
    assert.equal(bitbrowserBoundedHoldSchemaMatches(before, after), false);
});

test('bounded source actual PR and push CLI emit the frozen three-part matrix and reject every missing or neighboring path', () => {
  const frozen = bitbrowserBoundedHoldSourceStatus === 'FROZEN_SOURCE_PATHS';
  for (const eventName of ['pull_request', 'push']) {
    const context = {
      base: bitbrowserBoundedHoldSourceBase,
      baseTree: bitbrowserBoundedHoldSourceBaseTree
    };
    const { result } = recordScopeClassification(
      bitbrowserBoundedHoldSourcePaths,
      {},
      eventName,
      context
    );
    assert.equal(result.mode, frozen ? 'recharge' : 'full');
    if (frozen) {
      assert.deepEqual(result.checkParts, ['guards', 'api', 'admin']);
      assert.equal(result.onlineCiBuild, false);
    } else assert.notDeepEqual(result.checkParts, ['guards', 'api', 'admin']);
    for (const { paths, options } of [
      {
        paths: bitbrowserBoundedHoldSourcePaths,
        options: { ...context, baseTree: 'a'.repeat(40) }
      },
      {
        paths: bitbrowserBoundedHoldSourcePaths,
        options: { ...context, schemaBefore: schema, schemaAfter: schema + '\n' }
      },
      ...bitbrowserBoundedHoldSourcePaths.map((missing) => ({
        paths: bitbrowserBoundedHoldSourcePaths.filter((n) => n !== missing),
        options: context
      })),
      ...[
        'apps/api/src/id-business-v2/online-recharge/persistence/tasks.repository.ts',
        'apps/api/src/id-business-v2/bank-card-pool/shared-bank-card.controller.ts',
        'apps/api/src/auth/auth.service.ts',
        'apps/api/prisma-mysql/schema.prisma',
        'apps/api/prisma-mysql/migrations/unknown/migration.sql',
        'package-lock.json'
      ].map((extra) => ({ paths: [...bitbrowserBoundedHoldSourcePaths, extra], options: context }))
    ]) {
      const { result: negative } = recordScopeClassification(paths, {}, eventName, options);
      assert.equal(negative.mode, 'full');
      assert.notDeepEqual(negative.checkParts, ['guards', 'api', 'admin']);
    }
  }
});

import {
  isBitbrowserBoundedHoldControlsOnly as finiteBoundedControlsOnly,
  bitbrowserBoundedHoldControlPaths as finiteBoundedControlPaths,
  bitbrowserBoundedHoldSourceReviewCommit as finiteBoundedControlCommit,
  bitbrowserBoundedHoldSourceReviewTree as finiteBoundedControlTree
} from './ci-recharge-scope.mjs';

test('bounded-hold controls admit only the ten reviewed controls and both actual CLI matrix entries', () => {
  const context = { base: finiteBoundedControlCommit, baseTree: finiteBoundedControlTree };
  assert.equal(finiteBoundedControlPaths.length, 10);
  assert.equal(finiteBoundedControlsOnly(finiteBoundedControlPaths, context), true);
  assert.deepEqual(finiteBillingParts(finiteBoundedControlPaths, undefined, context), [
    'guards',
    'release-controls'
  ]);
  for (const base of [finiteBoundedControlCommit, 'b'.repeat(40)]) {
    for (const eventName of ['pull_request', 'push']) {
      const { result, writes } = recordScopeClassification(
        finiteBoundedControlPaths,
        {},
        eventName,
        { ...context, base }
      );
      assert.equal(result.mode, 'ci-only');
      assert.deepEqual(result.checkParts, ['guards', 'release-controls']);
      assert.equal(result.onlineCiBuild, false);
      assert.ok(
        writes.some(({ contents }) =>
          contents.includes('check_parts=["guards","release-controls"]\n')
        )
      );
    }
  }
  for (const eventName of ['pull_request', 'push']) {
    assert.throws(
      () =>
        recordScopeClassification(finiteBoundedControlPaths, {}, eventName, {
          ...context,
          base: 'main'
        }),
      /Invalid source commit/
    );
    for (const { paths, options } of [
      { paths: finiteBoundedControlPaths, options: { ...context, baseTree: finiteAddressTree } },
      { paths: finiteBoundedControlPaths, options: { ...context, baseTree: 'a'.repeat(40) } },
      {
        paths: finiteBoundedControlPaths,
        options: { ...context, schemaBefore: schema, schemaAfter: schema + '\n' }
      },
      {
        paths: finiteBoundedControlPaths,
        options: { ...context, schemaBefore: '', schemaAfter: '' }
      },
      ...finiteBoundedControlPaths.map((missing) => ({
        paths: finiteBoundedControlPaths.filter((n) => n !== missing),
        options: context
      })),
      { paths: [...finiteBoundedControlPaths, finiteBoundedControlPaths[0]], options: context },
      ...[
        'apps/api/src/id-business-v2/auto-recharge/recharge-local.service.ts',
        'apps/admin/src/v2/features/auto-recharge/bitbrowser-direct-payment.ts',
        'scripts/production-release/bitbrowser-existing-address-contract.json',
        'scripts/production-release/bitbrowser-history-contract.json',
        'apps/api/prisma-mysql/schema.prisma',
        'packages/shared/src/index.ts'
      ].map((extra) => ({ paths: [...finiteBoundedControlPaths, extra], options: context }))
    ]) {
      const { result, writes } = recordScopeClassification(paths, {}, eventName, options);
      assert.equal(result.mode, 'full');
      assert.notDeepEqual(result.checkParts, ['guards', 'release-controls']);
      assert.equal(
        writes.some(({ contents }) =>
          contents.includes('check_parts=["guards","release-controls"]\n')
        ),
        false
      );
    }
  }
  assert.equal(
    finiteBoundedControlsOnly(
      [...finiteBoundedControlPaths.slice(1), finiteBoundedControlPaths[1]],
      context
    ),
    false
  );
});

import {
  parts as boundedMysqlFullParts,
  bitbrowserBoundedHoldMysqlRepairStatus,
  bitbrowserBoundedHoldMysqlRepairBase,
  bitbrowserBoundedHoldMysqlRepairTree,
  bitbrowserBoundedHoldMysqlRepairPaths,
  matchBitbrowserBoundedHoldMysqlRepair,
  isBitbrowserBoundedHoldMysqlRepairOnly
} from './ci-recharge-scope.mjs';

test('bounded MySQL repair admits only its frozen seven files and exact base and tree', () => {
  const context = {
    base: bitbrowserBoundedHoldMysqlRepairBase,
    baseTree: bitbrowserBoundedHoldMysqlRepairTree
  };
  assert.equal(bitbrowserBoundedHoldMysqlRepairPaths.length, 7);
  assert.equal(
    isBitbrowserBoundedHoldMysqlRepairOnly(bitbrowserBoundedHoldMysqlRepairPaths, context),
    bitbrowserBoundedHoldMysqlRepairStatus === 'FROZEN_MYSQL_REPAIR'
  );
  assert.equal(
    matchBitbrowserBoundedHoldMysqlRepair(
      bitbrowserBoundedHoldMysqlRepairPaths,
      context,
      'DRAFT_MYSQL_REPAIR_PENDING'
    ),
    false
  );
  assert.equal(
    matchBitbrowserBoundedHoldMysqlRepair(
      bitbrowserBoundedHoldMysqlRepairPaths,
      context,
      'FROZEN_MYSQL_REPAIR'
    ),
    true
  );
  for (const invalid of [
    { ...context, base: 'main' },
    { ...context, base: 'a'.repeat(40) },
    { ...context, baseTree: 'a'.repeat(40) }
  ])
    assert.equal(
      isBitbrowserBoundedHoldMysqlRepairOnly(bitbrowserBoundedHoldMysqlRepairPaths, invalid),
      false
    );
  for (const path of [
    '.github/workflows/bitbrowser-history-validation.yml',
    'scripts/production-release/bitbrowser-history-dispatch.py',
    'scripts/ci-recharge-check.mjs',
    'scripts/ci-recharge-check.test.mjs'
  ])
    assert.equal(bitbrowserBoundedHoldMysqlRepairPaths.includes(path), false);
});

test('bounded MySQL repair actual PR and push CLI keep both controls and use full checks for every invalid scope', () => {
  const frozen = bitbrowserBoundedHoldMysqlRepairStatus === 'FROZEN_MYSQL_REPAIR';
  const context = {
    base: bitbrowserBoundedHoldMysqlRepairBase,
    baseTree: bitbrowserBoundedHoldMysqlRepairTree
  };
  for (const eventName of ['pull_request', 'push']) {
    const { result, writes } = recordScopeClassification(
      bitbrowserBoundedHoldMysqlRepairPaths,
      {},
      eventName,
      context
    );
    assert.equal(result.mode, frozen ? 'ci-only' : 'full');
    assert.deepEqual(
      result.checkParts,
      frozen ? ['guards', 'release-controls'] : boundedMysqlFullParts
    );
    if (frozen) {
      assert.equal(result.onlineCiBuild, false);
      assert.ok(
        writes.some(({ contents }) =>
          contents.includes('check_parts=["guards","release-controls"]\n')
        )
      );
    }
    assert.throws(
      () =>
        recordScopeClassification(bitbrowserBoundedHoldMysqlRepairPaths, {}, eventName, {
          ...context,
          base: 'main'
        }),
      /Invalid source commit/
    );
    for (const { paths, options } of [
      {
        paths: bitbrowserBoundedHoldMysqlRepairPaths,
        options: { ...context, base: 'b'.repeat(40) }
      },
      {
        paths: bitbrowserBoundedHoldMysqlRepairPaths,
        options: { ...context, baseTree: 'a'.repeat(40) }
      },
      {
        paths: bitbrowserBoundedHoldMysqlRepairPaths,
        options: { ...context, schemaBefore: schema, schemaAfter: schema + '\n' }
      },
      {
        paths: bitbrowserBoundedHoldMysqlRepairPaths,
        options: { ...context, schemaBefore: '', schemaAfter: '' }
      },
      ...bitbrowserBoundedHoldMysqlRepairPaths.map((missing) => ({
        paths: bitbrowserBoundedHoldMysqlRepairPaths.filter((n) => n !== missing),
        options: context
      })),
      {
        paths: [...bitbrowserBoundedHoldMysqlRepairPaths, bitbrowserBoundedHoldMysqlRepairPaths[0]],
        options: context
      },
      {
        paths: [
          ...bitbrowserBoundedHoldMysqlRepairPaths.slice(1),
          bitbrowserBoundedHoldMysqlRepairPaths[1]
        ],
        options: context
      },
      ...[
        '.github/workflows/bitbrowser-history-validation.yml',
        'scripts/production-release/bitbrowser-history-dispatch.py',
        'scripts/ci-recharge-check.mjs',
        'scripts/ci-recharge-check.test.mjs',
        'scripts/production-release/bitbrowser-existing-address-contract.json',
        'apps/api/src/id-business-v2/bank-card-pool/persistence/shared-bank-card.repository.ts',
        'apps/api/prisma-mysql/schema.prisma',
        'package-lock.json'
      ].map((extra) => ({
        paths: [...bitbrowserBoundedHoldMysqlRepairPaths, extra],
        options: context
      }))
    ]) {
      const { result: rejected } = recordScopeClassification(paths, {}, eventName, options);
      assert.equal(rejected.mode, 'full');
      assert.deepEqual(rejected.checkParts, boundedMysqlFullParts);
    }
  }
});

import {
  bitbrowserBoundedHoldNativeDeclarationsStatus,
  bitbrowserBoundedHoldNativeDeclarationsBase,
  bitbrowserBoundedHoldNativeDeclarationsTree,
  bitbrowserBoundedHoldNativeDeclarationsPaths,
  matchBitbrowserBoundedHoldNativeDeclarations,
  isBitbrowserBoundedHoldNativeDeclarationsOnly
} from './ci-recharge-scope.mjs';

test('native declaration controls admit only eight frozen control files at the exact reviewed base and tree', () => {
  const context = {
    base: bitbrowserBoundedHoldNativeDeclarationsBase,
    baseTree: bitbrowserBoundedHoldNativeDeclarationsTree
  };
  assert.equal(bitbrowserBoundedHoldNativeDeclarationsPaths.length, 8);
  assert.equal(
    isBitbrowserBoundedHoldNativeDeclarationsOnly(
      bitbrowserBoundedHoldNativeDeclarationsPaths,
      context
    ),
    bitbrowserBoundedHoldNativeDeclarationsStatus === 'FROZEN_NATIVE_DECLARATIONS'
  );
  assert.equal(
    matchBitbrowserBoundedHoldNativeDeclarations(
      bitbrowserBoundedHoldNativeDeclarationsPaths,
      context,
      'DRAFT_NATIVE_DECLARATIONS'
    ),
    false
  );
  for (const invalid of [
    { ...context, base: 'main' },
    { ...context, base: 'b'.repeat(40) },
    { ...context, baseTree: 'a'.repeat(40) }
  ])
    assert.equal(
      isBitbrowserBoundedHoldNativeDeclarationsOnly(
        bitbrowserBoundedHoldNativeDeclarationsPaths,
        invalid
      ),
      false
    );
  for (const forbidden of [
    '.github/workflows/bitbrowser-history-validation.yml',
    'scripts/production-release/bitbrowser-history-build.py',
    'apps/api/src/id-business-v2/bank-card-pool/shared-bank-card.mysql.integration.spec.ts'
  ])
    assert.equal(bitbrowserBoundedHoldNativeDeclarationsPaths.includes(forbidden), false);
});

test('native declaration actual PR and push CLI select both controls and use full checks for all scope drift', () => {
  const frozen = bitbrowserBoundedHoldNativeDeclarationsStatus === 'FROZEN_NATIVE_DECLARATIONS';
  const context = {
    base: bitbrowserBoundedHoldNativeDeclarationsBase,
    baseTree: bitbrowserBoundedHoldNativeDeclarationsTree
  };
  const paths = bitbrowserBoundedHoldNativeDeclarationsPaths;
  for (const eventName of ['pull_request', 'push']) {
    const { result, writes } = recordScopeClassification(paths, {}, eventName, context);
    assert.equal(result.mode, frozen ? 'ci-only' : 'full');
    assert.deepEqual(
      result.checkParts,
      frozen ? ['guards', 'release-controls'] : boundedMysqlFullParts
    );
    if (frozen) {
      assert.equal(result.onlineCiBuild, false);
      assert.ok(
        writes.some(({ contents }) =>
          contents.includes('check_parts=["guards","release-controls"]\n')
        )
      );
    }
    assert.throws(
      () => recordScopeClassification(paths, {}, eventName, { ...context, base: 'main' }),
      /Invalid source commit/
    );
    for (const rejected of [
      { paths, options: { ...context, base: 'b'.repeat(40) } },
      { paths, options: { ...context, baseTree: 'a'.repeat(40) } },
      { paths, options: { ...context, schemaBefore: '', schemaAfter: '' } },
      { paths, options: { ...context, schemaBefore: schema, schemaAfter: schema + '\n' } },
      ...paths.map((missing) => ({
        paths: paths.filter((name) => name !== missing),
        options: context
      })),
      { paths: [...paths, paths[0]], options: context },
      { paths: [...paths.slice(1), paths[1]], options: context },
      ...[
        '.github/workflows/bitbrowser-history-validation.yml',
        'scripts/production-release/bitbrowser-history-build.py',
        'apps/api/src/id-business-v2/bank-card-pool/shared-bank-card.mysql.integration.spec.ts',
        'apps/api/src/id-business-v2/auto-recharge/recharge-local.service.ts',
        'scripts/production-release/bitbrowser-existing-address-contract.json',
        'apps/api/prisma-mysql/schema.prisma',
        'package-lock.json'
      ].map((extra) => ({ paths: [...paths, extra], options: context }))
    ]) {
      const { result: negative } = recordScopeClassification(
        rejected.paths,
        {},
        eventName,
        rejected.options
      );
      assert.equal(negative.mode, 'full');
      assert.deepEqual(negative.checkParts, boundedMysqlFullParts);
    }
  }
});

import {
  bitbrowserBoundedHoldSelectedNativeStatus,
  bitbrowserBoundedHoldSelectedNativeBase,
  bitbrowserBoundedHoldSelectedNativeTree,
  bitbrowserBoundedHoldSelectedNativePaths,
  matchBitbrowserBoundedHoldSelectedNative,
  isBitbrowserBoundedHoldSelectedNativeOnly
} from './ci-recharge-scope.mjs';

test('selected native controls admit only eight frozen control files at the exact reviewed base and tree', () => {
  const context = {
    base: bitbrowserBoundedHoldSelectedNativeBase,
    baseTree: bitbrowserBoundedHoldSelectedNativeTree
  };
  assert.equal(bitbrowserBoundedHoldSelectedNativePaths.length, 8);
  assert.equal(
    isBitbrowserBoundedHoldSelectedNativeOnly(bitbrowserBoundedHoldSelectedNativePaths, context),
    bitbrowserBoundedHoldSelectedNativeStatus === 'FROZEN_SELECTED_NATIVE'
  );
  assert.equal(
    matchBitbrowserBoundedHoldSelectedNative(
      bitbrowserBoundedHoldSelectedNativePaths,
      context,
      'DRAFT_SELECTED_NATIVE'
    ),
    false
  );
  for (const invalid of [
    { ...context, base: 'main' },
    { ...context, base: 'b'.repeat(40) },
    { ...context, baseTree: 'a'.repeat(40) }
  ])
    assert.equal(
      isBitbrowserBoundedHoldSelectedNativeOnly(bitbrowserBoundedHoldSelectedNativePaths, invalid),
      false
    );
  for (const forbidden of [
    '.github/workflows/bitbrowser-history-validation.yml',
    'scripts/production-release/bitbrowser-history-dispatch.py',
    'apps/api/src/id-business-v2/bank-card-pool/shared-bank-card.mysql.integration.spec.ts'
  ])
    assert.equal(bitbrowserBoundedHoldSelectedNativePaths.includes(forbidden), false);
});

test('selected native actual PR and push CLI select both controls and use full checks for all scope drift', () => {
  const frozen = bitbrowserBoundedHoldSelectedNativeStatus === 'FROZEN_SELECTED_NATIVE';
  const context = {
    base: bitbrowserBoundedHoldSelectedNativeBase,
    baseTree: bitbrowserBoundedHoldSelectedNativeTree
  };
  const paths = bitbrowserBoundedHoldSelectedNativePaths;
  for (const eventName of ['pull_request', 'push']) {
    const { result, writes } = recordScopeClassification(paths, {}, eventName, context);
    assert.equal(result.mode, frozen ? 'ci-only' : 'full');
    assert.deepEqual(
      result.checkParts,
      frozen ? ['guards', 'release-controls'] : boundedMysqlFullParts
    );
    if (frozen) {
      assert.equal(result.onlineCiBuild, false);
      assert.ok(
        writes.some(({ contents }) =>
          contents.includes('check_parts=["guards","release-controls"]\n')
        )
      );
    }
    assert.throws(
      () => recordScopeClassification(paths, {}, eventName, { ...context, base: 'main' }),
      /Invalid source commit/
    );
    for (const rejected of [
      { paths, options: { ...context, base: 'b'.repeat(40) } },
      { paths, options: { ...context, baseTree: 'a'.repeat(40) } },
      { paths, options: { ...context, schemaBefore: '', schemaAfter: '' } },
      { paths, options: { ...context, schemaBefore: schema, schemaAfter: schema + '\n' } },
      ...paths.map((missing) => ({
        paths: paths.filter((name) => name !== missing),
        options: context
      })),
      { paths: [...paths, paths[0]], options: context },
      { paths: [...paths.slice(1), paths[1]], options: context },
      ...[
        '.github/workflows/bitbrowser-history-validation.yml',
        'scripts/production-release/bitbrowser-history-dispatch.py',
        'apps/api/src/id-business-v2/bank-card-pool/shared-bank-card.mysql.integration.spec.ts',
        'apps/api/src/id-business-v2/auto-recharge/recharge-local.service.ts',
        'scripts/production-release/bitbrowser-existing-address-contract.json',
        'apps/api/prisma-mysql/schema.prisma',
        'package-lock.json'
      ].map((extra) => ({ paths: [...paths, extra], options: context }))
    ]) {
      const { result: negative } = recordScopeClassification(
        rejected.paths,
        {},
        eventName,
        rejected.options
      );
      assert.equal(negative.mode, 'full');
      assert.deepEqual(negative.checkParts, boundedMysqlFullParts);
    }
  }
});

test('card diagnostics release retains only guards and online engine checks', () => {
  const paths = [
    ...onlineCardControlDiagnosticsPaths,
    ...onlineCardControlDiagnosticsControls,
    'docs/ONLINE_RECHARGE.md',
    'docs/V2_TASKS.md'
  ];
  assert.deepEqual(selectedParts(paths), ['guards', 'online-engine']);
  assert.equal(checkMode(paths, 'same', 'same'), 'recharge');
  assert.deepEqual(selectedParts([...onlineCardControlDiagnosticsControls]), ['guards']);
  assert.equal(checkMode([...paths, 'package-lock.json'], 'same', 'same'), 'full');
});
