import { ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import { IdBusinessV2CustomersService } from './id-business-v2-customers.service';
import { IdBusinessV2CustomerRepository } from './persistence/id-business-v2-customer.repository';

const operator = {
  id: '20000000-0000-4000-8000-000000000001',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: []
};

const source = { id: 'source-1', code: 'wechat', name: '微信' };
const tag = { id: 'tag-1', code: 'vip', name: '重点客户' };
const serviceOption = {
  id: 'service-1',
  code: 'chatgpt',
  name: 'ChatGPT Plus',
  parent: { id: 'category-1', name: 'AI 服务' }
};

function makeCustomer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'customer-1',
    name: '测试客户',
    phoneEncrypted: 'encrypted-phone',
    phoneHash: 'phone-hash',
    phoneMasked: '138****8000',
    phoneTail: '00138000',
    wechat: 'wx-test',
    qq: '10001',
    whatsappEncrypted: 'encrypted-whatsapp',
    whatsappHash: 'whatsapp-hash',
    whatsappMasked: '+60****6789',
    whatsappTail: '23456789',
    sourceOptionId: source.id,
    recordStatus: 'active',
    remark: null,
    createdByUserId: operator.id,
    updatedByUserId: operator.id,
    createdAt: new Date('2026-07-26T00:00:00.000Z'),
    updatedAt: new Date('2026-07-26T00:00:00.000Z'),
    deletedAt: null,
    sourceOption: source,
    tags: [{ customerId: 'customer-1', optionId: tag.id, createdAt: new Date(), option: tag }],
    services: [
      {
        customerId: 'customer-1',
        optionId: serviceOption.id,
        source: 'activation',
        firstOpenedAt: new Date('2026-05-01T00:00:00.000Z'),
        lastOpenedAt: new Date('2026-07-01T00:00:00.000Z'),
        activationCount: 3,
        createdAt: new Date(),
        option: serviceOption
      }
    ],
    ...overrides
  };
}

