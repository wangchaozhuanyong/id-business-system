import assert from 'node:assert/strict';
import test from 'node:test';
import {
  financialClosurePaths,
  isFinancialClosureCandidate
} from './ci-financial-closure-scope.mjs';
import { checkMode, needsOnlineRechargeCiBuild } from './ci-recharge-scope.mjs';

test('账务有限范围保留完整质量检查，只排除历史固定源码镜像构造器', () => {
  assert.equal(isFinancialClosureCandidate([...financialClosurePaths]), true);
  assert.equal(checkMode([...financialClosurePaths], 'same-schema', 'same-schema'), 'full');
  assert.equal(needsOnlineRechargeCiBuild([...financialClosurePaths]), false);
});

test('未知执行器、支付、权限、schema、依赖及共享层差异均不能进入该范围', () => {
  for (const extra of [
    'apps/api/src/id-business-v2/online-recharge/engine/checkout-form.cjs',
    'apps/api/src/id-business-v2/online-recharge/persistence/worker.repository.ts',
    'apps/api/src/id-business-v2/online-recharge/tasks.service.ts',
    'apps/api/src/auth/auth.service.ts',
    'apps/api/prisma-mysql/schema.prisma',
    'apps/api/prisma-mysql/migrations/new/migration.sql',
    'apps/api/package.json',
    'package-lock.json',
    'packages/shared/src/v2/online-recharge.ts',
    'scripts/production-release/online-recharge-ci-build.py',
    '.github/workflows/production-release.yml'
  ])
    assert.equal(isFinancialClosureCandidate([...financialClosurePaths, extra]), false, extra);
});

test('空列表、缺少本轮账务模块、重复路径或伪造同名前缀均不能匹配', () => {
  assert.equal(isFinancialClosureCandidate([]), false);
  assert.equal(isFinancialClosureCandidate(['docs/V2_TASKS.md']), false);
  assert.equal(
    isFinancialClosureCandidate([...financialClosurePaths, financialClosurePaths[0]]),
    false
  );
  assert.equal(
    isFinancialClosureCandidate([
      ...financialClosurePaths,
      'apps/api/src/id-business-v2/online-recharge/persistence/billing-summary.ts/extra'
    ]),
    false
  );
});
