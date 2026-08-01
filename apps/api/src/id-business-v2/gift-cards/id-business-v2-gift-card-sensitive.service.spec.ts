import { ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { V2CommandTransactionManager } from '../runtime/public-api';
import { IdBusinessV2GiftCardSensitiveService } from './id-business-v2-gift-card-sensitive.service';
import { IdBusinessV2GiftCardsRepository } from './persistence/id-business-v2-gift-cards.repository';

const giftCardId = '11111111-1111-4111-8111-111111111111';
const operator = {
  id: '22222222-2222-4222-8222-222222222222',
  username: 'auditor',
  displayName: '审核员',
  roles: ['auditor'],
  permissions: ['apple.gift_card.view_full']
};

describe('IdBusinessV2GiftCardSensitiveService', () => {
  const prisma = {
    idBusinessV2GiftCard: {
      findUnique: vi.fn()
    },
    sensitiveAccessLog: {
      create: vi.fn()
    },
    auditLog: {
      create: vi.fn()
    },
    $transaction: vi.fn()
  };
  const encryption = {
    decrypt: vi.fn()
  };
  const service = new IdBusinessV2GiftCardSensitiveService(
    new IdBusinessV2GiftCardsRepository(prisma as never),
    encryption as never,
    new V2CommandTransactionManager(prisma as never)
  );

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.idBusinessV2GiftCard.findUnique.mockResolvedValue({
      id: giftCardId,
      codeEncrypted: 'v1:encrypted',
      codeMasked: 'ABCD****WXYZ'
    });
    encryption.decrypt.mockReturnValue('ABCD-EFGH-IJKL-WXYZ');
    prisma.sensitiveAccessLog.create.mockReturnValue(Promise.resolve({ id: 'access-1' }));
    prisma.auditLog.create.mockReturnValue(Promise.resolve({ id: 'audit-1' }));
    prisma.$transaction.mockImplementation(async (callback) => callback(prisma));
  });

  it('temporarily decrypts the code and records both sensitive access and audit evidence', async () => {
    const result = await service.revealCode(
      giftCardId,
      { reason: '核对供应商原始卡号' },
      operator,
      { ip: '127.0.0.1', userAgent: 'vitest' }
    );

    expect(result).toMatchObject({
      giftCardId,
      code: 'ABCD-EFGH-IJKL-WXYZ'
    });
    expect(prisma.sensitiveAccessLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: operator.id,
        objectId: giftCardId,
        accessReason: '核对供应商原始卡号',
        approved: false
      })
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'id_business_v2.gift_card.code.reveal',
        objectId: giftCardId,
        afterData: {
          reason: '核对供应商原始卡号',
          approved: false
        }
      })
    });
  });

  it('rejects callers without the full-card permission before reading ciphertext', async () => {
    await expect(
      service.revealCode(giftCardId, { reason: '尝试查看' }, { ...operator, permissions: [] })
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.idBusinessV2GiftCard.findUnique).not.toHaveBeenCalled();
  });
});
