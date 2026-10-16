import {
  isMailboxVersionOnly,
  isMailboxVersionControlsOnly,
  mailboxVersionCommands
} from './ci-mailbox-version-scope.mjs';
import { isGptRechargeControlsOnly, isGptRechargeOnly } from './ci-gpt-recharge-scope.mjs';
import {
  isSharedBankCardOnly,
  isSharedBankCardControlsOnly,
  sharedBankCardCommands
} from './ci-shared-bank-card-scope.mjs';
import {
  isMailboxRealtimeOnly,
  isMailboxRealtimeControlsOnly
} from './ci-mailbox-realtime-scope.mjs';
import {
  isAccountLoginOnly,
  isAccountLoginControlsOnly,
  accountLoginCommands
} from './ci-account-login-scope.mjs';
import { isWorkspaceDragOnly, workspaceDragCommands } from './ci-workspace-drag-scope.mjs';
import {
  isChatgptSalesOnly,
  isChatgptSalesControlsOnly,
  chatgptSalesCommands
} from './ci-chatgpt-sales-scope.mjs';
import {
  isRegistrationFlowEvidenceOnly,
  isRegistrationFlowEvidenceControlRepair,
  registrationFlowEvidenceRepairBase,
  registrationFlowEvidenceBase,
  registrationFlowEvidenceWorker,
  registrationFlowEvidenceAcceptance
} from './ci-registration-flow-evidence-scope.mjs';
import {
  isRegistrationParityDiagnosticsOnly,
  isRegistrationParityDiagnosticsControlRepair,
  registrationParityDiagnosticsRepairBase,
  registrationParityDiagnosticsBase,
  registrationParityDiagnosticsParts,
  registrationParityDiagnosticsWorker,
  registrationParityDiagnosticsAcceptance
} from './ci-registration-parity-diagnostics-scope.mjs';
import {
  isProxyResultIdentityOnly,
  proxyResultIdentityBase,
  proxyResultIdentityEngineRoot,
  proxyResultIdentityEngineTests
} from './ci-proxy-result-identity-scope.mjs';
import {
  isOnlineSettingsOnly,
  isOnlineSettingsControlsOnly,
  onlineSettingsCommands
} from './ci-online-settings-scope.mjs';
import { readRegistrationNativeReuse } from './ci-registration-closure-native-reuse.mjs';
import {
  isRegistrationProtocolRestoreOnly,
  registrationProtocolRestoreBase,
  registrationProtocolRestoreCommands
} from './ci-registration-protocol-restore-scope.mjs';
import {
  isRegistrationBrowserOnly,
  registrationBrowserBase,
  registrationBrowserCommands
} from './ci-registration-browser-scope.mjs';
import {
  isOnlineProxyCountryOnly,
  isOnlineProxyCountryValidationOnly,
  onlineProxyCountryCommands
} from './ci-online-proxy-country-scope.mjs';
import {
  isRegistrationEnvironmentRepair,
  registrationEnvironmentRepairBase,
  isRegistrationDeclarationRepair,
  registrationDeclarationRepairBase,
  isRegistrationMigrationQueryRepair,
  registrationMigrationQueryRepairBase
} from './ci-registration-closure-scope.mjs';
import {
  isRechargeCheckoutOnly,
  isRechargeSourceRecoveryOnly
} from './ci-recharge-checkout-scope.mjs';
import { isRechargeBillingOnly } from './ci-recharge-billing-scope.mjs';
import { isSharedProxyPoolOnly, sharedProxyAdminCommand } from './ci-shared-proxy-scope.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  adminCheckCommands,
  adminHtmlCachePaths,
  isAdminHtmlCacheOnly,
  rechargeRecordControlPaths,
  rechargeAvailabilityControlPaths,
  isRechargeAvailabilityControlsOnly,
  rechargeAvailabilityGuardChecks,
  rechargeAvailabilityCommonControlTests,
  isRechargeRecordControlsOnly,
  releaseArtifactRetentionControls,
  isReleaseArtifactRetentionOnly,
  adminUiGuardChecks,
  backendArchitectureGuardChecks,
  auditRetentionMigration,
  historicalReleaseControlPaths,
  unpublishedComponentSuccessorControlPaths,
  unpublishedComponentSuccessorEntryPaths,
  rechargeFlowSuccessorControlPaths,
  ownedMysqlTestControlPaths,
  hasRegistrationOnboardingScope,
  hasAppleMailboxScope,
  hasRegistrationMirrorScope,
  hasRechargeConnectionMigrationScope,
  hasCombinedComponentScope,
  onlineRechargeRecoveryPolicy,
  productionDatabaseAccessHelper,
  productionDatabaseAccessTest,
  productionDatabaseAccessAcceptance,
  hasBankCardDeletePolicyProof,
  canResumeCombinedGuard,
  canResumeOnlineComponentGuard,
  canResumeOnlinePrepareFixGuard,
  canResumeOnlinePreflightReceiptFixGuard,
  onlinePreflightReceiptFixGuardCommands,
  canResumeOnlineBuildProofReuseGuard,
  onlineBuildProofReuseCommands,
  onlinePrepareFixGuardCommands,
  needsOnlineRechargeCiBuild,
  onlineCiBuildControlPaths,
  readProductionDatabaseAccessSnapshot
} from './ci-recharge-scope.mjs';

