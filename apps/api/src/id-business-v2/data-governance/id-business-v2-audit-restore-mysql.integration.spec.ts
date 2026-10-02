import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import { IdBusinessV2AuditRestoreService } from './id-business-v2-audit-restore.service';
import { IdBusinessV2AuditRestoreRepository } from './persistence/id-business-v2-audit-restore.repository';

const databaseUrl = process.env.V2_AUDIT_RESTORE_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const admin: AuthenticatedUser = {
  id: randomUUID(),
  username: `restore-${randomUUID()}`,
  displayName: '资料恢复验收管理员',
  roles: ['admin'],
  permissions: []
};
const version = new Date('2026-10-02T01:00:00.000Z');

suite('ordinary field restoration in disposable MySQL', () => {
  let prisma: PrismaClient;
  let repository: IdBusinessV2AuditRestoreRepository;
  let service: IdBusinessV2AuditRestoreService;
  let audit: V2TransactionalAuditService;
  let countryId: string;
  let statusId: string;
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      !/^\/id_business_v2_audit_restore_drill_\d+$/.test(url.pathname)
    )
      throw new Error('This suite only accepts its explicitly named disposable localhost database');
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.user.create({
      data: {
        id: admin.id,
        username: admin.username,
        displayName: admin.displayName,
        passwordHash: 'test-non-login-identity'
      }
    });
    repository = new IdBusinessV2AuditRestoreRepository(prisma as never);
    audit = new V2TransactionalAuditService();
    service = new IdBusinessV2AuditRestoreService(
      repository,
      new V2CommandTransactionManager(prisma as never),
      audit
    );
    countryId = (
      await prisma.idBusinessV2Option.create({
        data: {
          type: 'country',
          name: '恢复验收国家',
          code: randomUUID(),
          uniqueKey: randomUUID()
        }
      })
    ).id;
    statusId = (
      await prisma.idBusinessV2Option.create({
        data: {
          type: 'id_status',
          name: '恢复验收状态',
          code: randomUUID(),
          uniqueKey: randomUUID()
        }
      })
    ).id;
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function customer() {
    const row = await prisma.idBusinessV2Customer.create({
      data: {
        name: '错误名称',
        remark: '当前备注',
        updatedAt: version
      }
    });
    const log = await prisma.auditLog.create({
      data: {
        userId: admin.id,
        module: 'id_business_v2_customers',
        action: 'id_business_v2.customer.update',
        objectType: 'id_business_v2_customer',
        objectId: row.id,
        beforeData: { id: row.id, name: '正确名称', remark: null },
        afterData: {
          id: row.id,
          name: row.name,
          remark: row.remark,
          updatedAt: row.updatedAt.toISOString()
        }
      }
    });
    return { row, log };
  }
  it('restores only selected fields and saves actor, reason, source and before/after values', async () => {
    const { row, log } = await customer();
    const preview = await service.preview(log.id, admin);
    expect(preview.canRestore).toBe(true);
    const result = await service.restore(
      log.id,
      {
        previewFingerprint: preview.previewFingerprint,
        fields: ['name'],
        reason: '名称录入错误'
      },
      admin
    );
    const current = await prisma.idBusinessV2Customer.findUniqueOrThrow({ where: { id: row.id } });
    expect(current.name).toBe('正确名称');
    expect(current.remark).toBe('当前备注');
    expect(current.updatedAt.getTime()).toBeGreaterThan(row.updatedAt.getTime());
    const recorded = await prisma.auditLog.findUniqueOrThrow({ where: { id: result.auditId } });
    expect(recorded.userId).toBe(admin.id);
    expect(recorded.beforeData).toMatchObject({ name: '错误名称', remark: '当前备注' });
    expect(recorded.afterData).toMatchObject({
      name: '正确名称',
      remark: '当前备注',
      restoredFromAuditId: log.id,
      restoreReason: '名称录入错误',
      restoredFieldLabels: ['客户名称']
    });
    await expect(
      service.restore(
        log.id,
        { previewFingerprint: preview.previewFingerprint, fields: ['name'], reason: '再次恢复' },
        admin
      )
    ).rejects.toThrow(/后来已被修改或恢复/);
  });
  it('rolls back the business update and version notification if audit saving fails', async () => {
    const { row, log } = await customer();
    const preview = await service.preview(log.id, admin);
    const failing = new IdBusinessV2AuditRestoreService(
      repository,
      new V2CommandTransactionManager(prisma as never),
      {
        append: async () => {
          throw new Error('synthetic audit failure');
        }
      } as never
    );
    const count = await prisma.auditLog.count();
    await expect(
      failing.restore(
        log.id,
        {
          previewFingerprint: preview.previewFingerprint,
          fields: ['name'],
          reason: '事务回滚验收'
        },
        admin
      )
    ).rejects.toThrow('synthetic audit failure');
    const current = await prisma.idBusinessV2Customer.findUniqueOrThrow({ where: { id: row.id } });
    expect(current.name).toBe(row.name);
    expect(current.updatedAt).toEqual(row.updatedAt);
    expect(await prisma.auditLog.count()).toBe(count);
  });
  it('rejects stale previews, unsupported fields and missing old values without writes', async () => {
    const { row, log } = await customer();
    const preview = await service.preview(log.id, admin);
    await expect(
      service.restore(
        log.id,
        {
          previewFingerprint: preview.previewFingerprint,
          fields: ['phone'] as never,
          reason: '不允许恢复敏感字段'
        },
        admin
      )
    ).rejects.toThrow(/不支持/);
    await prisma.idBusinessV2Customer.update({
      where: { id: row.id },
      data: {
        remark: '后续更正',
        updatedAt: new Date(version.getTime() + 100)
      }
    });
    await expect(
      service.restore(
        log.id,
        { previewFingerprint: preview.previewFingerprint, fields: ['name'], reason: '旧预览' },
        admin
      )
    ).rejects.toThrow(/后来已被修改/);
    await prisma.auditLog.create({
      data: {
        ...{ module: log.module, action: log.action, objectType: log.objectType, objectId: row.id },
        beforeData: {},
        afterData: log.afterData!
      }
    });
    expect(
      (await prisma.idBusinessV2Customer.findUniqueOrThrow({ where: { id: row.id } })).name
    ).toBe(row.name);
  });
  it('allows just one concurrent confirmation', async () => {
    const { row, log } = await customer();
    const preview = await service.preview(log.id, admin);
    const input = {
      previewFingerprint: preview.previewFingerprint,
      fields: ['name'] as const,
      reason: '并发确认验收'
    };
    const result = await Promise.allSettled(
      [1, 2].map(() => service.restore(log.id, { ...input, fields: [...input.fields] }, admin))
    );
    expect(result.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(
      (await prisma.idBusinessV2Customer.findUniqueOrThrow({ where: { id: row.id } })).name
    ).toBe('正确名称');
    expect(
      await prisma.auditLog.count({
        where: { objectId: row.id, action: 'id_business_v2.customer.restore_fields' }
      })
    ).toBe(1);
  });
  it('restores ID notes without touching money, credentials, state or ledger rows', async () => {
    const row = await prisma.idBusinessV2Account.create({
      data: {
        appleIdEncrypted: 'synthetic-encrypted-identity',
        appleIdHash: randomUUID(),
        appleIdMasked: 'qa***@example.com',
        countryOptionId: countryId,
        statusOptionId: statusId,
        currentBalance: '123.4567',
        balanceCostAmount: '80.1234',
        purchaseCost: '10.0000',
        remark: '错误备注',
        updatedAt: version
      }
    });
    const log = await prisma.auditLog.create({
      data: {
        userId: admin.id,
        module: 'id_business_v2_accounts',
        action: 'id_business_v2.account.update',
        objectType: 'id_business_v2_account',
        objectId: row.id,
        beforeData: { remark: null, currentBalance: '1.0000' },
        afterData: {
          remark: row.remark,
          currentBalance: '123.4567',
          updatedAt: row.updatedAt.toISOString()
        }
      }
    });
    const preview = await service.preview(log.id, admin);
    expect(preview.fields.map((field) => field.key)).toEqual(['remark']);
    const ledger = await prisma.idBusinessV2BalanceLedger.count();
    await service.restore(
      log.id,
      {
        previewFingerprint: preview.previewFingerprint,
        fields: ['remark'],
        reason: '备注录入错误'
      },
      admin
    );
    const restored = await prisma.idBusinessV2Account.findUniqueOrThrow({ where: { id: row.id } });
    expect(restored.remark).toBeNull();
    for (const key of ['currentBalance', 'balanceCostAmount', 'purchaseCost'] as const)
      expect(restored[key].toString()).toBe(row[key].toString());
    expect(restored.appleIdEncrypted).toBe(row.appleIdEncrypted);
    expect(restored.recordStatus).toBe(row.recordStatus);
    expect(await prisma.idBusinessV2BalanceLedger.count()).toBe(ledger);
  });
  it('rebuilds option uniqueness from the original name and refuses a later name conflict', async () => {
    const row = await prisma.idBusinessV2Option.create({
      data: {
        type: 'customer_tag',
        code: randomUUID(),
        name: '错误标签',
        uniqueKey: 'customer_tag:root:错误标签',
        remark: '新备注',
        sortOrder: 5,
        updatedAt: version
      }
    });
    const log = await prisma.auditLog.create({
      data: {
        userId: admin.id,
        module: 'id_business_v2_options',
        action: 'id_business_v2.option.update',
        objectType: 'id_business_v2_option',
        objectId: row.id,
        beforeData: { name: '正确标签', remark: null, sortOrder: 2 },
        afterData: {
          name: row.name,
          remark: row.remark,
          sortOrder: 5,
          updatedAt: row.updatedAt.toISOString()
        }
      }
    });
    const preview = await service.preview(log.id, admin);
    const conflict = await prisma.idBusinessV2Option.create({
      data: {
        type: 'customer_tag',
        code: randomUUID(),
        name: '正确标签',
        uniqueKey: 'customer_tag:root:正确标签'
      }
    });
    await expect(
      service.restore(
        log.id,
        {
          previewFingerprint: preview.previewFingerprint,
          fields: ['name'],
          reason: '名称冲突验收'
        },
        admin
      )
    ).rejects.toThrow(/预览已变化/);
    await prisma.idBusinessV2Option.update({
      where: { id: conflict.id },
      data: {
        name: '另一标签',
        uniqueKey: 'customer_tag:root:另一标签'
      }
    });
    const fresh = await service.preview(log.id, admin);
    await service.restore(
      log.id,
      {
        previewFingerprint: fresh.previewFingerprint,
        fields: ['name', 'sortOrder'],
        reason: '选项录入错误'
      },
      admin
    );
    expect(
      await prisma.idBusinessV2Option.findUniqueOrThrow({ where: { id: row.id } })
    ).toMatchObject({
      name: '正确标签',
      uniqueKey: 'customer_tag:root:正确标签',
      sortOrder: 2,
      remark: '新备注'
    });
  });
  it('restores remark and sort order while a conflicting old name remains blocked', async () => {
    const name = `原标签-${randomUUID()}`;
    const row = await prisma.idBusinessV2Option.create({
      data: {
        type: 'customer_tag',
        code: randomUUID(),
        name: `新-${name}`,
        uniqueKey: `customer_tag:root:新-${name}`,
        remark: '新备注',
        sortOrder: 8,
        updatedAt: version
      }
    });
    await prisma.idBusinessV2Option.create({
      data: {
        type: 'customer_tag',
        code: randomUUID(),
        name,
        uniqueKey: `customer_tag:root:${name}`
      }
    });
    const source = await prisma.auditLog.create({
      data: {
        userId: admin.id,
        module: 'id_business_v2_options',
        action: 'id_business_v2.option.update',
        objectType: 'id_business_v2_option',
        objectId: row.id,
        beforeData: { name, remark: '原备注', sortOrder: 2 },
        afterData: {
          name: row.name,
          remark: row.remark,
          sortOrder: row.sortOrder,
          updatedAt: version.toISOString()
        }
      }
    });
    const preview = await service.preview(source.id, admin);
    expect(preview.canRestore).toBe(true);
    await expect(
      service.restore(
        source.id,
        { fields: ['name'], reason: '名称冲突', previewFingerprint: preview.previewFingerprint },
        admin
      )
    ).rejects.toThrow('不能恢复名称');
    const result = await service.restore(
      source.id,
      {
        fields: ['remark', 'sortOrder'],
        reason: '只纠正无冲突资料',
        previewFingerprint: preview.previewFingerprint
      },
      admin
    );
    expect(
      await prisma.idBusinessV2Option.findUniqueOrThrow({ where: { id: row.id } })
    ).toMatchObject({ name: row.name, uniqueKey: row.uniqueKey, remark: '原备注', sortOrder: 2 });
    expect(
      (await prisma.auditLog.findUniqueOrThrow({ where: { id: result.auditId } })).afterData
    ).toMatchObject({ restoredFieldLabels: ['备注', '排序'], restoredFromAuditId: source.id });
    await expect(
      service.restore(
        source.id,
        { fields: ['remark'], reason: '重复确认', previewFingerprint: preview.previewFingerprint },
        admin
      )
    ).rejects.toThrow('后来已被修改或恢复');
  });
});
