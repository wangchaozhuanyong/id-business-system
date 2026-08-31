import { BadRequestException } from '@nestjs/common';
import { V2_BRANDING_DEFAULTS } from '@apple-business/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import { IdBusinessV2BrandingService } from './id-business-v2-branding.service';
import { IdBusinessV2BrandingRepository } from './persistence/id-business-v2-branding.repository';

const operator = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: []
};
const now = new Date('2026-08-07T00:00:00.000Z');

function brandingRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    ...V2_BRANDING_DEFAULTS,
    updatedByUserId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

describe('IdBusinessV2BrandingService', () => {
  const tx = {
    idBusinessV2BrandingSettings: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn()
    },
    auditLog: { create: vi.fn() }
  };
  const prisma = {
    idBusinessV2BrandingSettings: {
      findUnique: vi.fn()
    },
    $transaction: vi.fn()
  };
  const service = new IdBusinessV2BrandingService(
    new IdBusinessV2BrandingRepository(prisma as never),
    new V2CommandTransactionManager(prisma as never),
    new V2TransactionalAuditService()
  );

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));
    prisma.idBusinessV2BrandingSettings.findUnique.mockResolvedValue(null);
    tx.idBusinessV2BrandingSettings.create.mockResolvedValue(brandingRecord());
    tx.idBusinessV2BrandingSettings.findUnique.mockResolvedValue(brandingRecord());
    tx.idBusinessV2BrandingSettings.update.mockImplementation(async ({ data }) =>
      brandingRecord({
        ...data,
        updatedByUserId: operator.id
      })
    );
    tx.auditLog.create.mockResolvedValue({ id: 'audit-1' });
  });

  it('creates default branding settings when the singleton is missing', async () => {
    await expect(service.get()).resolves.toMatchObject({
      appName: 'ID 业务管理',
      logoText: 'ID',
      logoUrl: '/brand/default-logo.svg',
      loginHeroTitle: '把订单、余额与续费\n收进一条安全动线'
    });
    expect(tx.idBusinessV2BrandingSettings.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: 1,
        appName: 'ID 业务管理',
        logoText: 'ID',
        logoUrl: '/brand/default-logo.svg'
      })
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'id_business_v2.branding.settings.initialize'
      })
    });
  });

  it('updates all editable copy fields and writes an audit record', async () => {
    await expect(
      service.update(
        {
          expectedUpdatedAt: now.toISOString(),
          appName: '会员业务后台',
          logoText: 'VIP',
          logoUrl: '/brand/member-logo.svg',
          appSubtitle: '订阅运营中心',
          loginHeroTitle: '订单和余额\n统一处理',
          loginNote: '仅限授权员工登录。',
          footerText: '© 2026 内部系统',
          documentTitleSuffix: '会员后台'
        },
        operator
      )
    ).resolves.toMatchObject({
      appName: '会员业务后台',
      logoText: 'VIP',
      logoUrl: '/brand/member-logo.svg',
      loginHeroTitle: '订单和余额\n统一处理',
      updatedByUserId: operator.id
    });

    expect(tx.idBusinessV2BrandingSettings.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1, updatedAt: now },
        data: expect.objectContaining({
          appName: '会员业务后台',
          logoText: 'VIP',
          logoUrl: '/brand/member-logo.svg',
          updatedByUserId: operator.id
        })
      })
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: operator.id,
        action: 'id_business_v2.branding.settings.update',
        beforeData: expect.objectContaining({ appName: 'ID 业务管理' }),
        afterData: expect.objectContaining({ appName: '会员业务后台' })
      })
    });
  });

  it('rejects missing operator, empty text and overly long hero titles', async () => {
    await expect(service.update(V2_BRANDING_DEFAULTS, undefined)).rejects.toBeInstanceOf(
      BadRequestException
    );
    await expect(
      service.update({ ...V2_BRANDING_DEFAULTS, appName: '   ' }, operator)
    ).rejects.toThrow('请填写软件名称');
    await expect(
      service.update({ ...V2_BRANDING_DEFAULTS, logoUrl: 'javascript:alert(1)' }, operator)
    ).rejects.toThrow('Logo 图片地址必须是站内路径或 http(s) 链接');
    await expect(
      service.update(
        { ...V2_BRANDING_DEFAULTS, loginHeroTitle: '第一行\n第二行\n第三行\n第四行' },
        operator
      )
    ).rejects.toThrow('登录主标题最多 3 行');
  });
});
