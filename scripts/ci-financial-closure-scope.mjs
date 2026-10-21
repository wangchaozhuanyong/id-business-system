// This finite billing change uses current source tests/builds. The historical
// ONLINE image constructor only admits its original immutable application tree.
// Its constructor and its source seal remain unchanged.
import { financialPublicationControlPaths } from './ci-financial-publication-scope.mjs';
export const financialClosurePaths = Object.freeze([
  ...new Set([
    '.github/workflows/financial-closure-validation.yml',
    ...[
      'OnlineResourceView.vue',
      'OnlineResultDialog.vue',
      'V2OnlineOverviewView.vue',
      'auditPresentation.spec.ts',
      'billing-presentation.spec.ts',
      'billing-presentation.ts',
      'billing-result.spec.ts',
      'sections.ts',
      'tableSchemas.ts'
    ].map((name) => 'apps/admin/src/v2/features/online-recharge/' + name),
    ...[
      'billing.spec.ts',
      'mysql.integration.spec.ts',
      'persistence/admin.repository.ts',
      'persistence/billing-summary.ts'
    ].map((name) => 'apps/api/src/id-business-v2/online-recharge/' + name),
    'docs/ONLINE_RECHARGE.md',
    'docs/V2_TASKS.md',
    'package.json',
    'scripts/production-release/financial-closure-readonly.py',
    'scripts/production-release/financial-closure-readonly.test.py',
    ...[
      'acceptance-v2-financial-integrity.mjs',
      'acceptance-v2-online-billing-ui.mjs',
      'acceptance-v2-online-recharge-mysql.mjs',
      'check-v2-decimal-standard.test.mjs',
      'lib/v2-online-recharge-integrity.mjs',
      'v2-online-recharge-integrity-audit.mjs',
      'v2-online-recharge-integrity-mysql.test.mjs',
      'v2-online-recharge-integrity.test.mjs',
      'ci-financial-closure-scope.mjs',
      'ci-financial-closure-scope.test.mjs',
      'ci-recharge-scope.mjs',
      'ci-recharge-scope.test.mjs'
    ].map((name) => 'scripts/' + name),
    ...financialPublicationControlPaths
  ])
]);

const allowed = new Set(financialClosurePaths);
const owner = 'apps/api/src/id-business-v2/online-recharge/persistence/billing-summary.ts';

export function isFinancialClosureCandidate(paths) {
  return (
    paths.includes(owner) &&
    new Set(paths).size === paths.length &&
    paths.every((name) => allowed.has(name))
  );
}
