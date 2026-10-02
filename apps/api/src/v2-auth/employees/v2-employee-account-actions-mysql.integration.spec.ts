import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { hashPassword, verifyPassword } from '../../auth/password-hasher';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RechargeAddressRepository } from '../../id-business-v2/auto-recharge/persistence/recharge-address.repository';
import { RechargeRepository } from '../../id-business-v2/auto-recharge/persistence/recharge.repository';
import { IdBusinessV2TotpAccountRepository } from '../../id-business-v2/workspace/persistence/id-business-v2-totp-account.repository';
import { IdBusinessV2RelayScriptRepository } from '../../id-business-v2/workspace/persistence/id-business-v2-relay-script.repository';
import { IdBusinessV2RelayJobRunnerService } from '../../id-business-v2/workspace/id-business-v2-relay-job-runner.service';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService
} from '../../id-business-v2/runtime/public-api';
import {
  ensureSystemSuperAdmin,
  EMPLOYEE_TAKEOVER_PREFIX,
  SYSTEM_SUPER_ADMIN_KEY
} from '../system-super-admin';
import { V2EmployeeAccountActionsService } from './v2-employee-account-actions.service';

const url = process.env.V2_RECHARGE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('employee account actions on isolated MySQL', () => {
  let prisma: PrismaService;
  let service: V2EmployeeAccountActionsService;
  const ownerId = randomUUID();
  const employeeId = randomUUID();
  const otherId = randomUUID();
  const jobId = randomUUID();
  const accountKey = 'e'.repeat(64);
  const operator = {
    id: ownerId,
    username: 'ppfzj1314',
    displayName: '系统负责人',
    roles: ['admin', 'super_admin'],
    permissions: []
  };
  const document = {
    checkout_identifier: 'fixture_checkout',
    payment_status: 'succeeded',
    payment_attempted: true,
    confirmation_requests_sent: 1,
    amount: '88.8800',
    original_actor: employeeId
  };
  const security = { assertPasswordMeetsPolicy: vi.fn(), invalidateActiveSessionCache: vi.fn() };
  const identity = { invalidateAuthenticatedUser: vi.fn() };
  const events = { publishCommittedChangeBestEffort: vi.fn() };
  const makeService = (audit = new AuditLogsService(prisma)) =>
    new V2EmployeeAccountActionsService(
      prisma,
      audit,
      security as never,
      identity as never,
      events as never
    );
  const version = async () =>
    (await prisma.user.findUniqueOrThrow({ where: { id: employeeId } })).updatedAt.toISOString();

  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      parsed.hostname !== '127.0.0.1' ||
      !parsed.pathname.includes('financial_integrity_employee_')
    )
      throw new Error('仅允许本任务的一次性隔离验收库');
    prisma = new PrismaService({ datasourceUrl: url });
    await prisma.$connect();
    await prisma.role.create({ data: { code: 'admin', name: '普通管理员' } });
    await prisma.user.createMany({
      data: [
        {
          id: ownerId,
          username: 'ppfzj1314',
          displayName: '系统负责人',
          passwordHash: await hashPassword(randomUUID())
        },
        {
          id: employeeId,
          username: 'employee-' + employeeId,
          displayName: '待移交员工',
          passwordHash: await hashPassword(randomUUID())
        },
        {
          id: otherId,
          username: 'other-' + otherId,
          displayName: '普通管理员',
          passwordHash: await hashPassword(randomUUID())
        }
      ]
    });
    await prisma.v2AuthIdentity.createMany({
      data: [ownerId, employeeId, otherId].map((userId) => ({
        userId,
        authUserId: userId,
        usernameNormalized: userId,
        authEmail: `${userId}@local.invalid`,
        enabled: true,
        mustResetPassword: false
      }))
    });
    service = makeService();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('concurrently initializes one binding and keeps it after username changes', async () => {
    expect(
      await Promise.all([ensureSystemSuperAdmin(prisma), ensureSystemSuperAdmin(prisma)])
    ).toEqual([ownerId, ownerId]);
    expect(await prisma.securitySetting.count({ where: { key: SYSTEM_SUPER_ADMIN_KEY } })).toBe(1);
    expect(
      await prisma.auditLog.count({ where: { action: 'system_super_admin.initialize' } })
    ).toBe(1);
    await prisma.user.update({ where: { id: ownerId }, data: { username: 'owner-renamed' } });
    await prisma.user.update({ where: { id: otherId }, data: { username: 'ppfzj1314' } });
    expect(await ensureSystemSuperAdmin(prisma)).toBe(ownerId);
    await prisma.user.update({ where: { id: otherId }, data: { username: 'other-' + otherId } });
    await prisma.user.update({ where: { id: ownerId }, data: { username: 'ppfzj1314' } });
  });

  it('resets a hashed password, revokes sessions, and preserves MFA without leaking credentials to audit', async () => {
    await prisma.activeSession.create({
      data: {
        userId: employeeId,
        tokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000)
      }
    });
    await prisma.securitySetting.create({
      data: { key: `mfa_user_${employeeId}`, value: { enabled: true, fixture: 'binding-kept' } }
    });
    const password = randomUUID() + 'Aa1!';
    await service.resetPassword(
      employeeId,
      { expectedUpdatedAt: await version(), newPassword: password },
      operator
    );
    const employee = await prisma.user.findUniqueOrThrow({ where: { id: employeeId } });
    expect(await verifyPassword(password, employee.passwordHash)).toBe(true);
    expect(
      (await prisma.v2AuthIdentity.findUniqueOrThrow({ where: { userId: employeeId } }))
        .mustResetPassword
    ).toBe(true);
    expect(
      await prisma.activeSession.count({ where: { userId: employeeId, revokedAt: null } })
    ).toBe(0);
    expect(
      (await prisma.securitySetting.findUniqueOrThrow({ where: { key: `mfa_user_${employeeId}` } }))
        .value
    ).toEqual({ enabled: true, fixture: 'binding-kept' });
    const logs = await prisma.auditLog.findMany({ where: { objectId: employeeId } });
    expect(JSON.stringify(logs)).not.toContain(password);
    expect(JSON.stringify(logs)).not.toContain(employee.passwordHash);
  });

  it('blocks an ordinary administrator and protects the system owner', async () => {
    await expect(
      service.deletePreview(employeeId, { ...operator, id: otherId, roles: ['admin'] })
    ).rejects.toThrow('仅系统超级管理员');
    await expect(service.deletePreview(ownerId, operator)).rejects.toThrow('受保护');
  });

  it('blocks unfinished jobs and unknown attempted payments', async () => {
    await prisma.idBusinessV2RechargeJob.create({
      data: {
        id: jobId,
        ownerId: employeeId,
        plan: 'plus',
        action: 'quote',
        state: 'running',
        result: {
          payment_status: 'unknown',
          payment_attempted: true,
          checkout_identifier: 'fixture_checkout'
        },
        accountKey,
        leaseUntil: new Date()
      }
    });
    expect((await service.deletePreview(employeeId, operator)).canDelete).toBe(false);
    await prisma.idBusinessV2RechargeJob.update({
      where: { id: jobId },
      data: { state: 'finished' }
    });
    expect((await service.deletePreview(employeeId, operator)).canDelete).toBe(false);
    await prisma.idBusinessV2RechargeRecord.create({
      data: {
        accountKey,
        fileKey: 'fixture.json',
        ownerId: employeeId,
        revision: 1,
        document: { ...document, payment_status: 'unknown' }
      }
    });
    const blocked = await service.deletePreview(employeeId, operator);
    expect(blocked.canDelete).toBe(false);
    await expect(service.remove(employeeId, blocked, operator)).rejects.toThrow('付款结果未确认');
    await prisma.idBusinessV2RechargeRecord.update({
      where: { accountKey_fileKey: { accountKey, fileKey: 'fixture.json' } },
      data: { document }
    });
  });

  it('rejects changed impact and rolls back every mutation if auditing fails', async () => {
    const initial = await service.deletePreview(employeeId, operator);
    const address = await prisma.idBusinessV2RechargeAddress.create({
      data: { ownerId: employeeId, line1: 'Same street', line2: 'employee source' }
    });
    await prisma.idBusinessV2RechargeAddress.create({
      data: { ownerId, line1: 'Same street', line2: 'owner source' }
    });
    await prisma.idBusinessV2RechargeAddressUse.create({
      data: { ownerId: employeeId, jobId, addressId: address.id }
    });
    await expect(service.remove(employeeId, initial, operator)).rejects.toThrow('影响已变化');
    const preview = await service.deletePreview(employeeId, operator);
    const broken = makeService({
      create: vi.fn().mockRejectedValue(new Error('audit unavailable'))
    } as never);
    await expect(broken.remove(employeeId, preview, operator)).rejects.toThrow('audit unavailable');
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: employeeId } })).deletedAt
    ).toBeNull();
    expect(
      (await prisma.v2AuthIdentity.findUniqueOrThrow({ where: { userId: employeeId } })).enabled
    ).toBe(true);
    expect(
      (await prisma.idBusinessV2RechargeJob.findUniqueOrThrow({ where: { id: jobId } })).ownerId
    ).toBe(employeeId);
    expect(
      await prisma.securitySetting.count({ where: { key: EMPLOYEE_TAKEOVER_PREFIX + employeeId } })
    ).toBe(0);
  });

  it('soft-deletes once under repeated requests and takes over business while retaining source history and colliding addresses', async () => {
    const totp = new IdBusinessV2TotpAccountRepository(prisma);
    const relay = new IdBusinessV2RelayScriptRepository(prisma);
    const totpRows = await Promise.all(
      [employeeId, ownerId].map((userId) =>
        prisma.idBusinessV2TotpAccount.create({
          data: {
            userId,
            name: '同名业务动态口令',
            secretEncrypted: 'synthetic-encrypted-non-credential',
            secretHash: 'a'.repeat(64)
          }
        })
      )
    );
    const relayRows = await Promise.all(
      [employeeId, ownerId].map((userId) =>
        prisma.idBusinessV2RelayJob.create({
          data: {
            userId,
            deploymentKey: 'same-deployment',
            accountLabel: '同名业务任务',
            targetGroupId: 1,
            mode: 'gemini_api'
          }
        })
      )
    );
    const lease = randomUUID();
    expect(
      await relay.acquireJobLease(
        relayRows[0].id,
        employeeId,
        lease,
        new Date(),
        new Date(Date.now() + 60_000)
      )
    ).toBe(true);
    const renewalTime = new Date(Date.now() + 30_000);
    const renewedExpiry = new Date(+renewalTime + 180_000);
    expect(await relay.renewJobLease(relayRows[0].id, lease, renewalTime, renewedExpiry)).toBe(
      true
    );
    expect(
      await relay.acquireJobLease(
        relayRows[0].id,
        employeeId,
        randomUUID(),
        new Date(+renewalTime + 60_000),
        new Date(+renewalTime + 240_000)
      )
    ).toBe(false);
    await expect(
      prisma.$transaction((tx) =>
        relay.updateLeasedJob(relayRows[0].id, 'stale-lease', { status: 'completed' }, tx)
      )
    ).rejects.toThrow('执行保护已失效');
    await prisma.idBusinessV2RelayJob.update({
      where: { id: relayRows[0].id },
      data: { runLeaseExpiresAt: new Date(Date.now() - 1000) }
    });
    await expect(
      prisma.$transaction((tx) =>
        relay.updateLeasedJob(relayRows[0].id, lease, { status: 'completed' }, tx)
      )
    ).rejects.toThrow('执行保护已失效');
    expect(
      (await prisma.idBusinessV2RelayJob.findUniqueOrThrow({ where: { id: relayRows[0].id } }))
        .status
    ).toBe('draft');
    await prisma.idBusinessV2RelayJob.update({
      where: { id: relayRows[0].id },
      data: { runLeaseExpiresAt: renewedExpiry }
    });
    expect((await service.deletePreview(employeeId, operator)).blockers.join(' ')).toContain(
      '中转脚本任务正在执行'
    );
    await relay.releaseJobLease(relayRows[0].id, lease);
    const customer = await prisma.idBusinessV2Customer.create({
      data: { name: '保留来源客户', createdByUserId: employeeId }
    });
    await prisma.auditLog.create({
      data: {
        userId: employeeId,
        module: 'customers',
        action: 'customer.create',
        objectId: customer.id
      }
    });
    await prisma.activeSession.create({
      data: {
        userId: employeeId,
        tokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000)
      }
    });
    const preview = await service.deletePreview(employeeId, operator);
    expect(preview.counts).toMatchObject({ businessTotpAccounts: 1, relayJobs: 1 });
    const results = await Promise.all([
      service.remove(employeeId, preview, operator),
      service.remove(employeeId, preview, operator)
    ]);
    expect(results.filter((result) => !result.alreadyDeleted)).toHaveLength(1);
    const employee = await prisma.user.findUniqueOrThrow({ where: { id: employeeId } });
    expect(employee.status).toBe('disabled');
    expect(employee.deletedAt).not.toBeNull();
    expect(
      (await prisma.v2AuthIdentity.findUniqueOrThrow({ where: { userId: employeeId } })).enabled
    ).toBe(false);
    expect(
      await prisma.activeSession.count({ where: { userId: employeeId, revokedAt: null } })
    ).toBe(0);
    expect(
      await prisma.auditLog.count({ where: { objectId: employeeId, action: 'employee.delete' } })
    ).toBe(1);
    expect(
      (await prisma.idBusinessV2Customer.findUniqueOrThrow({ where: { id: customer.id } }))
        .createdByUserId
    ).toBe(employeeId);
    expect(
      (await prisma.auditLog.findFirstOrThrow({ where: { objectId: customer.id } })).userId
    ).toBe(employeeId);
    const record = await prisma.idBusinessV2RechargeRecord.findUniqueOrThrow({
      where: { accountKey_fileKey: { accountKey, fileKey: 'fixture.json' } }
    });
    expect(record.ownerId).toBe(ownerId);
    expect(record.document).toEqual(document);
    expect(
      (await prisma.idBusinessV2RechargeJob.findUniqueOrThrow({ where: { id: jobId } })).ownerId
    ).toBe(ownerId);
    expect(
      (await prisma.idBusinessV2RechargeAddressUse.findUniqueOrThrow({ where: { jobId } })).ownerId
    ).toBe(ownerId);
    const addresses = new RechargeAddressRepository(prisma);
    const query = { page: 1, pageSize: 20, keyword: '', status: 'all' as const };
    const acquired = await addresses.list(ownerId, query);
    expect(acquired.items.map((address) => address.line2).sort()).toEqual([
      'employee source',
      'owner source'
    ]);
    expect((await addresses.list(otherId, query)).total).toBe(0);
    const sourceAddress = acquired.items.find((address) => address.ownerId === employeeId)!;
    await prisma.$transaction((tx) =>
      addresses.updateStatus(tx, ownerId, sourceAddress.id, 'disabled')
    );
    await expect(
      prisma.$transaction((tx) => addresses.updateStatus(tx, otherId, sourceAddress.id, 'disabled'))
    ).rejects.toThrow('找不到');
    await expect(
      prisma.$transaction((tx) => addresses.createMany(tx, employeeId, ['stale request']))
    ).rejects.toThrow('已停用或删除');
    await expect(
      prisma.$transaction((tx) =>
        new RechargeRepository(prisma).createJob(tx, {
          id: randomUUID(),
          ownerId: employeeId,
          plan: 'plus',
          action: 'quote',
          state: 'created',
          result: {},
          leaseUntil: new Date()
        })
      )
    ).rejects.toThrow('已停用或删除');
    expect(await prisma.securitySetting.count({ where: { key: `mfa_user_${ownerId}` } })).toBe(0);
    expect(await prisma.securitySetting.count({ where: { key: `mfa_user_${employeeId}` } })).toBe(
      1
    );
    expect((await totp.listByUser(ownerId)).map((row) => row.id).sort()).toEqual(
      totpRows.map((row) => row.id).sort()
    );
    expect(await totp.findByIdAndUser(totpRows[0].id, ownerId)).toMatchObject({
      userId: employeeId,
      name: '同名业务动态口令'
    });
    expect(await totp.findByIdAndUser(totpRows[0].id, otherId)).toBeNull();
    expect((await relay.listJobsByUser(ownerId)).map((row) => row.id).sort()).toEqual(
      relayRows.map((row) => row.id).sort()
    );
    expect(await relay.findJobByIdAndUser(relayRows[0].id, otherId)).toBeNull();
    await prisma.$transaction((tx) =>
      totp
        .assertWriter(tx, ownerId)
        .then(() => totp.update(tx, totpRows[0].id, { name: '接管后编辑' }))
    );
    expect((await totp.findByIdAndUser(totpRows[0].id, ownerId))?.userId).toBe(employeeId);
    expect(
      await relay.acquireJobLease(
        relayRows[0].id,
        ownerId,
        lease,
        new Date(),
        new Date(Date.now() + 60_000)
      )
    ).toBe(true);
    await relay.releaseJobLease(relayRows[0].id, lease);
    await expect(prisma.$transaction((tx) => totp.assertWriter(tx, employeeId))).rejects.toThrow(
      '已停用或删除'
    );
    await expect(
      relay.acquireJobLease(
        relayRows[0].id,
        employeeId,
        randomUUID(),
        new Date(),
        new Date(Date.now() + 60_000)
      )
    ).rejects.toThrow('已停用或删除');
    expect(await prisma.idBusinessV2TotpAccount.count()).toBe(2);
    expect(await prisma.idBusinessV2RelayJob.count()).toBe(2);
    const runner = new IdBusinessV2RelayJobRunnerService(
      relay,
      new V2CommandTransactionManager(prisma),
      new V2TransactionalAuditService(),
      {} as never,
      { requireCloudBridgeConnection: async () => ({}) } as never,
      { execute: async () => ({ completed: true, progress: {} }) } as never,
      {} as never,
      {} as never
    );
    await runner.runNextStep(relayRows[0].id, operator);
    const executionAudit = await prisma.auditLog.findFirstOrThrow({
      where: {
        objectId: relayRows[0].id,
        action: 'id_business_v2.workspace_relay.job_step_complete'
      }
    });
    expect(executionAudit.userId).toBe(ownerId);
    expect(
      (await prisma.idBusinessV2RelayJob.findUniqueOrThrow({ where: { id: relayRows[0].id } }))
        .userId
    ).toBe(employeeId);
  });
});
