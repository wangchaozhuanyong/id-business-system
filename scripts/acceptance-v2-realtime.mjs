#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const transactionManager = read(
  'apps/api/src/id-business-v2/runtime/id-business-v2-command-transaction.service.ts'
);
const publisher = read('apps/api/src/common/prisma/v2-change-event.publisher.ts');
const employeesService = read('apps/api/src/v2-auth/employees/v2-employees.service.ts');
const rolesService = read('apps/api/src/v2-auth/roles/v2-roles.service.ts');
const realtimeController = read(
  'apps/api/src/id-business-v2/change-sync/id-business-v2-realtime.controller.ts'
);
const realtimeService = read(
  'apps/api/src/id-business-v2/change-sync/id-business-v2-change-sync.service.ts'
);
const changeSyncApi = read('apps/admin/src/v2/api/changeSync.ts');
const changeSyncRuntime = read('apps/admin/src/v2/runtime/changeSync.ts');

assert.match(
  transactionManager,
  /const result = await this\.prisma\.\$transaction[\s\S]*publishCommittedChangeBestEffort\(changedScopes\)/,
  '事务成功提交后没有发布精确 scope 事件'
);
assert.match(
  publisher,
  /if \(this\.subscriberCount === 0\) return/,
  '没有浏览器订阅时仍可能额外查询版本表'
);
assert.match(
  publisher,
  /where: \{ scope: \{ in: uniqueScopes \} \}/,
  '实时事件没有按本次变更 scope 精确读取版本'
);
assert.match(
  publisher,
  /committedChanges\.next\(\{ type: 'reconcile' \}\)/,
  '提交成功但事件发布失败时没有要求在线浏览器重连补偿'
);
assert.doesNotMatch(
  publisher,
  /phone|password|giftCard|appleId|orderNo/,
  '实时发布器不得读取或广播业务敏感字段'
);
assert.match(
  employeesService,
  /const employee = await this\.prisma\.\$transaction[\s\S]*publishCommittedChangeBestEffort\(\['employees', 'security'\]\)/,
  '员工写入提交后没有发布 employees/security 事件'
);
assert.match(
  rolesService,
  /(?:const role =|role =) await this\.prisma\.\$transaction[\s\S]*publishCommittedChangeBestEffort\(\['employees', 'security'\]\)/,
  '角色写入提交后没有发布 employees/security 事件'
);
assert.match(realtimeController, /@Controller\('realtime'\)/, '缺少统一 realtime 路由');
assert.match(realtimeController, /@Sse\('events'\)/, '缺少 SSE 事件端点');
assert.match(realtimeController, /@SkipApiResponse\(\)/, 'SSE 被普通 API envelope 包装');
assert.doesNotMatch(realtimeController, /@Public/, '实时端点不得公开访问');
assert.match(realtimeService, /type: 'heartbeat'/, 'SSE 缺少只维持连接的心跳事件');

assert.match(changeSyncApi, /Authorization: `Bearer \$\{credential\.token\}`/, 'SSE 未复用 JWT');
assert.doesNotMatch(changeSyncApi, /accessToken=|searchParams.*token/i, 'JWT 不得出现在 SSE URL');
assert.match(changeSyncApi, /text\/event-stream/, '前端未验证 SSE 响应类型');
assert.match(changeSyncRuntime, /\.streamEvents\(/, '前端未建立事件驱动连接');
assert.match(
  changeSyncRuntime,
  /if \(!started \|\| streamConnected \|\| document\.visibilityState === 'hidden'\) return/,
  '实时连接正常时没有阻止15秒版本轮询'
);
assert.match(
  changeSyncRuntime,
  /type === 'snapshot'[\s\S]*establishEventBaseline/,
  '首次 SSE 快照没有建立版本基线'
);
assert.match(changeSyncRuntime, /type === 'heartbeat'/, '心跳事件不应触发业务查询失效');
assert.match(changeSyncRuntime, /scheduleStreamReconnect/, '实时连接缺少断线重连');
assert.match(changeSyncRuntime, /scheduleFallbackReconcile/, '实时连接失败后缺少版本补偿');
assert.doesNotMatch(changeSyncRuntime, /setInterval\(/, '管理端不得固定轮询实时业务数据');

console.log(
  '[V2 realtime] PASSED: 提交后精确 scope 推送、JWT SSE、无变化不轮询、心跳保活、断线重连与15秒降级补偿均已建立'
);

function read(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}
