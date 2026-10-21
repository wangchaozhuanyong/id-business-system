import assert from 'node:assert/strict';
import test from 'node:test';
import {
  financialPublicationControlPaths,
  isFinancialPublicationControlsOnly
} from './ci-financial-publication-scope.mjs';
import { checkMode, needsOnlineRechargeCiBuild, selectedParts } from './ci-recharge-scope.mjs';

test('有限账务发布只执行控制检查，业务与数据库沿用已验证输入', () => {
  const paths = [...financialPublicationControlPaths];
  assert.equal(isFinancialPublicationControlsOnly(paths), true);
  assert.equal(checkMode(paths, 'same', 'same'), 'ci-only');
  assert.deepEqual(selectedParts(paths), ['guards', 'release-controls']);
  assert.equal(needsOnlineRechargeCiBuild(paths), false);
  assert.equal(checkMode(paths, 'before', 'after'), 'full');
});

test('任何附加业务、支付、权限、依赖、历史发布或未知文件都拒绝控制范围', () => {
  for (const name of [
    'apps/api/src/id-business-v2/online-recharge/persistence/admin.repository.ts',
    'apps/api/src/id-business-v2/online-recharge/engine/worker.cjs',
    'apps/admin/src/v2/features/online-recharge/OnlineResourceView.vue',
    'apps/api/src/auth/auth.service.ts',
    'apps/api/prisma-mysql/schema.prisma',
    'apps/api/prisma-mysql/migrations/new/migration.sql',
    'package-lock.json',
    'scripts/production-release/bitbrowser-history-release.py',
    '.github/workflows/production-release.yml',
    'scripts/production-release/financial-closure-unknown.py'
  ]) {
    const paths = [...financialPublicationControlPaths, name];
    assert.equal(isFinancialPublicationControlsOnly(paths), false, name);
    assert.equal(checkMode(paths, 'same', 'same'), 'full', name);
  }
});

test('冻结契约单独更新仍验证控制；缺少契约或重复文件不能取得控制范围', () => {
  assert.equal(isFinancialPublicationControlsOnly([]), false);
  assert.equal(isFinancialPublicationControlsOnly(['docs/V2_TASKS.md']), false);
  assert.equal(
    isFinancialPublicationControlsOnly([
      'scripts/production-release/financial-closure-contract.json'
    ]),
    true
  );
  assert.equal(
    isFinancialPublicationControlsOnly([
      ...financialPublicationControlPaths,
      financialPublicationControlPaths[0]
    ]),
    false
  );
});
