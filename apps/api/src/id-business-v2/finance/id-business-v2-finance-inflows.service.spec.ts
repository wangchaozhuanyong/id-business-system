import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { IdBusinessV2FinanceInflowsService } from './id-business-v2-finance-inflows.service';

const operator = {
  id: '20000000-0000-4000-8000-000000000001',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: ['finance.view', 'finance.post', 'finance.adjust']
};
const inflowId = '10000000-0000-4000-8000-000000000001';
const categoryId = '10000000-0000-4000-8000-000000000002';
const accountId = '10000000-0000-4000-8000-000000000003';
const journalId = '10000000-0000-4000-8000-000000000004';
const receiptAttachmentId = '10000000-0000-4000-8000-000000000007';

function receiptUpload() {
  const buffer = Buffer.from('%PDF-1.7\nreceipt');
  return {
    originalname: '收款凭证.pdf',
    mimetype: 'application/pdf',
    size: buffer.length,
    buffer
  };
}

function inflowRow(status: 'posted' | 'reversed' = 'posted') {
  return {
    id: inflowId,
    journalId,
    nature: 'operating_income' as const,
    categoryOptionId: categoryId,
    categoryNameSnapshot: '佣金收入',
    financeAccountId: accountId,
    financeAccountNameSnapshot: '人民币账户',
    currency: 'CNY',
    amountOriginal: '100',
    fxRateToCny: '1',
    amountCny: '100',
    occurredAt: new Date('2026-08-27T08:00:00.000Z'),
    payer: '合作方',
    externalReference: 'BANK-20260827-001',
    receiptAttachmentId,
    receiptAttachment: {
      id: receiptAttachmentId,
      originalName: '原收款凭证.pdf',
      mimeType: 'application/pdf',
      sizeBytes: BigInt(16),
      contentSha256: 'a'.repeat(64)
    },
    remark: null,
    createdAt: new Date('2026-08-27T08:00:00.000Z'),
    journal: { status }
  };
}

