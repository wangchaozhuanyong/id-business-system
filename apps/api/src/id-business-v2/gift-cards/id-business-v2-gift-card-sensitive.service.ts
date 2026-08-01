import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import type { RevealIdBusinessV2GiftCardCodeDto } from '../topup-supplier-funds/public-api';
import { V2CommandTransactionManager } from '../runtime/public-api';
import { IdBusinessV2GiftCardsRepository } from './persistence/id-business-v2-gift-cards.repository';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class IdBusinessV2GiftCardSensitiveService {
  constructor(
    private readonly repository: IdBusinessV2GiftCardsRepository,
    private readonly fieldEncryptionService: FieldEncryptionService,
    private readonly transactionManager: V2CommandTransactionManager
  ) {}

  async revealCode(
    giftCardIdValue: string,
    dto: RevealIdBusinessV2GiftCardCodeDto,
    operator?: AuthenticatedUser,
    requestMeta?: { ip?: string; userAgent?: string }
  ) {
    const giftCardId = giftCardIdValue.trim();
    if (!UUID_PATTERN.test(giftCardId)) throw new BadRequestException('礼品卡格式无效');
    if (
      !operator ||
      (!operator.roles.includes('admin') &&
        !operator.permissions.includes('apple.gift_card.view_full'))
    ) {
      throw new ForbiddenException('无权查看完整礼品卡号');
    }
    const reason = typeof dto.reason === 'string' ? dto.reason.trim() : '';
    if (reason.length < 2 || reason.length > 200) {
      throw new BadRequestException('查看原因必须为 2 至 200 个字符');
    }
    const giftCard = await this.repository.findSensitiveGiftCard(giftCardId);
    if (!giftCard) throw new NotFoundException('礼品卡记录不存在');
    const code = this.fieldEncryptionService.decrypt(giftCard.codeEncrypted);
    if (!code) throw new NotFoundException('礼品卡号不可用');

    const approved = await this.repository.verifySensitiveApproval({
      approvalId: dto.approvalId ?? undefined,
      requesterId: operator.id,
      objectId: giftCard.id
    });
    await this.transactionManager.execute(
      async (tx) => {
        await tx.sensitiveAccessLog.create({
          data: {
            userId: operator.id,
            module: 'id_business_v2_gift_card',
            fieldName: 'code',
            objectType: 'id_business_v2_gift_card',
            objectId: giftCard.id,
            accessReason: reason,
            approved,
            ip: requestMeta?.ip,
            userAgent: requestMeta?.userAgent
          }
        });
        await this.repository.appendAudit(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.gift_card.code.reveal',
          objectType: 'id_business_v2_gift_card',
          objectId: giftCard.id,
          afterData: {
            reason,
            approved
          },
          ip: requestMeta?.ip,
          userAgent: requestMeta?.userAgent,
          remark: `查看完整礼品卡号：${giftCard.codeMasked}`
        });
      },
      {
        requestId: randomUUID(),
        operator,
        retryMode: 'none'
      }
    );
    return {
      giftCardId: giftCard.id,
      code,
      revealedAt: new Date().toISOString()
    };
  }
}
