#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const failures = [];

function read(path) {
  return readFileSync(path, 'utf8');
}

function requireText(path, source, fragment, message) {
  if (!source.includes(fragment)) failures.push(`${path}: ${message}`);
}

function requireOrder(path, source, first, second, message) {
  const firstIndex = source.indexOf(first);
  const secondIndex = source.indexOf(second);
  if (firstIndex < 0 || secondIndex < 0 || firstIndex >= secondIndex) {
    failures.push(`${path}: ${message}`);
  }
}

const transactionPath =
  'apps/api/src/id-business-v2/runtime/id-business-v2-command-transaction.service.ts';
const transaction = read(transactionPath);
requireText(
  transactionPath,
  transaction,
  "options.isolationLevel ?? 'Serializable'",
  '业务写事务必须默认使用 Serializable 隔离级别'
);
requireText(
  transactionPath,
  transaction,
  'idempotencyKey?: never',
  '不可重放命令必须在类型层禁止幂等键重试'
);
requireText(transactionPath, transaction, 'idempotencyKey: string', '可重放命令必须要求稳定幂等键');
requireText(
  transactionPath,
  transaction,
  "throw new Error('V2 command transaction requires at least one changed scope')",
  '写事务必须声明至少一个实时失效范围'
);
requireOrder(
  transactionPath,
  transaction,
  'await bumpV2ScopeVersions(tx, changedScopes, context.businessTime)',
  'publishCommittedChangeBestEffort(changedScopes)',
  '范围版本必须在事务内更新，实时事件只能在提交成功后发布'
);

const employeeApiPath = 'apps/api/src/v2-auth/employees/v2-employees.service.ts';
const employeeApi = read(employeeApiPath);
requireText(
  employeeApiPath,
  employeeApi,
  'normalizeExpectedUpdatedAt(dto.expectedUpdatedAt)',
  '员工修改必须校验客户端读取版本'
);
requireText(
  employeeApiPath,
  employeeApi,
  'const claimed = await transaction.user.updateMany',
  '员工修改必须先原子抢占版本'
);
requireOrder(
  employeeApiPath,
  employeeApi,
  'const claimed = await transaction.user.updateMany',
  'await transaction.activeSession.updateMany',
  '员工版本抢占必须发生在会话或角色副作用之前'
);
requireOrder(
  employeeApiPath,
  employeeApi,
  "await bumpV2ScopeVersions(transaction, ['employees', 'security'])",
  "publishCommittedChangeBestEffort(['employees', 'security'])",
  '员工实时事件只能在事务提交后发布'
);

const employeeUiPath = 'apps/admin/src/v2/features/employees/useEmployeesPage.ts';
requireText(
  employeeUiPath,
  read(employeeUiPath),
  'expectedUpdatedAt: current.updatedAt',
  '员工编辑必须提交列表快照版本'
);

const roleApiPath = 'apps/api/src/v2-auth/roles/v2-roles.service.ts';
const roleApi = read(roleApiPath);
requireText(
  roleApiPath,
  roleApi,
  'normalizeExpectedUpdatedAt(dto.expectedUpdatedAt)',
  '角色修改必须校验客户端读取版本'
);
requireText(roleApiPath, roleApi, 'updatedAt: expectedUpdatedAt', '角色最终写入必须带版本条件');

const securityPath = 'apps/api/src/security/security.service.ts';
const security = read(securityPath);
requireText(
  securityPath,
  security,
  "acquireMysqlTransactionLock(client, 'security:ip-whitelists')",
  'IP 白名单安全校验与写入必须由同一全局事务锁串行化'
);
requireText(
  securityPath,
  security,
  'const expectedUpdatedAt = this.normalizeExpectedUpdatedAt(',
  'IP 白名单编辑必须校验客户端读取版本'
);
requireText(
  securityPath,
  security,
  "await bumpV2ScopeVersions(client, ['security'])",
  'IP 白名单提交必须在事务内更新安全范围版本'
);
requireOrder(
  securityPath,
  security,
  "await bumpV2ScopeVersions(client, ['security'])",
  "publishCommittedChangeBestEffort(['security'])",
  '安全范围实时事件只能在事务提交后发布'
);

const securityUiPath = 'apps/admin/src/v2/features/security/useSecurityPolicyManagement.ts';
const securityUi = read(securityUiPath);
requireText(
  securityUiPath,
  securityUi,
  'expectedUpdatedAt: editingWhitelist.value.updatedAt',
  'IP 白名单编辑必须提交列表快照版本'
);
requireText(
  securityUiPath,
  securityUi,
  'removeIpWhitelist(item.id, item.updatedAt)',
  'IP 白名单删除必须提交列表快照版本'
);

const financialIntegrationPath =
  'apps/api/src/id-business-v2/finance/id-business-v2-financial-integrity-mysql.integration.spec.ts';
const financialIntegration = read(financialIntegrationPath);
requireText(
  financialIntegrationPath,
  financialIntegration,
  'Promise.all(Array.from({ length: 8 }',
  '财务完整性门禁必须保留并发写入测试'
);
requireText(
  financialIntegrationPath,
  financialIntegration,
  'size).toBe(1)',
  '并发幂等写入必须断言只产生一个业务结果'
);

const schemaPath = 'apps/api/prisma/schema.prisma';
const schema = read(schemaPath);
const uniqueIdempotencyFields = [...schema.matchAll(/idempotencyKey\s+String[^\n]*@unique/g)]
  .length;
if (uniqueIdempotencyFields < 5) {
  failures.push(`${schemaPath}: 幂等键唯一约束数量异常（当前 ${uniqueIdempotencyFields}）`);
}

if (failures.length) {
  console.error(`V2 并发标准检查失败（${failures.length} 项）：`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `V2 并发标准检查通过：Serializable 事务、幂等重放、提交后事件、员工/角色乐观并发、白名单全局锁与版本校验、财务并发门禁均已锁定；Prisma 唯一幂等键 ${uniqueIdempotencyFields} 个。`
);