describe('IdBusinessV2CustomersService', () => {
  const prisma = {
    $transaction: vi.fn(),
    idBusinessV2Customer: {
      findMany: vi.fn(),
      count: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn()
    },
    sensitiveAccessLog: {
      create: vi.fn()
    },
    sensitiveAccessApproval: {
      findUnique: vi.fn()
    },
    auditLog: {
      create: vi.fn()
    }
  };
  const encryptionService = {
    encrypt: vi.fn(),
    decrypt: vi.fn(),
    hash: vi.fn()
  };
  const optionsService = {
    requireActiveOption: vi.fn(),
    requireActiveOptions: vi.fn()
  };
  const sensitiveAccessService = {
    authorize: vi.fn().mockResolvedValue({
      mode: 'direct',
      approvalId: null,
      reason: '角色权限直接查看'
    })
  };
  const service = new IdBusinessV2CustomersService(
    new IdBusinessV2CustomerRepository(prisma as never),
    encryptionService as never,
    optionsService as never,
    new V2CommandTransactionManager(prisma as never),
    new V2TransactionalAuditService(),
    sensitiveAccessService as never
  );

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(
      async (work: Array<Promise<unknown>> | ((tx: typeof prisma) => Promise<unknown>)) =>
        typeof work === 'function' ? work(prisma) : Promise.all(work)
    );
    encryptionService.encrypt.mockImplementation((value: string | null) =>
      value ? `encrypted:${value}` : null
    );
    encryptionService.hash.mockImplementation((value: string | null) =>
      value ? `hash:${value}` : null
    );
    encryptionService.decrypt.mockImplementation((value: string | null) =>
      value === 'encrypted-whatsapp' ? '+60123456789' : '13800138000'
    );
    optionsService.requireActiveOption.mockResolvedValue(source);
    optionsService.requireActiveOptions.mockResolvedValue([tag]);
    prisma.auditLog.create.mockResolvedValue({ id: 'audit-1' });
  });

  it('lists customers by stable business order without exposing a numeric sort value', async () => {
    prisma.idBusinessV2Customer.findMany.mockResolvedValue([makeCustomer()]);
    prisma.idBusinessV2Customer.count.mockResolvedValue(1);

    const result = await service.list({});

    expect(result.items[0]).not.toHaveProperty('sortOrder');
    expect(prisma.idBusinessV2Customer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        include: expect.objectContaining({
          services: expect.objectContaining({
            where: { source: 'activation' }
          })
        })
      })
    );
    expect(result.items[0]?.services).toEqual([
      expect.objectContaining({
        id: serviceOption.id,
        firstOpenedAt: new Date('2026-05-01T00:00:00.000Z'),
        lastOpenedAt: new Date('2026-07-01T00:00:00.000Z'),
        activationCount: 3
      })
    ]);
  });

  it('filters services by real activation history and searches QQ or WhatsApp safely', async () => {
    prisma.idBusinessV2Customer.findMany.mockResolvedValue([makeCustomer()]);
    prisma.idBusinessV2Customer.count.mockResolvedValue(1);

    await service.list({ serviceOptionId: serviceOption.id, keyword: '+60 12-345 6789' });

    expect(prisma.idBusinessV2Customer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          services: {
            some: {
              optionId: serviceOption.id,
              source: 'activation'
            }
          },
          OR: expect.arrayContaining([
            { qq: { contains: '+60 12-345 6789', mode: 'insensitive' } },
            { whatsappHash: 'hash:+60123456789' }
          ])
        })
      })
    );
  });

  it('encrypts customer phone and WhatsApp, stores QQ and keeps plaintext out of audit', async () => {
    prisma.idBusinessV2Customer.create.mockResolvedValue(makeCustomer());

    const result = await service.create(
      {
        name: '测试客户',
        phone: '138 0013 8000',
        qq: '10001',
        whatsapp: '+60 12-345 6789',
        sourceOptionId: source.id,
        tagOptionIds: [tag.id]
      },
      operator
    );

    expect(encryptionService.encrypt).toHaveBeenCalledWith('13800138000');
    expect(encryptionService.encrypt).toHaveBeenCalledWith('+60123456789');
    expect(prisma.idBusinessV2Customer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          phoneEncrypted: 'encrypted:13800138000',
          phoneHash: 'hash:13800138000',
          qq: '10001',
          whatsappEncrypted: 'encrypted:+60123456789',
          whatsappHash: 'hash:+60123456789',
          sourceOptionId: source.id,
          tags: { create: [{ optionId: tag.id }] }
        })
      })
    );
    const createData = prisma.idBusinessV2Customer.create.mock.calls[0]?.[0]?.data;
    expect(createData).not.toHaveProperty('services');
    expect(result.maskedPhone).toBe('138****8000');
    expect(result.maskedWhatsapp).toBe('+60****6789');
    expect(JSON.stringify(result)).not.toContain('encrypted-phone');
    expect(JSON.stringify(prisma.auditLog.create.mock.calls)).not.toContain('13800138000');
    expect(JSON.stringify(prisma.auditLog.create.mock.calls)).not.toContain('+60123456789');
  });

  it('rejects the customer command when the in-transaction audit fails', async () => {
    prisma.idBusinessV2Customer.create.mockResolvedValue(makeCustomer());
    prisma.auditLog.create.mockRejectedValueOnce(new Error('audit unavailable'));

    await expect(
      service.create({ name: '测试客户', sourceOptionId: source.id }, operator)
    ).rejects.toThrow('audit unavailable');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.idBusinessV2Customer.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('keeps WhatsApp when omitted and clears every stored derivative when explicitly null', async () => {
    prisma.idBusinessV2Customer.findFirst.mockResolvedValue(makeCustomer());
    prisma.idBusinessV2Customer.update
      .mockResolvedValueOnce(makeCustomer({ qq: '20002' }))
      .mockResolvedValueOnce(
        makeCustomer({
          whatsappEncrypted: null,
          whatsappHash: null,
          whatsappMasked: null,
          whatsappTail: null
        })
      );

    await service.update('customer-1', { qq: '20002' }, operator);
    expect(prisma.idBusinessV2Customer.update.mock.calls[0]?.[0]?.data).toEqual(
      expect.objectContaining({
        qq: '20002',
        whatsappEncrypted: undefined,
        whatsappHash: undefined,
        whatsappMasked: undefined,
        whatsappTail: undefined
      })
    );

    await service.update('customer-1', { whatsapp: null }, operator);
    expect(prisma.idBusinessV2Customer.update.mock.calls[1]?.[0]?.data).toEqual(
      expect.objectContaining({
        whatsappEncrypted: null,
        whatsappHash: null,
        whatsappMasked: null,
        whatsappTail: null
      })
    );
  });

  it('writes a sensitive access log when revealing a phone', async () => {
    prisma.idBusinessV2Customer.findFirst.mockResolvedValue(makeCustomer());

    const result = await service.revealPhone('customer-1', { reason: '处理客户续费' }, operator, {
      ip: '127.0.0.1',
      userAgent: 'vitest'
    });

    expect(result.phone).toBe('13800138000');
    expect(prisma.sensitiveAccessLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          module: 'id_business_v2_customer',
          fieldName: 'phone',
          accessReason: '处理客户续费'
        })
      })
    );
    expect(JSON.stringify(prisma.auditLog.create.mock.calls)).not.toContain('13800138000');
  });

  it('does not decrypt a contact when administrator approval is still missing', async () => {
    prisma.idBusinessV2Customer.findFirst.mockResolvedValue(makeCustomer());
    sensitiveAccessService.authorize.mockRejectedValueOnce(
      new ForbiddenException('该字段需要管理员批准后才能查看')
    );

    await expect(service.revealPhone('customer-1', {}, operator)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    expect(encryptionService.decrypt).not.toHaveBeenCalled();
    expect(prisma.sensitiveAccessLog.create).not.toHaveBeenCalled();
  });

  it('does not return decrypted contact data when sensitive audit persistence fails', async () => {
    prisma.idBusinessV2Customer.findFirst.mockResolvedValue(makeCustomer());
    prisma.auditLog.create.mockRejectedValueOnce(new Error('audit unavailable'));

    await expect(
      service.revealPhone('customer-1', { reason: '处理客户续费' }, operator)
    ).rejects.toThrow('audit unavailable');

    expect(prisma.sensitiveAccessLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('rejects phone reveal without the sensitive permission', async () => {
    await expect(
      service.revealPhone(
        'customer-1',
        { reason: '测试' },
        { ...operator, roles: [], permissions: ['customer.view'] }
      )
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('reuses phone permission and writes no plaintext when revealing WhatsApp', async () => {
    prisma.idBusinessV2Customer.findFirst.mockResolvedValue(makeCustomer());

    const result = await service.revealWhatsapp(
      'customer-1',
      { reason: '核对 WhatsApp 联系方式' },
      { ...operator, roles: [], permissions: ['customer.view_phone'] },
      { ip: '127.0.0.1', userAgent: 'vitest' }
    );

    expect(result.whatsapp).toBe('+60123456789');
    expect(prisma.sensitiveAccessLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fieldName: 'whatsapp',
          accessReason: '核对 WhatsApp 联系方式'
        })
      })
    );
    const auditCalls = JSON.stringify(prisma.auditLog.create.mock.calls);
    expect(auditCalls).toContain('id_business_v2.customer.whatsapp.reveal');
    expect(auditCalls).not.toContain('+60123456789');
  });

  it('soft deletes a customer and writes an audit log', async () => {
    prisma.idBusinessV2Customer.findFirst.mockResolvedValue(makeCustomer());
    prisma.idBusinessV2Customer.update.mockResolvedValue(makeCustomer({ deletedAt: new Date() }));

    await expect(service.remove('customer-1', operator)).resolves.toEqual({ deleted: true });
    expect(prisma.idBusinessV2Customer.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deletedAt: expect.any(Date)
        })
      })
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'id_business_v2.customer.delete' })
      })
    );
  });
});
