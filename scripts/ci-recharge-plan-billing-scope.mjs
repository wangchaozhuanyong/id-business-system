import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const rechargePlanBillingPublicationControls = Object.freeze([
  '.github/workflows/recharge-plan-billing-publication.yml',
  'scripts/production-release/recharge-plan-billing-build.py',
  'scripts/production-release/recharge-plan-billing-release.py',
  'scripts/production-release/recharge-plan-billing-publication.py',
  'scripts/production-release/recharge-plan-billing-release.test.py',
  'scripts/production-release/recharge-plan-billing-contract.json',
  'scripts/ci-recharge-plan-billing-scope.mjs',
  'scripts/ci-recharge-plan-billing-scope.test.mjs',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-check.mjs',
  'scripts/ci-recharge-check.test.mjs'
]);

const allowed = new Set(rechargePlanBillingPublicationControls);
export function isRechargePlanBillingPublicationOnly(paths) {
  return (
    paths.length > 0 &&
    paths.some((path) => path.startsWith('scripts/production-release/recharge-plan-billing-')) &&
    paths.every((path) => allowed.has(path))
  );
}

const sourceFile = new URL('./recharge-plan-billing-source.json', import.meta.url);
const source = JSON.parse(readFileSync(sourceFile, 'utf8'));
const digest = (value) => createHash('sha256').update(value).digest('hex');
export const rechargePlanBillingSourcePaths = Object.freeze([
  ...Object.keys(source.sources),
  ...Object.keys(source.formatOnly),
  'scripts/recharge-plan-billing-source.json',
  'scripts/ci-recharge-plan-billing-scope.mjs',
  'scripts/ci-recharge-plan-billing-scope.test.mjs',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-check.mjs',
  'scripts/ci-recharge-check.test.mjs',
  'scripts/production-release/online-recharge-component-diagnostic.test.py',
  '.github/workflows/recharge-billing-allocation-validation.yml',
  'docs/V2_TASKS.md',
  'docs/RECHARGE_PLAN_BILLING_20261026.md'
]);
const sourceAllowed = new Set(rechargePlanBillingSourcePaths);
export function isRechargePlanBillingSourcePaths(paths) {
  if (
    !paths.includes('apps/api/prisma-mysql/schema.prisma') ||
    !paths.includes(
      'apps/api/prisma-mysql/migrations/20261026010000_recharge_billing_uniqueness/migration.sql'
    )
  )
    return false;
  if (
    source.version !== 1 ||
    source.reviewBase !== 'e317136851edfe3b49c0c44a8deed01b7de62a53' ||
    digest(JSON.stringify(Object.keys(source.sources).sort())) !==
      '0ad963ce065c48bfdc754a3b16c0762d45fe7aa090fa49dd26b036d29a0cf657' ||
    digest(JSON.stringify(Object.keys(source.formatOnly).sort())) !==
      'f651bb68167244199132d1cd256d661cf0d265928a34a56541e50b9fa3442c9c'
  )
    return false;
  if (
    !paths.length ||
    !paths.some((path) => Object.hasOwn(source.sources, path)) ||
    !paths.every((path) => sourceAllowed.has(path))
  )
    return false;
  try {
    return Object.entries({ ...source.sources, ...source.formatOnly }).every(
      ([name, expected]) =>
        /^[a-f0-9]{64}$/.test(expected) &&
        digest(readFileSync(new URL('../' + name, import.meta.url))) === expected
    );
  } catch {
    return false;
  }
}
export function isRechargePlanBillingSource(paths, before, after) {
  return (
    isRechargePlanBillingSourcePaths(paths) &&
    typeof before === 'string' &&
    typeof after === 'string' &&
    digest(before) === source.schemaBeforeSha256 &&
    digest(after) === source.sources['apps/api/prisma-mysql/schema.prisma']
  );
}
