import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { AuditLogsService } from './audit-logs.service';

describe('AuditLogsService', () => {
  function createService() {
    const auditRecord = {
      id: 'audit-1',
      userId: '11111111-1111-4111-8111-111111111111',
      module: 'id_business_v2',
      action: 'order.update',
      objectType: 'order',
      objectId: '22222222-2222-4222-8222-222222222222',
      beforeData: { status: 'pending', password: 'must-not-leak' },
      afterData: { status: 'completed', maskedPhone: '138****0000' },
      ip: '127.0.0.1',
      userAgent: 'Vitest',
      remark: '订单状态更新',
      createdAt: new Date('2026-07-30T00:00:00.000Z'),
      user: {
        id: '11111111-1111-4111-8111-111111111111',
        username: 'admin',
        displayName: '管理员'
      }
    };
    const sensitiveRecord = {
      id: 'sensitive-1',
      userId: auditRecord.userId,
      module: 'apple',
      fieldName: 'password',
      objectType: 'account',
      objectId: auditRecord.objectId,
      accessReason: '客户核对',
      approved: true,
      ip: '127.0.0.1',
      userAgent: 'Vitest',
      createdAt: new Date('2026-07-30T01:00:00.000Z'),
      user: auditRecord.user
    };
    const auditLog = {
      create: vi.fn().mockResolvedValue({ id: 'created-audit' }),
      findMany: vi.fn().mockResolvedValue([auditRecord]),
      count: vi.fn().mockResolvedValue(1)
    };
    const sensitiveAccessLog = {
      findMany: vi.fn().mockResolvedValue([sensitiveRecord]),
      count: vi.fn().mockResolvedValue(1)
    };
    const prisma = { auditLog, sensitiveAccessLog } as unknown as PrismaService;
    return {
      service: new AuditLogsService(prisma),
      auditLog,
      sensitiveAccessLog
    };
  }

  it('redacts sensitive values before creating an audit log', async () => {
    const { service, auditLog } = createService();

    await expect(
      service.create({
        userId: '11111111-1111-4111-8111-111111111111',
        module: 'id_business_v2',
        action: 'create',
        objectType: 'order',
        beforeData: {
          password: 'plaintext',
          tokenHash: 'hash',
          maskedPhone: '138****0000'
        }
      })
    ).resolves.toEqual({ id: 'created-audit' });

    expect(auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        module: 'id_business_v2',
        objectType: 'order',
        beforeData: {
          password: '[REDACTED]',
          tokenHash: '[REDACTED]',
          maskedPhone: '138****0000'
        }
      })
    });
  });

  it('lists operation logs with filters, Malaysia date boundaries and safe details', async () => {
    const { service, auditLog } = createService();

    const result = await service.list({
      page: '2',
      pageSize: '20',
      module: 'business',
      operator: 'admin',
      keyword: '订单',
      createdFrom: '2026-07-30',
      createdTo: '2026-07-31'
    });

    expect(result).toMatchObject({
      total: 1,
      page: 2,
      pageSize: 20,
      items: [
        {
          beforeData: { status: 'pending', password: '[REDACTED]' },
          afterData: { status: 'completed', maskedPhone: '138****0000' }
        }
      ]
    });
    expect(auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 20,
        take: 20,
        where: expect.objectContaining({
          module: { contains: 'business', mode: 'insensitive' },
          createdAt: {
            gte: new Date('2026-07-29T16:00:00.000Z'),
            lt: new Date('2026-07-31T16:00:00.000Z')
          }
        })
      })
    );
  });

  it('lists sensitive access logs with approval and field filters', async () => {
    const { service, sensitiveAccessLog } = createService();

    await expect(
      service.listSensitiveAccess({
        page: '1',
        pageSize: '50',
        fieldName: 'password',
        approved: 'true',
        sortBy: 'module',
        sortOrder: 'asc'
      })
    ).resolves.toMatchObject({
      total: 1,
      page: 1,
      pageSize: 50,
      items: [{ id: 'sensitive-1', approved: true }]
    });
    expect(sensitiveAccessLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          fieldName: { contains: 'password', mode: 'insensitive' },
          approved: true
        }),
        orderBy: [{ module: 'asc' }, { createdAt: 'desc' }]
      })
    );
  });

  it('records who exported the filtered operation logs', async () => {
    const { service, auditLog } = createService();

    const result = await service.export(
      { kind: 'operations', module: 'orders' },
      {
        id: '11111111-1111-4111-8111-111111111111',
        username: 'admin',
        displayName: '管理员',
        roles: ['admin'],
        permissions: ['audit_log.view']
      }
    );

    expect(result).toMatchObject({
      kind: 'operations',
      total: 1,
      exportedCount: 1,
      capped: false
    });
    expect(auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: '11111111-1111-4111-8111-111111111111',
        module: 'audit_logs',
        action: 'audit_logs.export'
      })
    });
  });

  it('rejects invalid filters instead of silently changing their meaning', async () => {
    const { service } = createService();

    await expect(service.list({ sortBy: 'createdAt', sortOrder: 'random' })).rejects.toThrow(
      new BadRequestException('sortOrder is invalid')
    );
    await expect(service.list({ createdFrom: '2026-02-30' })).rejects.toThrow(
      new BadRequestException('created date is invalid')
    );
    await expect(service.listSensitiveAccess({ approved: 'yes' })).rejects.toThrow(
      new BadRequestException('approved is invalid')
    );
  });
});