describe('IdBusinessV2FinanceInflowsService', () => {
  const tx = {};
  const commandTransactions = {
    execute: vi.fn(async (work: (transaction: typeof tx) => Promise<unknown>) => work(tx))
  };
  const commandRepository = {
    findInflowReplay: vi.fn(),
    findInflowForCorrection: vi.fn(),
    findIncomeReference: vi.fn(),
    createInflowIncomeReference: vi.fn(),
    createAttachment: vi.fn(),
    createInflow: vi.fn()
  };
  const queryRepository = {
    findInflowPrerequisites: vi.fn(),
    findOrderIncomeReferenceConflict: vi.fn(),
    findInflowReceipt: vi.fn()
  };
  const audit = { append: vi.fn() };
  const fxService = { resolve: vi.fn() };
  const postingService = { reverse: vi.fn(), post: vi.fn() };
  const encryption = { encrypt: vi.fn(() => 'encrypted'), decrypt: vi.fn() };
  const auditLogs = { create: vi.fn() };
  const service = new IdBusinessV2FinanceInflowsService(
    commandTransactions as never,
    commandRepository as never,
    queryRepository as never,
    audit as never,
    fxService as never,
    postingService as never,
    encryption as never,
    auditLogs as never
  );

  beforeEach(() => {
    vi.clearAllMocks();
    queryRepository.findInflowPrerequisites.mockResolvedValue({
      category: { id: categoryId, name: '佣金收入' },
      account: { id: accountId, name: '人民币账户', currency: 'CNY', status: 'active' }
    });
    fxService.resolve.mockResolvedValue({ id: null, rateToCny: '1' });
    commandRepository.findInflowReplay.mockResolvedValue(null);
    commandRepository.findInflowForCorrection.mockResolvedValue(inflowRow());
    commandRepository.findIncomeReference.mockResolvedValue(null);
    queryRepository.findOrderIncomeReferenceConflict.mockResolvedValue(null);
    postingService.reverse.mockResolvedValue({
      id: '10000000-0000-4000-8000-000000000005'
    });
    postingService.post.mockResolvedValue({ id: '10000000-0000-4000-8000-000000000006' });
    commandRepository.createInflow.mockImplementation(
      async (_transaction: unknown, input: Record<string, unknown>) => ({
        ...inflowRow(),
        ...input,
        journal: { status: 'posted' }
      })
    );
  });

  it('经营收入增加现金并计入其他经营收入', async () => {
    await service.create(
      {
        nature: 'operating_income',
        categoryOptionId: categoryId,
        financeAccountId: accountId,
        amount: '100',
        currency: 'CNY',
        occurredAt: '2026-08-27T08:00:00.000Z',
        payer: '合作方',
        externalReference: 'BANK-20260827-002',
        idempotencyKey: 'inflow-operating-test'
      },
      operator,
      receiptUpload()
    );

    expect(postingService.post).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        journalType: 'manual_operating_income',
        sourceType: 'inflow',
        lines: [
          expect.objectContaining({ accountCode: 'cash', direction: 'debit' }),
          expect.objectContaining({ accountCode: 'other_operating_revenue', direction: 'credit' })
        ]
      })
    );
    expect(commandRepository.createInflow).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        nature: 'operating_income',
        categoryOptionId: categoryId,
        amountCny: '100'
      })
    );
    expect(commandRepository.createAttachment).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        purpose: 'finance_inflow_receipt',
        contentEncrypted: 'encrypted',
        contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
      })
    );
    expect(commandRepository.createInflowIncomeReference).toHaveBeenCalledWith(
      tx,
      'bank-20260827-002',
      expect.any(String)
    );
  });

  it('股东投入增加现金但不计入经营收入', async () => {
    queryRepository.findInflowPrerequisites.mockResolvedValue({
      category: null,
      account: { id: accountId, name: '人民币账户', currency: 'CNY', status: 'active' }
    });

    await service.create(
      {
        nature: 'capital_contribution',
        financeAccountId: accountId,
        amount: '300',
        currency: 'CNY',
        occurredAt: '2026-08-27T08:00:00.000Z',
        payer: '股东甲',
        externalReference: 'BANK-20260827-003',
        idempotencyKey: 'inflow-capital-test'
      },
      operator,
      receiptUpload()
    );

    expect(postingService.post).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        journalType: 'capital_contribution',
        lines: [
          expect.objectContaining({ accountCode: 'cash', direction: 'debit' }),
          expect.objectContaining({ accountCode: 'contributed_capital', direction: 'credit' })
        ]
      })
    );
    expect(commandRepository.createInflow).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ nature: 'capital_contribution', categoryOptionId: null })
    );
  });

  it('更正资金流入时原子冲销原凭证并生成替代记录', async () => {
    commandRepository.findIncomeReference.mockResolvedValue({
      normalizedReference: 'bank-20260827-001',
      sourceType: 'inflow',
      firstInflowId: inflowId,
      orderId: null
    });

    await service.correct(
      inflowId,
      {
        nature: 'operating_income',
        categoryOptionId: categoryId,
        financeAccountId: accountId,
        amount: '120',
        currency: 'CNY',
        occurredAt: '2026-08-27T09:00:00.000Z',
        payer: '合作方',
        externalReference: 'BANK-20260827-001',
        receiptAttachmentId,
        reason: '原金额录入错误',
        idempotencyKey: 'inflow-correction-test'
      },
      operator
    );

    expect(postingService.reverse).toHaveBeenCalledWith(
      tx,
      journalId,
      '原金额录入错误',
      'finance_inflow_correction:inflow-correction-test:reversal',
      operator
    );
    expect(commandRepository.createInflow).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        amountOriginal: '120',
        receiptAttachmentId,
        idempotencyKey: 'finance_inflow_correction:inflow-correction-test:replacement'
      })
    );
    expect(commandRepository.createAttachment).not.toHaveBeenCalled();
    expect(commandRepository.createInflowIncomeReference).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'id_business_v2.finance_inflow.correct' })
    );
  });

  it('借入资金必须填写出借人', async () => {
    await expect(
      service.create({
        nature: 'borrowed_funds',
        financeAccountId: accountId,
        amount: '100',
        currency: 'CNY',
        occurredAt: '2026-08-27T08:00:00.000Z',
        externalReference: 'BANK-20260827-004',
        idempotencyKey: 'inflow-loan-test'
      })
    ).rejects.toThrow('出借人至少填写 2 个字符');
    expect(postingService.post).not.toHaveBeenCalled();
  });

  it('没有收款凭证时拒绝新增收入', async () => {
    await expect(
      service.create({
        nature: 'operating_income',
        categoryOptionId: categoryId,
        financeAccountId: accountId,
        amount: '100',
        currency: 'CNY',
        occurredAt: '2026-08-27T08:00:00.000Z',
        externalReference: 'BANK-20260827-005',
        idempotencyKey: 'inflow-no-receipt-test'
      })
    ).rejects.toThrow('请上传收款凭证');
    expect(postingService.post).not.toHaveBeenCalled();
  });

  it('经营收入流水号与订单冲突时拒绝重复入账', async () => {
    queryRepository.findOrderIncomeReferenceConflict.mockResolvedValue({
      id: '10000000-0000-4000-8000-000000000008',
      orderNo: 'ORDER-001',
      platformOrderNo: 'BANK-20260827-006'
    });

    await expect(
      service.create(
        {
          nature: 'operating_income',
          categoryOptionId: categoryId,
          financeAccountId: accountId,
          amount: '100',
          currency: 'CNY',
          occurredAt: '2026-08-27T08:00:00.000Z',
          externalReference: 'BANK-20260827-006',
          idempotencyKey: 'inflow-order-conflict-test'
        },
        operator,
        receiptUpload()
      )
    ).rejects.toThrow('不能再手工记为经营收入');
    expect(commandTransactions.execute).not.toHaveBeenCalled();
  });

  it('已被其他收入预留的流水号不能再次使用', async () => {
    commandRepository.findIncomeReference.mockResolvedValue({
      normalizedReference: 'bank-20260827-007',
      sourceType: 'inflow',
      firstInflowId: '10000000-0000-4000-8000-000000000009',
      orderId: null
    });

    await expect(
      service.create(
        {
          nature: 'capital_contribution',
          financeAccountId: accountId,
          amount: '100',
          currency: 'CNY',
          occurredAt: '2026-08-27T08:00:00.000Z',
          payer: '股东甲',
          externalReference: 'BANK-20260827-007',
          idempotencyKey: 'inflow-reference-conflict-test'
        },
        operator,
        receiptUpload()
      )
    ).rejects.toThrow('该收款流水号已被其他收入记录使用');
    expect(postingService.post).not.toHaveBeenCalled();
  });

  it('下载凭证时校验密文完整性并写查看审计', async () => {
    const content = Buffer.from('%PDF-1.7\nreceipt');
    encryption.decrypt.mockReturnValue(content.toString('base64'));
    queryRepository.findInflowReceipt.mockResolvedValue({
      id: inflowId,
      receiptAttachment: {
        id: receiptAttachmentId,
        originalName: '收款凭证.pdf',
        mimeType: 'application/pdf',
        sizeBytes: BigInt(content.length),
        contentSha256: createHash('sha256').update(content).digest('hex'),
        contentEncrypted: 'encrypted'
      }
    });

    await expect(service.downloadReceipt(inflowId, operator)).resolves.toEqual({
      content,
      originalName: '收款凭证.pdf',
      mimeType: 'application/pdf'
    });
    expect(auditLogs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'id_business_v2.finance_inflow.receipt_view',
        objectId: inflowId
      })
    );
  });
});