const [part, base] = process.argv.slice(2);
const mode = process.env.CHECK_MODE || 'recharge';
const run = (file, args) => execFileSync(file, args, { stdio: 'inherit' });
const npm = (...args) => run('npm', args);
const changed = execFileSync('git', ['diff', '--name-only', base, 'HEAD'], { encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter(Boolean);
if (
  (mode === 'recharge' && isGptRechargeOnly(changed)) ||
  (mode === 'ci-only' && isGptRechargeControlsOnly(changed))
) {
  if (part === 'guards' || part === 'release-controls') {
    npm('run', 'format:check');
    npm('run', 'lint');
    for (const name of [
      'check:v2-module-architecture',
      'check:v2-isolation',
      'check:v2-concurrency-standard',
      'check:v2-prisma-runtime-boundary'
    ])
      npm('run', name);
    run('node', [
      '--test',
      'scripts/ci-gpt-recharge-scope.test.mjs',
      'scripts/ci-recharge-scope.test.mjs',
      'scripts/ci-recharge-check.test.mjs'
    ]);
    run('python3', ['-B', 'scripts/production-release/gpt-recharge-release.test.py']);
    run('python3', [
      '-B',
      'scripts/production-release/api-admin-scope.test.py',
      'WorkspaceSqliteProtectionTests.test_frozen_pure_helper_runs_on_host_and_wal_backup_shares_its_algorithm',
      'WorkspaceSqliteProtectionTests.test_real_reader_locked_wal_backup_restores_same_summary_without_candidate_cache',
      'WorkspaceSqliteProtectionTests.test_real_source_loader_reproduces_cache_but_reader_preserves_source_and_summary',
      'WorkspaceSqliteProtectionTests.test_real_candidate_guard_survives_reader_and_rejects_actual_cache_or_source_drift'
    ]);
  } else if (part === 'api') {
    run('python3', ['-B', 'scripts/production-release/gpt-recharge-build.py']);
  } else throw new Error('Unsupported GPT recharge check part');
  process.exit(0);
}
if (
  mode === 'recharge' &&
  base === registrationProtocolRestoreBase &&
  isRegistrationProtocolRestoreOnly(changed, {
    base,
    baseTree: execFileSync('git', ['rev-parse', base + '^{tree}'], { encoding: 'utf8' }).trim()
  })
) {
  if (!Object.hasOwn(registrationProtocolRestoreCommands, part))
    throw new Error('Unsupported registration protocol restore check part');
  if ((part === 'api' || part === 'admin') && process.env.GITHUB_ACTIONS !== 'true')
    throw new Error('Registration protocol restore candidate checks require isolated CI');
  for (const [file, ...args] of registrationProtocolRestoreCommands[part]) run(file, args);
  process.exit(0);
}
if (
  mode === 'recharge' &&
  base === registrationBrowserBase &&
  isRegistrationBrowserOnly(changed, {
    base,
    baseTree: execFileSync('git', ['rev-parse', base + '^{tree}'], { encoding: 'utf8' }).trim()
  })
) {
  if (part === 'api' && process.env.GITHUB_ACTIONS !== 'true')
    throw new Error('Registration browser database checks require isolated CI');
  for (const [file, ...args] of registrationBrowserCommands(part, changed)) run(file, args);
  process.exit(0);
}
if (
  (mode === 'recharge' && isAccountLoginOnly(changed)) ||
  (mode === 'ci-only' && isAccountLoginControlsOnly(changed))
) {
  for (const [file, ...args] of accountLoginCommands(part, changed)) run(file, args);
  process.exit(0);
}
if (
  (mode === 'recharge' && isMailboxVersionOnly(changed)) ||
  (mode === 'ci-only' && isMailboxVersionControlsOnly(changed))
) {
  for (const [file, ...args] of mailboxVersionCommands(part, changed)) run(file, args);
  process.exit(0);
}
const registrationParityDiagnosticsControlRepair =
  mode === 'ci-only' &&
  base === registrationParityDiagnosticsRepairBase &&
  isRegistrationParityDiagnosticsControlRepair(changed, {
    base,
    baseTree: execFileSync('git', ['rev-parse', base + '^{tree}'], { encoding: 'utf8' }).trim()
  });
const mailboxContext =
  mode === 'recharge'
    ? {
        base,
        baseTree: execFileSync('git', ['rev-parse', base + '^{tree}'], { encoding: 'utf8' }).trim()
      }
    : undefined;
const mailboxControlsOnly =
  mode === 'recharge' && isMailboxRealtimeControlsOnly(changed, mailboxContext);
if (
  mode === 'recharge' &&
  (isMailboxRealtimeOnly(changed, mailboxContext) || mailboxControlsOnly)
) {
  if (mailboxControlsOnly && !['guards', 'release-controls'].includes(part))
    throw new Error('Unsupported mailbox control repair check part');
  if (!['guards', 'release-controls', 'api', 'admin'].includes(part))
    throw new Error('Unsupported mailbox check part');
  if (part === 'guards' || part === 'release-controls') {
    if (part === 'release-controls') npm('ci', '--ignore-scripts', '--no-audit', '--no-fund');
    run('python3', ['-B', 'scripts/production-release/mailbox-realtime-release.test.py']);
    run('node', [
      '--test',
      'scripts/ci-mailbox-realtime-scope.test.mjs',
      'scripts/ci-recharge-check.test.mjs'
    ]);
    const formatted = changed.filter((n) => /\.(?:[cm]?js|json|yml|md|ts|vue)$/.test(n));
    npm('exec', '--', 'prettier', '--check', ...formatted);
    npm('exec', '--', 'eslint', ...formatted.filter((n) => /\.(?:[cm]?js|ts|vue)$/.test(n)));
    for (const name of [
      'admin-ui',
      'v2-ui-language',
      'v2-color-contrast',
      'v2-table-standard',
      'v2-loading-standard',
      'v2-module-architecture',
      'v2-isolation'
    ])
      npm('run', 'check:' + name);
  } else {
    // The current main also carries unpublished business changes. Check the exact production projection.
    run('python3', [
      '-B',
      'scripts/production-release/mailbox-realtime-build.py',
      'prepare-checks'
    ]);
    run('python3', ['-B', 'scripts/production-release/mailbox-realtime-build.py', 'check-' + part]);
  }
  process.exit(0);
}
const registrationParityDiagnosticsOnly =
  mode === 'recharge' &&
  base === registrationParityDiagnosticsBase &&
  isRegistrationParityDiagnosticsOnly(changed, {
    base,
    baseTree: execFileSync('git', ['rev-parse', base + '^{tree}'], { encoding: 'utf8' }).trim()
  });
if (registrationParityDiagnosticsOnly || registrationParityDiagnosticsControlRepair) {
  if (registrationParityDiagnosticsControlRepair && part !== 'guards')
    throw new Error('Unsupported registration parity control repair check part');
  if (!registrationParityDiagnosticsParts.includes(part))
    throw new Error('Unsupported registration parity diagnostics check part');
  if (part === 'guards' || part === 'release-controls') {
    // The shared workflow preinstalls guards only; pin tooling for this additional part.
    if (part === 'release-controls') npm('ci', '--ignore-scripts', '--no-audit', '--no-fund');
    run('python3', [
      '-B',
      'scripts/production-release/registration-parity-diagnostics-release.test.py'
    ]);
    run('node', ['--test', 'scripts/ci-registration-parity-diagnostics-scope.test.mjs']);
    // These historical controls intentionally reject newer published source bytes.
    // Check this channel's classifiers and dispatcher against its current frozen source.
    run('node', [
      '--test',
      '--test-name-pattern=registration parity|registration client',
      'scripts/ci-recharge-scope.test.mjs',
      'scripts/ci-recharge-check.test.mjs'
    ]);
    const existing = changed.filter((path) => existsSync(path));
    const formatted = existing.filter((path) => /\.(?:[cm]?js|json|yml|md|ts|vue|css)$/.test(path));
    if (formatted.length) npm('exec', '--', 'prettier', '--check', ...formatted);
    const linted = existing.filter((path) => /\.(?:[cm]?js|ts|vue)$/.test(path));
    if (linted.length) npm('exec', '--', 'eslint', ...linted);
    for (const name of [
      'check:admin-ui',
      'check:v2-ui-language',
      'check:v2-color-contrast',
      'check:v2-table-standard',
      'check:v2-loading-standard',
      'check:v2-module-architecture',
      'check:v2-isolation'
    ])
      npm('run', name);
  } else {
    npm('ci', '--ignore-scripts', '--no-audit', '--no-fund');
    npm('run', 'prisma:mysql:generate');
    npm('run', 'build', '--workspace', '@apple-business/shared');
    const target = part === 'api' ? '@apple-business/api' : '@apple-business/admin';
    npm('run', 'typecheck', '--workspace', target);
    npm(
      'run',
      'test',
      '--workspace',
      target,
      '--',
      part === 'api' ? 'src/id-business-v2/auto-registration' : 'src/v2/features/auto-registration'
    );
    npm('run', 'build', '--workspace', target);
    npm('run', 'auto-registration:setup');
    const python = resolve('.runtime/auto-registration/venv/bin/python');
    if (part === 'api') {
      for (const name of [
        'test_flow_evidence.py',
        'test_registration_parity_unit.py',
        'test_registration_closed_loop_unit.py',
        'test_workspace.py',
        'test_apple_mailboxes.py',
        'test_release_safety.py',
        'test_upload_compat.py'
      ])
        run(python, [
          '-B',
          '-m',
          'unittest',
          'discover',
          '-s',
          registrationParityDiagnosticsWorker,
          '-p',
          name
        ]);
      run('node', ['--test', registrationParityDiagnosticsWorker + '/test_payment_browser.mjs']);
    } else {
      npm('exec', '--', 'playwright', 'install', '--with-deps', 'chromium');
      run('node', [registrationParityDiagnosticsAcceptance, '--python=' + python]);
    }
  }
  process.exit(0);
}
if (['admin', 'ci-only'].includes(mode) && isWorkspaceDragOnly(changed)) {
  for (const [file, ...args] of workspaceDragCommands(part, changed)) run(file, args);
  process.exit(0);
}
// Finite account inventory change: keep all affected checks and isolated MySQL.
if (
  ['recharge', 'ci-only'].includes(mode) &&
  (isChatgptSalesOnly(changed) || isChatgptSalesControlsOnly(changed))
) {
  for (const [file, ...args] of chatgptSalesCommands(part, changed)) run(file, args);
  process.exit(0);
}
if (
  (mode === 'recharge' && isSharedBankCardOnly(changed)) ||
  (mode === 'ci-only' && isSharedBankCardControlsOnly(changed))
) {
  for (const [file, ...args] of sharedBankCardCommands(part, changed)) run(file, args);
  process.exit(0);
}
if (
  (mode === 'recharge' && isOnlineSettingsOnly(changed)) ||
  (mode === 'ci-only' && isOnlineSettingsControlsOnly(changed))
) {
  for (const [file, ...args] of onlineSettingsCommands(part, changed)) run(file, args);
  process.exit(0);
}
// This API/Admin feature preserves the deployed engine image. Run every affected
// source/test/build/UI check; the main-only workflow verifies disposable MySQL.
// Any additional runtime, schema or dependency path uses the existing dispatcher.
if (
  (mode === 'recharge' && isOnlineProxyCountryOnly(changed)) ||
  (mode === 'ci-only' && isOnlineProxyCountryValidationOnly(changed))
) {
  for (const [file, ...args] of onlineProxyCountryCommands(part, changed)) run(file, args);
  process.exit(0);
}
const registrationFlowEvidenceOnly =
  mode === 'recharge' &&
  base === registrationFlowEvidenceBase &&
  isRegistrationFlowEvidenceOnly(changed, {
    base,
    baseTree: execFileSync('git', ['rev-parse', base + '^{tree}'], { encoding: 'utf8' }).trim()
  });
const registrationFlowEvidenceControlRepair =
  mode === 'ci-only' &&
  base === registrationFlowEvidenceRepairBase &&
  isRegistrationFlowEvidenceControlRepair(changed, {
    base,
    baseTree: execFileSync('git', ['rev-parse', base + '^{tree}'], { encoding: 'utf8' }).trim()
  });
if (
  (registrationFlowEvidenceOnly && ['guards', 'api', 'admin', 'release-controls'].includes(part)) ||
  (registrationFlowEvidenceControlRepair && part === 'guards')
) {
  if (part === 'guards' || part === 'release-controls') {
    run('python3', ['-B', 'scripts/production-release/registration-flow-evidence-release.test.py']);
    run('node', [
      '--test',
      'scripts/ci-registration-flow-evidence-scope.test.mjs',
      'scripts/ci-recharge-scope.test.mjs',
      'scripts/ci-recharge-check.test.mjs'
    ]);
    const existing = changed.filter((path) => existsSync(path));
    const formatted = existing.filter((path) => /\.(?:[cm]?js|json|yml|md|ts|vue|css)$/.test(path));
    if (formatted.length) npm('exec', '--', 'prettier', '--check', ...formatted);
    const linted = existing.filter((path) => /\.(?:[cm]?js|ts|vue)$/.test(path));
    if (linted.length) npm('exec', '--', 'eslint', ...linted);
    if (registrationFlowEvidenceOnly)
      for (const name of [
        'check:admin-ui',
        'check:v2-ui-language',
        'check:v2-color-contrast',
        'check:v2-table-standard',
        'check:v2-loading-standard',
        'check:v2-module-architecture',
        'check:v2-isolation'
      ])
        npm('run', name);
  } else {
    npm('ci', '--ignore-scripts', '--no-audit', '--no-fund');
    npm('run', 'prisma:mysql:generate');
    npm('run', 'build', '--workspace', '@apple-business/shared');
    const target = part === 'api' ? '@apple-business/api' : '@apple-business/admin';
    npm('run', 'typecheck', '--workspace', target);
    npm(
      'run',
      'test',
      '--workspace',
      target,
      '--',
      part === 'api' ? 'src/id-business-v2/auto-registration' : 'src/v2/features/auto-registration'
    );
    npm('run', 'build', '--workspace', target);
    npm('run', 'auto-registration:setup');
    const python = resolve('.runtime/auto-registration/venv/bin/python');
    if (part === 'api') {
      for (const name of [
        'test_flow_evidence.py',
        'test_registration_closed_loop_unit.py',
        'test_workspace.py',
        'test_apple_mailboxes.py',
        'test_release_safety.py',
        'test_upload_compat.py'
      ])
        run(python, [
          '-B',
          '-m',
          'unittest',
          'discover',
          '-s',
          registrationFlowEvidenceWorker,
          '-p',
          name
        ]);
      run('node', ['--test', registrationFlowEvidenceWorker + '/test_payment_browser.mjs']);
      run(python, ['-B', registrationFlowEvidenceWorker + '/acceptance_runtime.py']);
    } else {
      npm('exec', '--', 'playwright', 'install', '--with-deps', 'chromium');
      run('node', [registrationFlowEvidenceAcceptance, '--python=' + python]);
    }
  }
  process.exit(0);
}
// A byte-bound engine and registration static-asset repair has real tests and its own publisher.
// Formal validation runs the new mock-browser regression; unchanged compiled API/Admin and databases are preserved.
const proxyResultIdentityOnly =
  mode === 'recharge' &&
  base === proxyResultIdentityBase &&
  isProxyResultIdentityOnly(changed, {
    base,
    baseTree: execFileSync('git', ['rev-parse', base + '^{tree}'], { encoding: 'utf8' }).trim()
  });
if (proxyResultIdentityOnly && ['guards', 'release-controls', 'online-engine'].includes(part)) {
  if (part === 'online-engine') {
    npm('ci', '--ignore-scripts', '--no-audit', '--no-fund');
    npm(
      'ci',
      '--prefix',
      proxyResultIdentityEngineRoot + '/upstream',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund'
    );
    run('node', ['--test', ...proxyResultIdentityEngineTests]);
  } else {
    run('python3', ['-B', 'scripts/production-release/proxy-result-identity-release.test.py']);
    const existing = changed.filter((path) => existsSync(path));
    const formatted = existing.filter((path) => /\.(?:[cm]?js|json|yml)$/.test(path));
    if (formatted.length) npm('exec', '--', 'prettier', '--check', ...formatted);
    const linted = existing.filter((path) => path.endsWith('.mjs'));
    if (linted.length) npm('exec', '--', 'eslint', ...linted);
    run('node', [
      '--test',
      'scripts/ci-proxy-result-identity-scope.test.mjs',
      'scripts/ci-recharge-scope.test.mjs',
      'scripts/ci-recharge-check.test.mjs',
      'scripts/ci-recharge-checkout-scope.test.mjs'
    ]);
  }
  process.exit(0);
}
const registrationEnvironmentRepair =
  part === 'guards' &&
  mode === 'ci-only' &&
  base === registrationEnvironmentRepairBase &&
  isRegistrationEnvironmentRepair(changed, {
    base,
    baseTree: execFileSync('git', ['rev-parse', base + '^{tree}'], { encoding: 'utf8' }).trim()
  });
const registrationDeclarationRepair =
  part === 'guards' &&
  mode === 'ci-only' &&
  base === registrationDeclarationRepairBase &&
  isRegistrationDeclarationRepair(changed, {
    base,
    baseTree: execFileSync('git', ['rev-parse', base + '^{tree}'], { encoding: 'utf8' }).trim()
  });
const registrationMigrationQueryRepair =
  part === 'guards' &&
  mode === 'ci-only' &&
  base === registrationMigrationQueryRepairBase &&
  isRegistrationMigrationQueryRepair(changed, {
    base,
    baseTree: execFileSync('git', ['rev-parse', base + '^{tree}'], { encoding: 'utf8' }).trim()
  });
const registrationOwnControlRepair =
  registrationEnvironmentRepair ||
  registrationDeclarationRepair ||
  registrationMigrationQueryRepair;
const sharedPoolOnly =
  mode === 'recharge' &&
  changed.some((path) => path.includes('/proxy-pool/')) &&
  isSharedProxyPoolOnly(
    changed,
    execFileSync('git', ['show', `${base}:apps/api/prisma-mysql/schema.prisma`], {
      encoding: 'utf8'
    }),
    readFileSync('apps/api/prisma-mysql/schema.prisma', 'utf8')
  );
if (
  !sharedPoolOnly &&
  ['guards', 'release-controls'].includes(part) &&
  changed.some((p) => rechargeAvailabilityControlPaths.includes(p))
) {
  run('python3', ['-B', 'scripts/production-release/recharge-availability-release.test.py']);
  run('node', ['--test', 'scripts/ci-recharge-availability.test.mjs']);
}
const releaseArtifactOnly = mode === 'ci-only' && isReleaseArtifactRetentionOnly(changed);
if (
  ['guards', 'release-controls'].includes(part) &&
  changed.some((path) => rechargeRecordControlPaths.includes(path))
) {
  run('python3', ['-B', 'scripts/production-release/recharge-record-release.test.py']);
  run('python3', ['-B', 'scripts/production-release/recharge-record-finalize.test.py']);
  run('node', ['--test', 'scripts/ci-recharge-record.test.mjs']);
}
const resumeCombinedGuardPrefix =
  part === 'guards' &&
  process.env.GITHUB_ACTIONS === 'true' &&
  process.env.GITHUB_REPOSITORY === 'wangchaozhuanyong/id-business-system' &&
  process.env.GITHUB_EVENT_NAME === 'pull_request' &&
  canResumeCombinedGuard(base);
const resumeOnlineComponentGuardPrefix =
  part === 'guards' &&
  process.env.GITHUB_ACTIONS === 'true' &&
  process.env.GITHUB_REPOSITORY === 'wangchaozhuanyong/id-business-system' &&
  process.env.GITHUB_EVENT_NAME === 'pull_request' &&
  base === 'b922b2d900e683f565ff3c5f95576ebc5f07803f' &&
  canResumeOnlineComponentGuard(base);
const resumeOnlinePrepareFixGuard =
  part === 'guards' &&
  mode === 'ci-only' &&
  process.env.GITHUB_ACTIONS === 'true' &&
  process.env.GITHUB_REPOSITORY === 'wangchaozhuanyong/id-business-system' &&
  process.env.GITHUB_EVENT_NAME === 'pull_request' &&
  base === '2edb7ef92a9619e5b0e5855220c97bac29d22f60' &&
  canResumeOnlinePrepareFixGuard(base);
const resumeOnlineBuildProofReuseGuard =
  part === 'guards' &&
  mode === 'ci-only' &&
  process.env.GITHUB_ACTIONS === 'true' &&
  process.env.GITHUB_REPOSITORY === 'wangchaozhuanyong/id-business-system' &&
  process.env.GITHUB_EVENT_NAME === 'pull_request' &&
  base === '5f458e7ac7cd0dfab0f99d2a6d07c20baa8b6e53' &&
  canResumeOnlineBuildProofReuseGuard(base);
const resumeOnlinePreflightReceiptFixGuard =
  part === 'guards' &&
  mode === 'ci-only' &&
  process.env.GITHUB_ACTIONS === 'true' &&
  process.env.GITHUB_REPOSITORY === 'wangchaozhuanyong/id-business-system' &&
  process.env.GITHUB_EVENT_NAME === 'pull_request' &&
  base === 'b9f2e2b75a753b86a5057dd798d651c57496554e' &&
  canResumeOnlinePreflightReceiptFixGuard(base);
// PR520 fixed native continuation starts here.
if (
  part === 'guards' &&
  process.env.GITHUB_ACTIONS === 'true' &&
  process.env.GITHUB_EVENT_NAME === 'pull_request' &&
  process.env.GITHUB_REPOSITORY === 'wangchaozhuanyong/id-business-system' &&
  base === '369c57fcb56f950c61b5fe4164a6c6d1d8102e95'
) {
  const registrationNativeEvidence = readRegistrationNativeReuse({
    repo: process.env.GITHUB_REPOSITORY,
    event: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')),
    base,
    mode,
    currentTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim()
  });
  if (registrationNativeEvidence) {
    run('node', [
      '--test',
      'scripts/ci-registration-closure-native-reuse.test.mjs',
      'scripts/ci-recharge-scope.test.mjs',
      'scripts/ci-recharge-check.test.mjs',
      'scripts/ci-recharge-checkout-scope.test.mjs',
      'scripts/check-v2-decimal-standard.test.mjs'
    ]);
    run('python3', ['-B', 'scripts/production-release/registration-closure-release.test.py']);
    const repaired = registrationNativeEvidence.changed.filter((path) => existsSync(path));
    npm(
      'exec',
      '--',
      'prettier',
      '--check',
      ...repaired.filter((path) => /\.(?:mjs|json)$/.test(path))
    );
    npm('exec', '--', 'eslint', ...repaired.filter((path) => path.endsWith('.mjs')));
    console.log('Authenticated PR520 guard prefix; continuing at the original failed command.');
    const uiChecks = adminUiGuardChecks(mode, changed);
    if (
      changed.some(
        (path) =>
          path.includes('online-recharge') ||
          /^scripts\/check-v2-(?:table|loading|input-retention|decimal)-standard/.test(path)
      )
    )
      npm('run', 'test:online-recharge:controls');
    const architectureChecks = backendArchitectureGuardChecks(mode, changed);
    for (const name of new Set([...uiChecks, ...architectureChecks])) npm('run', name);
    if (!uiChecks.length && mode !== 'ci-only' && mode !== 'audit-retention') {
      npm(
        'run',
        'check:v2-decimal-standard',
        '--',
        'apps/admin/src/v2/features/auto-recharge',
        'apps/api/src/id-business-v2/auto-recharge',
        'packages/shared/src/v2'
      );
      npm('run', 'check:v2-ui-language', '--', 'apps/admin/src/v2/features/auto-recharge');
    }
    console.log(
      JSON.stringify({ prefixEvidence: registrationNativeEvidence.prefix, remainder: 'PASS' })
    );
    process.exit(0);
  }
}
const shared = () => npm('run', 'build', '--workspace', '@apple-business/shared');
const onlineEngine = () => {
  const directory = 'apps/api/src/id-business-v2/online-recharge/engine/upstream';
  npm('ci', '--prefix', directory, '--ignore-scripts', '--no-audit', '--no-fund');
  run('node', [
    directory + '/node_modules/playwright/cli.js',
    'install',
    '--with-deps',
    'chromium'
  ]);
  if (process.platform === 'linux')
    run('sudo', ['apt-get', 'install', '-y', '--no-install-recommends', 'ffmpeg']);
  npm('run', 'test:online-recharge:engine');
};
const onlineReleaseControlPaths = new Set([
  onlineRechargeRecoveryPolicy,
  productionDatabaseAccessHelper,
  productionDatabaseAccessTest,
  '.github/workflows/production-release.yml',
  'scripts/ci-recharge-check.mjs',
  'scripts/production-release/remote-deploy.py',
  'scripts/production-release/build-images.sh',
  'scripts/production-release/push-images.sh',
  'scripts/production-release/dispatch.sh',
  'scripts/production-release/validate-release-selection.sh'
]);
const retirementControlPaths = [
  '.github/workflows/production-release.yml',
  'scripts/production-release/remote-deploy.py',
  'scripts/production-release/remote-deploy.test.py',
  'scripts/production-release/retire-orphan-retention.py',
  'scripts/production-release/retire-orphan-retention.test.py'
];
const preparedControlPaths = [
  '.github/workflows/production-release.yml',
  'scripts/production-release/build-images.sh',
  'scripts/production-release/push-images.sh',
  'scripts/production-release/dispatch.sh',
  'scripts/production-release/validate-release-selection.sh',
  'scripts/production-release/reuse-images.py',
  'scripts/production-release/prepared-images.test.py'
];
const unpublishedComponentSuccessorControls = () => {
  if (
    changed.some(
      (path) =>
        unpublishedComponentSuccessorControlPaths.includes(path) ||
        unpublishedComponentSuccessorEntryPaths.includes(path)
    )
  ) {
    run('python3', ['-B', 'scripts/production-release/unpublished-component-successor.test.py']);
    run('python3', [
      '-B',
      'scripts/production-release/unpublished-component-successor-readonly.test.py'
    ]);
    run('node', ['--test', 'scripts/production-release/unpublished-component-entry.test.mjs']);
    run('python3', [
      '-B',
      'scripts/production-release/unpublished-component-runtime-diagnostic.test.py'
    ]);
    run('python3', ['-B', 'scripts/production-release/unified-component-source.test.py']);
  }
};
const ownedMysqlTestControls = () => {
  if (
    changed.some((path) => ownedMysqlTestControlPaths.includes(path)) ||
    hasRechargeConnectionMigrationScope(changed) ||
    hasRegistrationMirrorScope(changed)
  )
    run('node', ['--test', 'scripts/lib/owned-mysql-test-instance.test.mjs']);
  if (
    changed.includes('scripts/acceptance-v2-recharge-employee-concurrency.test.mjs') ||
    hasCombinedComponentScope(changed)
  )
    run('node', ['--test', 'scripts/acceptance-v2-recharge-employee-concurrency.test.mjs']);
};
const rechargeFlowSuccessorControls = () => {
  if (
    changed.some(
      (path) =>
        rechargeFlowSuccessorControlPaths.includes(path) ||
        unpublishedComponentSuccessorEntryPaths.includes(path) ||
        [
          'scripts/production-release/unpublished-component-successor.py',
          'scripts/production-release/unpublished-component-successor-readonly.py'
        ].includes(path)
    )
  ) {
    run('python3', ['-B', 'scripts/production-release/recharge-flow-successor.test.py']);
    run('python3', ['-B', 'scripts/production-release/recharge-flow-successor-projection.test.py']);
    run('python3', ['-B', 'scripts/production-release/recharge-flow-successor-readonly.test.py']);
    run('node', ['--test', 'scripts/production-release/recharge-flow-entry.test.mjs']);
  }
};
const registrationControlPaths = [
  'deploy/aws/registration-worker-96-20261008.json',
  'deploy/aws/registration-baseline-96-20261008.json',
  'scripts/production-release/registration-onboarding-96.py',
  'scripts/production-release/registration-onboarding-96.test.py',
  'deploy/aws/registration-worker-b8-80-20261006.json',
  'deploy/aws/registration-worker-956-20261006.json',
  'deploy/aws/registration-worker-85-20261006.json',
  'deploy/aws/registration-worker-86-20261006.json',
  'deploy/aws/registration-worker-87-20261006.json',
  'deploy/aws/registration-worker-88-20261006.json',
  'deploy/aws/registration-worker-89-20261006.json',
  'deploy/aws/registration-worker-90-20261007.json',
  'deploy/aws/registration-worker-91-20261007.json',
  'deploy/aws/registration-worker-92-20261007.json',
  'deploy/aws/registration-worker-93-20261007.json',
  'scripts/v2-registration-finance-audit.mjs',
  'scripts/v2-registration-finance-audit.test.mjs',
  'scripts/production-release/registration-only-transport.test.py',
  '.github/workflows/production-release.yml',
  'scripts/production-release/build-images.sh',
  'scripts/production-release/push-images.sh',
  'scripts/production-release/dispatch.sh',
  'scripts/production-release/validate-release-selection.sh',
  'scripts/production-release/remote-deploy.py',
  'scripts/production-release/remote-deploy.test.py'
];
const releaseMaintenanceControls = () => {
  if (changed.some((path) => retirementControlPaths.includes(path)))
    run('python3', ['-B', 'scripts/production-release/retire-orphan-retention.test.py']);
  if (changed.some((path) => preparedControlPaths.includes(path)))
    run('python3', ['-B', 'scripts/production-release/prepared-images.test.py']);
  if (
    changed.some((path) =>
      [
        '.github/workflows/production-release.yml',
        'apps/api/src/id-business-v2/auto-recharge/worker/Dockerfile',
        'scripts/production-release/build-images.sh',
        'scripts/production-release/build-image-cache.test.py',
        'scripts/production-release/browser-cache-input.py',
        'scripts/production-release/browser-cache-input.test.py'
      ].includes(path)
    )
  ) {
    run('python3', ['-B', 'scripts/production-release/build-image-cache.test.py']);
    run('python3', ['-B', 'scripts/production-release/browser-cache-input.test.py']);
  }
  if (
    changed.some(
      (path) =>
        path.startsWith('scripts/production-release/service-image-retention') ||
        path === '.github/workflows/production-release.yml'
    )
  )
    run('python3', ['-B', 'scripts/production-release/service-image-retention.test.py']);
  if (
    changed.some(
      (path) =>
        path.startsWith('scripts/production-release/maintain-image-cache') ||
        path.startsWith('scripts/production-release/service-image-retention') ||
        path === '.github/workflows/production-release.yml'
    )
  )
    run('python3', ['-B', 'scripts/production-release/maintain-image-cache.test.py']);
  if (
    changed.some(
      (path) =>
        path.startsWith('scripts/production-release/disk-retention') ||
        path.startsWith('scripts/production-release/candidate-retention') ||
        path.startsWith('scripts/production-release/disk-lifecycle') ||
        path.startsWith('scripts/production-release/release-storage') ||
        path === '.github/workflows/production-release.yml' ||
        path === '.github/workflows/disk-retention-maintenance.yml' ||
        path.startsWith('scripts/production-release/maintain-image-cache') ||
        path === 'deploy/aws/disk-retention-policy-20261014.json'
    )
  ) {
    run('python3', ['-B', 'scripts/production-release/disk-retention.test.py']);
    run('python3', ['-B', 'scripts/production-release/disk-retention-install.test.py']);
    run('python3', ['-B', 'scripts/production-release/disk-retention-transport.test.py']);
    run('python3', ['-B', 'scripts/production-release/candidate-retention.test.py']);
    run('python3', ['-B', 'scripts/production-release/disk-lifecycle.test.py']);
    run('python3', ['-B', 'scripts/production-release/release-storage.test.py']);
  }
};
const archiveReleaseControls = () => {
  run('node', ['--test', 'scripts/v2-order-archive-release-policy.test.mjs']);
};
const onlineSourcePermissionRepairControls = () => {
  if (
    changed.some(
      (path) =>
        path.startsWith('scripts/production-release/online-recharge-source-permission-repair') ||
        [
          '.github/workflows/production-release.yml',
          'scripts/production-release/validate-release-selection.sh',
          'scripts/ci-recharge-check.mjs'
        ].includes(path)
    )
  ) {
    run('python3', [
      '-B',
      'scripts/production-release/online-recharge-source-permission-repair.test.py'
    ]);
    run('python3', [
      '-B',
      'scripts/production-release/online-recharge-source-permission-repair-transport.test.py'
    ]);
  }
};
const workspacePublicPermissionRepairControls = () => {
  const paths = [
    'scripts/production-release/api-workspace-public-permission-repair.py',
    'scripts/production-release/api-workspace-public-permission-repair-transport.py',
    'scripts/production-release/api-workspace-public-permission-repair.test.py',
    '.github/workflows/production-release.yml',
    'scripts/production-release/validate-release-selection.sh',
    'scripts/ci-recharge-check.mjs'
  ];
  if (changed.some((path) => paths.includes(path)))
    run('python3', [
      '-B',
      'scripts/production-release/api-workspace-public-permission-repair.test.py'
    ]);
};
const onlineBackupSourceRecoveryControls = () => {
  const paths = [
    'scripts/production-release/online-recharge-backup-source-recovery.py',
    'scripts/production-release/online-recharge-backup-source-recovery.test.py',
    'scripts/production-release/online-recharge-backup-source-recovery-transport.py',
    'scripts/production-release/online-recharge-backup-source-recovery-transport.test.py',
    'scripts/production-release/online-recharge-backup-parent-owner-repair.py',
    'scripts/production-release/online-recharge-backup-parent-owner-repair.test.py',
    '.github/workflows/production-release.yml',
    'scripts/production-release/validate-release-selection.sh',
    'scripts/ci-recharge-check.mjs'
  ];
  if (changed.some((path) => paths.includes(path))) {
    run('python3', [
      '-B',
      'scripts/production-release/online-recharge-backup-source-recovery.test.py'
    ]);
    run('python3', [
      '-B',
      'scripts/production-release/online-recharge-backup-source-recovery-transport.test.py'
    ]);
    run('python3', [
      '-B',
      'scripts/production-release/online-recharge-backup-parent-owner-repair.test.py'
    ]);
  }
};
const backupRetentionProtectionControls = () => {
  if (
    changed.some((path) =>
      [
        'scripts/backup-aws-mysql.sh',
        'scripts/backup-retention-protection.py',
        'scripts/backup-retention-protection.test.py',
        'scripts/production-release/backup-retention-install.py',
        'scripts/production-release/backup-retention-install.test.py',
        '.github/workflows/production-release.yml',
        'scripts/production-release/validate-release-selection.sh',
        'scripts/ci-recharge-check.mjs'
      ].includes(path)
    )
  ) {
    run('python3', ['-B', 'scripts/backup-retention-protection.test.py']);
    run('python3', ['-B', 'scripts/production-release/backup-retention-install.test.py']);
    if (part === 'release-controls' || !changed.includes('scripts/backup-aws-mysql.sh'))
      run('node', ['--test', 'scripts/aws-mysql-backup.test.mjs']);
  }
};
const onlineRecoveryGrantControls = () => {
  if (
    changed.some((path) =>
      [
        onlineRechargeRecoveryPolicy,
        productionDatabaseAccessHelper,
        productionDatabaseAccessTest
      ].includes(path)
    )
  )
    run('node', ['--test', productionDatabaseAccessTest]);
};

const adminPendingReleaseControls = () => {
  if (
    changed.some((path) =>
      [
        'scripts/production-release/admin-pending-online-release.py',
        'scripts/production-release/admin-pending-online-release.test.py',
        'scripts/production-release/build-images.sh',
        'scripts/production-release/push-images.sh',
        'scripts/production-release/dispatch.sh',
        'scripts/production-release/validate-release-selection.sh',
        '.github/workflows/production-release.yml',
        'scripts/ci-recharge-check.mjs'
      ].includes(path)
    )
  ) {
    run('python3', ['-B', 'scripts/production-release/admin-pending-online-release.test.py']);
    run('python3', ['-B', 'scripts/production-release/admin-successor-diagnostic.test.py']);
  } else if (
    changed.some((path) =>
      [
        'scripts/production-release/admin-successor-diagnostic.py',
        'scripts/production-release/admin-successor-diagnostic.test.py'
      ].includes(path)
    )
  ) {
    run('python3', ['-B', 'scripts/production-release/admin-successor-diagnostic.test.py']);
  }
};

if (
  ['guards', 'release-controls'].includes(part) &&
  changed.some(
    (path) =>
      path.startsWith('scripts/production-release/registration-closure-') ||
      path === '.github/workflows/registration-closure-validation.yml'
  )
)
  run('python3', ['-B', 'scripts/production-release/registration-closure-release.test.py']);

if (
  ['guards', 'release-controls'].includes(part) &&
  changed.some((path) =>
    [
      'scripts/check-v2-table-standard.mjs',
      'scripts/lib/v2-table-schema-alias.mjs',
      'scripts/v2-table-schema-alias.test.mjs'
    ].includes(path)
  )
)
  run('node', ['--test', 'scripts/v2-table-schema-alias.test.mjs']);

if (part === 'guards') {
  if (!/^[a-f0-9]{40}$/.test(base)) throw new Error('Missing diff base');
  const existing = changed.filter((p) => existsSync(p));
  const formatted = existing.filter((p) => /\.(?:[cm]?js|ts|vue|css|json|md|yml)$/.test(p));
  const linted = existing.filter((p) => /\.(?:mjs|ts|vue)$/.test(p));
  if (formatted.length) npm('exec', '--', 'prettier', '--check', ...formatted);
  if (linted.length) npm('exec', '--', 'eslint', ...linted);
  const commonControlTests = registrationOwnControlRepair
    ? [
        'scripts/ci-recharge-scope.test.mjs',
        'scripts/ci-recharge-check.test.mjs',
        'scripts/ci-recharge-checkout-scope.test.mjs',
        'scripts/ci-registration-closure-native-reuse.test.mjs'
      ]
    : isRechargeSourceRecoveryOnly(changed)
      ? [
          'scripts/ci-recharge-checkout-scope.test.mjs',
          'scripts/ci-recharge-check.test.mjs',
          'scripts/check-cloud-independence.test.mjs',
          'scripts/check-v2-prisma-runtime-boundary.test.mjs',
          'scripts/check-v2-module-architecture.test.mjs',
          'scripts/admin-layout-rules.test.mjs'
        ]
      : isRechargeCheckoutOnly(changed)
        ? [
            'scripts/ci-recharge-checkout-scope.test.mjs',
            'scripts/ci-recharge-scope.test.mjs',
            'scripts/ci-recharge-check.test.mjs',
            'scripts/check-cloud-independence.test.mjs',
            'scripts/check-v2-prisma-runtime-boundary.test.mjs',
            'scripts/check-v2-module-architecture.test.mjs',
            'scripts/admin-layout-rules.test.mjs'
          ]
        : (rechargeAvailabilityCommonControlTests(changed) ?? [
            'scripts/ci-recharge-scope.test.mjs',
            'scripts/ci-recharge-check.test.mjs',
            'scripts/check-cloud-independence.test.mjs',
            'scripts/check-v2-prisma-runtime-boundary.test.mjs',
            'scripts/check-v2-module-architecture.test.mjs',
            'scripts/ci-recharge-precision.test.mjs',
            'scripts/ci-change-scope.test.mjs',
            'scripts/ci-recharge-release.test.mjs',
            'scripts/admin-layout-rules.test.mjs'
          ]);
  run('node', ['--test', ...commonControlTests]);
}
if (registrationOwnControlRepair) {
  process.exit(0);
}
// The shared pool changes business source and an additive migration. Keep all
// applicable checks; unrelated historical publishers are unchanged inputs.
if (part === 'guards' && sharedPoolOnly) {
  run('node', ['--test', 'scripts/ci-shared-proxy-scope.test.mjs', productionDatabaseAccessTest]);
  npm('run', 'test:online-recharge:controls');
  for (const check of backendArchitectureGuardChecks(mode, changed)) npm('run', check);
  console.log('Shared pool controls verified; API, UI and disposable MySQL run in their own jobs.');
  process.exit(0);
}
if (part === 'guards' && changed.some((path) => adminHtmlCachePaths.includes(path)))
  run('python3', ['-B', 'scripts/acceptance-nginx-admin-cache.py', '--docker']);

// The exact cache-only repair has completed the real dispatcher/selector controls
// and real Nginx regression above. Retain all UI rules without selecting unchanged
// historical publication simulations merely because the dispatcher gained this entry.
if (part === 'guards' && mode === 'admin' && isAdminHtmlCacheOnly(changed)) {
  for (const name of adminUiGuardChecks(mode, changed)) npm('run', name);
  process.exit(0);
}

// The finite diagnostic controls have their own native tests above. The common
// format, lint and CI-selector contracts have also run. Business source remains
// subject to the formal workflow's immutable source and prior-validation proof.
if (part === 'guards' && mode === 'recharge') {
  if (isRechargeCheckoutOnly(changed)) {
    run('python3', [
      '-B',
      isRechargeSourceRecoveryOnly(changed)
        ? 'scripts/production-release/recharge-source-recovery-release.test.py'
        : 'scripts/production-release/recharge-checkout-release.test.py'
    ]);
    for (const name of new Set([
      ...adminUiGuardChecks(mode, changed),
      ...backendArchitectureGuardChecks(mode, changed),
      ...(isRechargeSourceRecoveryOnly(changed) ? ['check:v2-isolation'] : [])
    ]))
      npm('run', name);
    console.log('Native checkout controls and all affected architecture/UI rules verified');
    process.exit(0);
  }
  if (isRechargeBillingOnly(changed)) {
    run('node', ['--test', 'scripts/ci-recharge-billing-scope.test.mjs']);
    run('python3', ['-B', 'scripts/production-release/recharge-billing-release.test.py']);
    for (const name of new Set([
      ...adminUiGuardChecks(mode, changed),
      ...backendArchitectureGuardChecks(mode, changed)
    ]))
      npm('run', name);
    console.log('Independent billing controls and all affected architecture/UI rules verified');
    process.exit(0);
  }
  const checks = rechargeAvailabilityGuardChecks(changed);
  if (checks) {
    for (const name of checks) npm('run', name);
    console.log('Availability source, UI, architecture and release controls verified');
    process.exit(0);
  }
}
if (part === 'guards' && mode === 'ci-only' && isRechargeAvailabilityControlsOnly(changed))
  process.exit(0);
if (part === 'guards' && mode === 'ci-only' && isRechargeRecordControlsOnly(changed)) {
  console.log('Finite recharge record controls verified; unrelated release controls unchanged');
  process.exit(0);
}
const readonlyQualityMetadataOnly = () => {
  const source = 'scripts/production-release/online-recharge-component-readonly.py';
  const paths = [source, source.replace('.py', '.test.py')];
  if (
    part !== 'guards' ||
    mode !== 'ci-only' ||
    !paths.every((path) => changed.includes(path)) ||
    !changed.every((path) =>
      [...paths, 'scripts/ci-recharge-check.mjs', 'scripts/ci-recharge-check.test.mjs'].includes(
        path
      )
    )
  )
    return false;
  try {
    const raw = execFileSync('git', ['show', `${base}:${source}`]);
    let before = raw.toString('utf8');
    if (!Buffer.from(before, 'utf8').equals(raw)) return false;
    for (const [old, replacement] of [
      ["'/commits/'", "'/git/commits/'"],
      ["commit.get('commit', {}).get('tree', {}).get('sha')", "commit.get('tree', {}).get('sha')"]
    ]) {
      if (before.split(old).length !== 2) return false;
      before = before.replace(old, replacement);
    }
    return readFileSync(resolve(source)).equals(Buffer.from(before, 'utf8'));
  } catch {
    return false;
  }
};
if (readonlyQualityMetadataOnly()) {
  for (const helper of ['readonly', 'recovery-readonly', 'consumer', 'runtime'])
    run('python3', [
      '-B',
      `scripts/production-release/online-recharge-component-${helper}.test.py`
    ]);
  process.exit(0);
}
if (resumeOnlineBuildProofReuseGuard) {
  run('python3', ['-B', 'scripts/production-release/online-recharge-ci-build.test.py']);
  run('python3', [
    '-B',
    'scripts/production-release/online-recharge-ci-build.py',
    '--ci-real-build-not-for-release',
    '--admitted-source-tree',
    execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim()
  ]);
  for (const [file, ...args] of onlineBuildProofReuseCommands) run(file, args);
  process.exit(0);
}
if (resumeOnlinePrepareFixGuard) {
  for (const [file, ...args] of onlinePrepareFixGuardCommands) run(file, args);
  process.exit(0);
}
if (resumeOnlinePreflightReceiptFixGuard) {
  for (const [file, ...args] of onlinePreflightReceiptFixGuardCommands) run(file, args);
  process.exit(0);
}
if (
  !releaseArtifactOnly &&
  (part === 'guards' || (part === 'release-controls' && mode !== 'full')) &&
  (needsOnlineRechargeCiBuild(changed) ||
    changed.some((path) => onlineCiBuildControlPaths.includes(path)))
) {
  run('python3', ['-B', 'scripts/production-release/online-recharge-ci-build.test.py']);
  run('python3', ['-B', 'scripts/production-release/online-recharge-component-diagnostic.test.py']);
  run('python3', ['-B', 'scripts/production-release/online-recharge-component-lifecycle.test.py']);
  run('python3', ['-B', 'scripts/production-release/online-recharge-component-recovery.test.py']);
  run('python3', [
    '-B',
    'scripts/production-release/online-recharge-component-recovery-readonly.test.py'
  ]);
  run('node', [
    '--test',
    'scripts/production-release/online-recharge-component-diagnostic-entry.test.mjs'
  ]);
}
if (
  part === 'guards' &&
  !releaseArtifactOnly &&
  !resumeCombinedGuardPrefix &&
  !resumeOnlineComponentGuardPrefix
) {
  if (
    changed.some(
      (path) =>
        /^scripts\/(?:native-[\w.-]+|start-native-worker(?:\.test)?\.mjs|doctor(?:\.test)?\.mjs|lib\/native-mysql-[\w.-]+)$/.test(
          path
        ) ||
        [
          'scripts/acceptance-v2-financial-integrity.mjs',
          'scripts/acceptance-v2-rollback-integrity.mjs',
          'scripts/acceptance-v2-data-governance.mjs',
          'scripts/acceptance-v2-data-governance.test.mjs',
          'scripts/acceptance-native-child-output.test.mjs',
          'scripts/ci-recharge-migration.py',
          'scripts/production-release/audit-retention-mysql.test.py',
          'scripts/lib/native_mysql_fixture.py'
        ].includes(path)
    )
  )
    npm('run', 'test:native-runtime');
  if (
    changed.some((path) =>
      [
        'apps/api/src/id-business-v2/workspace/media-resolver/server.py',
        'apps/api/src/id-business-v2/workspace/media-resolver/test_native_startup.py'
      ].includes(path)
    )
  )
    run('python3', [
      '-B',
      'apps/api/src/id-business-v2/workspace/media-resolver/test_native_startup.py'
    ]);
  if (changed.some((path) => historicalReleaseControlPaths.includes(path))) {
    run('node', ['--test', 'scripts/v2-release-history-policy.test.mjs']);
    run('node', ['--test', 'scripts/v2-release-maintenance-policy.test.mjs']);
    run('node', ['--test', 'scripts/v2-release-mailbox-audit.test.mjs']);
  }
  if (
    changed.some(
      (path) =>
        path.startsWith('scripts/production-release/') ||
        path === '.github/workflows/production-release.yml' ||
        path === 'scripts/ci-recharge-check.mjs'
    )
  ) {
    run('python3', ['-B', 'scripts/production-release/api-admin-scope.test.py']);
    run('python3', ['-B', 'scripts/production-release/api-admin-readonly.test.py']);
    run('python3', ['-B', 'scripts/production-release/api-admin-pending-projection.test.py']);
    run('python3', ['-B', 'scripts/production-release/api-admin-pending-online.test.py']);
    run('python3', ['-B', 'scripts/production-release/api-admin-pending-receipt-wire.test.py']);
    run('python3', ['-B', 'scripts/production-release/api-workspace-declaration-readonly.test.py']);
    run('python3', [
      '-B',
      'scripts/production-release/online-recharge-declaration-measurement.test.py'
    ]);
    run('python3', ['-B', 'scripts/production-release/online-recharge-daemon-identity.test.py']);
    run('python3', ['-B', 'scripts/production-release/online-recharge-daemon-listener.test.py']);
    run('python3', ['-B', 'scripts/production-release/online-recharge-daemon-socket.test.py']);
    run('python3', [
      '-B',
      'scripts/production-release/online-recharge-runtime-socket-diagnostic.test.py'
    ]);
    run('python3', [
      '-B',
      'scripts/production-release/api-workspace-declaration-artifacts.test.py'
    ]);
    run('python3', ['-B', 'scripts/production-release/formal-runtime-package.test.py']);
  }
  if (
    changed.some((path) => path.includes('online-recharge') || onlineReleaseControlPaths.has(path))
  ) {
    onlineRecoveryGrantControls();
    run('python3', ['-B', 'scripts/production-release/online-recharge-component-consumer.test.py']);
    run('python3', ['-B', 'scripts/production-release/online-recharge-component-runtime.test.py']);
    run('python3', ['-B', 'scripts/production-release/online-recharge-component-readonly.test.py']);
    run('python3', ['-B', 'scripts/production-release/online-recharge-scope.test.py']);
    run('python3', ['-B', 'scripts/production-release/online-recharge-readonly.test.py']);
    run('node', ['--test', 'scripts/production-release/online-recharge-entry.test.mjs']);
  }
  adminPendingReleaseControls();
  unpublishedComponentSuccessorControls();
}
if (resumeOnlineComponentGuardPrefix)
  run('python3', ['-B', 'scripts/production-release/unified-component-source.test.py']);
const releaseArtifactRetentionChecks = () => {
  if (changed.some((path) => releaseArtifactRetentionControls.includes(path))) {
    run('python3', ['-B', 'scripts/production-release/release-artifact-retention.test.py']);
    run('python3', [
      '-B',
      'scripts/production-release/release-artifact-retention-transport.test.py'
    ]);
    run('python3', ['-B', 'scripts/production-release/disk-retention-transport.test.py']);
    run('python3', ['-B', 'scripts/production-release/release-storage.test.py']);
  }
};
// An archive-only change leaves the existing website controllers unchanged.
// Keep the common Node/format/lint prefix and verify its actual transport dependencies.
if (releaseArtifactOnly && ['guards', 'release-controls'].includes(part)) {
  if (!/^[a-f0-9]{40}$/.test(base)) throw new Error('Missing diff base');
  if (part === 'release-controls') run('node', ['--test', 'scripts/ci-recharge-release.test.mjs']);
  releaseArtifactRetentionChecks();
} else if (part === 'guards') {
  rechargeFlowSuccessorControls();
  ownedMysqlTestControls();
  releaseMaintenanceControls();
  releaseArtifactRetentionChecks();
  archiveReleaseControls();
  onlineSourcePermissionRepairControls();
  workspacePublicPermissionRepairControls();
  onlineBackupSourceRecoveryControls();
  backupRetentionProtectionControls();
  if (
    changed.some((path) =>
      [
        'scripts/backup-aws-mysql.sh',
        'scripts/verify-aws-mysql-backup.sh',
        'scripts/mysql-dump-restore-normalizer.sed',
        'scripts/aws-mysql-backup.test.mjs'
      ].includes(path)
    )
  )
    run('node', ['--test', 'scripts/aws-mysql-backup.test.mjs']);
  if (changed.some((path) => /^scripts\/admin-skin-rules(?:\.test)?\.mjs$/.test(path)))
    run('node', ['--test', 'scripts/admin-skin-rules.test.mjs']);
  if (changed.some((path) => path.startsWith('scripts/production-release/cleanup-reviewed-cache')))
    run('python3', ['-B', 'scripts/production-release/cleanup-reviewed-cache.test.py']);
  if (
    changed.some((path) => path.startsWith('scripts/production-release/cleanup-verified-backups'))
  )
    run('python3', ['-B', 'scripts/production-release/cleanup-verified-backups.test.py']);
  if (
    changed.includes('deploy/aws/recharge-pro-menu-b8-20261005.json') ||
    changed.includes('deploy/aws/recharge-pro-menu-7f-20261005.json') ||
    changed.includes('deploy/aws/recharge-pro-main80-20261006.json') ||
    changed.includes('deploy/aws/recharge-pro-974-20261007.json') ||
    changed.includes('deploy/aws/registration-worker-b8-80-20261006.json') ||
    changed.includes('deploy/aws/registration-worker-956-20261006.json') ||
    changed.includes('deploy/aws/registration-worker-85-20261006.json') ||
    changed.includes('deploy/aws/registration-worker-86-20261006.json') ||
    changed.includes('deploy/aws/registration-worker-87-20261006.json') ||
    changed.includes('deploy/aws/registration-worker-88-20261006.json') ||
    changed.includes('deploy/aws/registration-worker-89-20261006.json') ||
    changed.includes('deploy/aws/registration-worker-90-20261007.json') ||
    changed.includes('deploy/aws/registration-worker-91-20261007.json') ||
    changed.includes('deploy/aws/registration-worker-92-20261007.json') ||
    changed.some((path) => path.startsWith('scripts/production-release/'))
  )
    run('python3', ['-B', 'scripts/production-release/remote-deploy.test.py']);
  if (changed.some((path) => registrationControlPaths.includes(path))) {
    run('node', ['--test', 'scripts/v2-registration-finance-audit.test.mjs']);
    run('python3', ['-B', 'scripts/production-release/remote-deploy.test.py', 'ReleaseScopeTests']);
  }
  if (hasRegistrationOnboardingScope(changed))
    run('python3', ['-B', 'scripts/production-release/registration-onboarding-96.test.py']);
  if (changed.some((path) => path.startsWith('scripts/production-release/storage-maintenance')))
    run('python3', ['-B', 'scripts/production-release/storage-maintenance.test.py']);
  if (
    changed.includes('.github/workflows/production-release.yml') ||
    changed.some((path) => path.startsWith('scripts/production-release/mailbox-diagnostic'))
  ) {
    run('node', ['--test', 'scripts/production-release/mailbox-diagnostic.test.mjs']);
    run('python3', ['-B', 'scripts/production-release/mailbox-diagnostic.test.py']);
  }
  if (
    changed.includes(auditRetentionMigration) ||
    changed.includes('scripts/production-release/audit-retention-mysql.test.py')
  )
    run('python3', ['-B', 'scripts/production-release/audit-retention-mysql.test.py']);
  const uiChecks = adminUiGuardChecks(mode, changed);
  if (
    changed.some(
      (path) =>
        path.includes('online-recharge') ||
        /^scripts\/check-v2-(?:table|loading|input-retention|decimal)-standard/.test(path)
    )
  )
    npm('run', 'test:online-recharge:controls');
  const architectureChecks = backendArchitectureGuardChecks(mode, changed);
  for (const name of new Set([...uiChecks, ...architectureChecks])) npm('run', name);
  if (!uiChecks.length && mode !== 'ci-only' && mode !== 'audit-retention') {
    npm(
      'run',
      'check:v2-decimal-standard',
      '--',
      'apps/admin/src/v2/features/auto-recharge',
      'apps/api/src/id-business-v2/auto-recharge',
      'packages/shared/src/v2'
    );
    npm('run', 'check:v2-ui-language', '--', 'apps/admin/src/v2/features/auto-recharge');
  }
} else if (part === 'release-controls') {
  if (!/^[a-f0-9]{40}$/.test(base)) throw new Error('Missing diff base');
  if (
    changed.some(
      (path) =>
        historicalReleaseControlPaths.includes(path) ||
        path.startsWith('scripts/production-release/') ||
        [
          '.github/workflows/quality.yml',
          'scripts/ci-recharge-check.mjs',
          'scripts/ci-recharge-scope.mjs',
          'scripts/ci-recharge-release.test.mjs'
        ].includes(path)
    )
  )
    run('node', ['--test', 'scripts/ci-recharge-release.test.mjs']);
  if (changed.some((path) => registrationControlPaths.includes(path))) {
    run('node', ['--test', 'scripts/v2-registration-finance-audit.test.mjs']);
    run('python3', ['-B', 'scripts/production-release/remote-deploy.test.py', 'ReleaseScopeTests']);
  }
  if (hasRegistrationOnboardingScope(changed))
    run('python3', ['-B', 'scripts/production-release/registration-onboarding-96.test.py']);
  // Full npm test already runs backup, finite history and its nested remote
  // deployment suite. Add only the missing preparation/retirement controls.
  if (
    changed.some(
      (path) =>
        path.startsWith('scripts/production-release/') ||
        path === '.github/workflows/production-release.yml' ||
        path === 'scripts/ci-recharge-check.mjs'
    )
  ) {
    run('python3', ['-B', 'scripts/production-release/api-admin-scope.test.py']);
    run('python3', ['-B', 'scripts/production-release/api-admin-readonly.test.py']);
    run('python3', ['-B', 'scripts/production-release/api-admin-pending-projection.test.py']);
    run('python3', ['-B', 'scripts/production-release/api-admin-pending-online.test.py']);
    run('python3', ['-B', 'scripts/production-release/api-admin-pending-receipt-wire.test.py']);
    run('python3', ['-B', 'scripts/production-release/api-workspace-declaration-readonly.test.py']);
    run('python3', [
      '-B',
      'scripts/production-release/online-recharge-declaration-measurement.test.py'
    ]);
    run('python3', ['-B', 'scripts/production-release/online-recharge-daemon-identity.test.py']);
    run('python3', ['-B', 'scripts/production-release/online-recharge-daemon-listener.test.py']);
    run('python3', ['-B', 'scripts/production-release/online-recharge-daemon-socket.test.py']);
    run('python3', [
      '-B',
      'scripts/production-release/online-recharge-runtime-socket-diagnostic.test.py'
    ]);
    run('python3', [
      '-B',
      'scripts/production-release/api-workspace-declaration-artifacts.test.py'
    ]);
    run('python3', ['-B', 'scripts/production-release/formal-runtime-package.test.py']);
  }
  if (
    changed.some((path) => path.includes('online-recharge') || onlineReleaseControlPaths.has(path))
  ) {
    onlineRecoveryGrantControls();
    run('python3', ['-B', 'scripts/production-release/online-recharge-component-consumer.test.py']);
    run('python3', ['-B', 'scripts/production-release/online-recharge-component-runtime.test.py']);
    run('python3', ['-B', 'scripts/production-release/online-recharge-component-readonly.test.py']);
    run('python3', ['-B', 'scripts/production-release/online-recharge-scope.test.py']);
    run('python3', ['-B', 'scripts/production-release/online-recharge-readonly.test.py']);
    run('node', ['--test', 'scripts/production-release/online-recharge-entry.test.mjs']);
  }
  adminPendingReleaseControls();
  unpublishedComponentSuccessorControls();
  rechargeFlowSuccessorControls();
  ownedMysqlTestControls();
  releaseMaintenanceControls();
  releaseArtifactRetentionChecks();
  archiveReleaseControls();
  onlineSourcePermissionRepairControls();
  workspacePublicPermissionRepairControls();
  onlineBackupSourceRecoveryControls();
  backupRetentionProtectionControls();
} else if (part === 'admin') {
  for (const args of adminCheckCommands(mode, changed))
    npm(...(sharedPoolOnly ? sharedProxyAdminCommand(args) : args));
} else if (part === 'api') {
  npm('run', 'prisma:mysql:generate');
  npm('run', 'prisma:mysql:validate');
  shared();
  if (mode === 'mailbox')
    npm(
      'run',
      'test',
      '--workspace',
      '@apple-business/api',
      '--',
      'src/id-business-v2/workspace/providers/id-business-v2-vendure-mailbox.client.spec.ts',
      'src/id-business-v2/workspace/id-business-v2-vendure-mailbox.service.spec.ts',
      'src/id-business-v2/workspace/id-business-v2-mail-viewer.service.spec.ts'
    );
  else
    npm(
      'run',
      'test',
      '--workspace',
      '@apple-business/api',
      '--',
      'src/id-business-v2/auto-recharge',
      ...(hasAppleMailboxScope(changed) ? ['src/id-business-v2/auto-registration'] : []),
      ...(changed.some((p) => p.includes('/proxy-pool/')) ? ['src/id-business-v2/proxy-pool'] : []),
      ...(changed.some((p) => p.startsWith('apps/api/src/id-business-v2/online-recharge/'))
        ? ['src/id-business-v2/online-recharge']
        : []),
      ...(changed.some((p) => p.startsWith('apps/api/src/auth/'))
        ? ['src/auth', 'src/security']
        : []),
      ...(changed.some((p) =>
        /^apps\/api\/src\/id-business-v2\/workspace\/(?:recharge-mail-code|id-business-v2-vendure-mailbox\.service|id-business-v2-workspace\.module|public-api)/.test(
          p
        )
      )
        ? [
            'src/id-business-v2/workspace/recharge-mail-code.spec.ts',
            'src/id-business-v2/workspace/id-business-v2-vendure-mailbox.service.spec.ts'
          ]
        : [])
    );
  npm('run', 'build', '--workspace', '@apple-business/api');
  if (hasAppleMailboxScope(changed)) {
    npm('run', 'auto-registration:setup');
    const python = '.runtime/auto-registration/venv/bin/python';
    const worker = 'apps/api/src/id-business-v2/auto-registration/worker';
    for (const name of [
      'test_workspace.py',
      'test_apple_mailboxes.py',
      'test_release_safety.py',
      'test_registration_closed_loop_unit.py',
      'test_upload_compat.py'
    ])
      run(python, ['-B', '-m', 'unittest', 'discover', '-s', worker, '-p', name]);
    run('node', ['--test', worker + '/test_payment_browser.mjs']);
    run(python, ['-B', worker + '/acceptance_runtime.py']);
  }
  if (changed.some((p) => p.startsWith('apps/api/src/id-business-v2/online-recharge/')))
    onlineEngine();
} else if (part === 'online-engine') {
  if (changed.some((p) => p.startsWith('apps/api/src/id-business-v2/online-recharge/')))
    onlineEngine();
} else if (part === 'migration') {
  const combined = hasCombinedComponentScope(changed);
  if (combined && process.env.GITHUB_ACTIONS !== 'true')
    throw new Error('组合发布数据库验收只能在 GitHub Actions 隔离环境执行');
  const connections = hasRechargeConnectionMigrationScope(changed);
  const mirror = hasRegistrationMirrorScope(changed);
  if (connections || mirror) {
    npm('run', 'prisma:mysql:generate');
    npm('run', 'prisma:mysql:validate');
    shared();
    npm('run', 'build', '--workspace', '@apple-business/api');
    if (connections)
      run('node', [
        'scripts/acceptance-v2-recharge-employee-concurrency.mjs',
        '--runtime=docker',
        ...(combined ? ['--combined-release'] : [])
      ]);
    if (mirror) {
      npm('run', 'auto-registration:setup');
      run('node', [
        'scripts/acceptance-v2-registration-mirror-mysql.mjs',
        '--runtime=docker',
        '--python=' + resolve('.runtime/auto-registration/venv/bin/python')
      ]);
    }
  } else {
    run('python3', ['scripts/ci-recharge-migration.py']);
  }
  // Shared-pool and registration changes can be in the same candidate. Keep
  // both real database suites; the mirror branch must not hide proxy coverage.
  if (
    changed.some((path) => path.includes('/proxy-pool/')) ||
    changed.includes('scripts/acceptance-v2-shared-proxy-mysql.mjs')
  ) {
    if (!connections && !mirror) {
      npm('run', 'prisma:mysql:generate');
      shared();
    }
    run('node', ['scripts/acceptance-v2-shared-proxy-mysql.mjs']);
  }
} else if (part === 'connector') {
  const workerDirectory = 'apps/api/src/id-business-v2/auto-recharge/worker';
  const fullPro = changed.some((path) =>
    [`${workerDirectory}/plan_selection.py`, `${workerDirectory}/test_pro.py`].includes(path)
  );
  const rechargeFlowRegression = changed.some((path) =>
    [
      'attempt_ledger.py',
      'bitbrowser_connector.py',
      'bitbrowser_retry.py',
      'browser_checkout.py',
      'native_checkout.py',
      'callback_observation.py',
      'pay.py',
      'payment_form.py',
      'test_payment_form_focus.py',
      'payment_network.py',
      'payment_recovery.py',
      'payment_state.py',
      'subscription_cycle.py',
      'subscription_upgrade.py',
      'upgrade_authentication.py',
      'test_callback_observation.py',
      'test_response_settlement.py',
      'test_subscription_cycle.py',
      'test_payment.py',
      'test_native_checkout.py'
    ].some((name) => path === `${workerDirectory}/${name}`)
  );
  const workerOptions = {
    cwd: workerDirectory,
    stdio: 'inherit',
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: '1',
      PLAYWRIGHT_BROWSERS_PATH: resolve(workerDirectory, '.browsers')
    }
  };
  execFileSync('python3', ['-m', 'playwright', 'install', 'chromium'], workerOptions);
  if (rechargeFlowRegression) {
    // Native checkout contracts execute the real API sanitizer in Node.
    if (!existsSync(resolve('node_modules/typescript/package.json')))
      npm('ci', '--ignore-scripts', '--no-audit');
    // These contracts load Prisma types/Decimal but never connect to a database.
    npm('run', 'prisma:mysql:generate', '--workspace', '@apple-business/api', '--', '--no-engine');
    shared();
  }
  execFileSync(
    'python3',
    [
      '-m',
      'unittest',
      'test_bitbrowser_catalog',
      'test_bitbrowser_options',
      'test_bitbrowser_connector',
      'test_bitbrowser_upgrade',
      'test_owned_recharge_profile',
      'test_connector_health',
      'test_session_retry',
      'test_bitbrowser_readiness',
      fullPro ? 'test_pro' : 'test_pro.ProMenuDiagnosticsTests',
      'test_server',
      'test_worker_isolation',
      'test_server_proxy',
      'test_fingerprint_runtime',
      'test_password_login',
      'test_subscribe',
      ...(rechargeFlowRegression ? ['test_native_checkout', 'test_native_pro_checkout'] : []),
      rechargeFlowRegression ? 'test_payment' : 'test_payment.StateTests',
      ...(rechargeFlowRegression
        ? ['test_callback_observation', 'test_response_settlement', 'test_subscription_cycle']
        : []),
      'test_recharge_email_code',
      'test_payment_3ds',
      'test_payment_form_focus',
      'test_payment_form_budget',
      'test_payment_handoff',
      'test_subscription_upgrade',
      'test_upgrade_card_selection',
      'test_upgrade_card_flow',
      'test_go.GoStateTests'
    ],
    workerOptions
  );
} else if (part === 'security') {
  if (sharedPoolOnly) {
    npm('ci', '--no-audit');
    npm('run', 'prisma:mysql:generate');
    npm('run', 'acceptance:v2-production-database-access');
  } else if (
    mode === 'ci-only' &&
    changed.some((path) =>
      [productionDatabaseAccessHelper, productionDatabaseAccessAcceptance].includes(path)
    )
  ) {
    if (!hasBankCardDeletePolicyProof(changed, readProductionDatabaseAccessSnapshot(base, changed)))
      throw new Error('Missing exact bank-card policy source proof');
    // The security matrix job has no workspace dependencies. Prepare only the
    // locked client needed by the existing disposable-database permission test.
    npm('ci', '--no-audit');
    npm('run', 'prisma:mysql:generate');
    npm('run', 'acceptance:v2-production-database-access');
  } else {
    run('python3', ['-B', 'scripts/audit-python-dependencies.test.py']);
    run('node', ['--test', 'scripts/container-hardening.test.mjs']);
    run('sh', ['-n', 'scripts/start-auto-recharge-connector.sh']);
  }
} else throw new Error('Unknown recharge check part');
