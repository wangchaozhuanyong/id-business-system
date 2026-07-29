import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { AuditLogsService } from './audit-logs.service';

describe('AuditLogsService', () => {
  function createService() {
    const auditLog = {
      create: vi.fn().mockResolvedValue({ id: 'audit-1' }),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0)
    };
    const prisma = { auditLog } as unknown as PrismaService;
    return {
      service: new AuditLogsService(prisma),
      auditLog
    };
  }

  it('creates a current-system audit log', async () => {
    const { service, auditLog } = createService();

    await expect(
      service.create({
        userId: '11111111-1111-4111-8111-111111111111',
        module: 'id_business_v2',
        action: 'create',
        objectType: 'order'
      })
    ).resolves.toEqual({ id: 'audit-1' });

    expect(auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        module: 'id_business_v2',
        objectType: 'order'
      })
    });
  });

  it('lists audit logs with pagination and current user data', async () => {
    const { service, auditLog } = createService();

    await expect(
      service.list({
        page: '2',
        pageSize: '20',
        module: 'id_business_v2',
        keyword: '订单'
      })
    ).resolves.toEqual({
      items: [],
      total: 0,
      page: 2,
      pageSize: 20
    });

    expect(auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 20,
        take: 20,
        include: {
          user: {
            select: {
              id: true,
              username: true,
              displayName: true
            }
          }
        }
      })
    );
  });

  it('rejects an unsupported sort order', async () => {
    const { service } = createService();

    await expect(service.list({ sortBy: 'createdAt', sortOrder: 'random' })).rejects.toThrow(
      new BadRequestException('sortOrder is invalid')
    );
  });
});
