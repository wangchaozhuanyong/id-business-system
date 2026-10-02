import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  assertV2ExpectedUpdatedAt,
  normalizeV2ExpectedUpdatedAt,
  type V2CommandTransaction
} from '../runtime/public-api';
import { bankRechargeId, bankRechargeObject } from './bank-recharge-validation';
import { RechargeCardRemovalRepository } from './persistence/recharge-card-removal.repository';
import { RechargeNameService } from './recharge-name.service';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import {
  encryptedBankRechargeCardSummary,
  bankRechargeCardNumberSummary
} from './bank-recharge-card-summary';

@Injectable()
export class RechargeCardRemovalService {
  constructor(
    private readonly repository: RechargeCardRemovalRepository,
    private readonly transactions: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService,
    private readonly names: RechargeNameService,
    private readonly encryption: FieldEncryptionService
  ) {}
  private async context(tx: V2CommandTransaction, accountId: string) {
    if (!(await this.repository.account(tx, accountId)))
      throw new NotFoundException('ChatGPT 账号不存在');
    const order = await this.repository.openingOrder(tx, accountId);
    if (!order?.card) throw new ConflictException('该账号暂无可删除的开通银行卡');
    const [accounts, orderCount] = await Promise.all([
      this.repository.accounts(tx, order.card.id),
      this.repository.orders(tx, order.card.id)
    ]);
    return { card: order.card, orderId: order.id, linkedAccountCount: accounts.length, orderCount };
  }
  async preview(accountId: string, operator: AuthenticatedUser) {
    bankRechargeId(accountId, 'ChatGPT 账号');
    return this.transactions.execute(
      async (tx) => {
        const { card, orderId, linkedAccountCount, orderCount } = await this.context(tx, accountId);
        return {
          cardId: card.id,
          label: card.label,
          last4: card.last4,
          numberSummary: bankRechargeCardNumberSummary(
            this.encryption.decrypt(card.numberEncrypted)
          ),
          orderId,
          expectedUpdatedAt: card.updatedAt.toISOString(),
          linkedAccountCount,
          orderCount
        };
      },
      { changedScopes: [], requestId: randomUUID(), operator, retryMode: 'none' }
    );
  }
  async remove(accountId: string, value: unknown, operator: AuthenticatedUser) {
    bankRechargeId(accountId, 'ChatGPT 账号');
    const input = bankRechargeObject(value);
    if (
      Object.keys(input).some(
        (key) =>
          !['cardId', 'orderId', 'expectedUpdatedAt', 'linkedAccountCount', 'orderCount'].includes(
            key
          )
      )
    )
      throw new BadRequestException('删除银行卡确认资料无效');
    const expected = normalizeV2ExpectedUpdatedAt(input.expectedUpdatedAt, '银行卡');
    return this.transactions.execute(
      async (tx) => {
        await this.repository.lock(tx);
        const { card, orderId, linkedAccountCount, orderCount } = await this.context(tx, accountId);
        if (
          card.id !== input.cardId ||
          orderId !== input.orderId ||
          linkedAccountCount !== input.linkedAccountCount ||
          orderCount !== input.orderCount
        )
          throw new ConflictException('银行卡关联记录已变化，请重新确认删除');
        assertV2ExpectedUpdatedAt(card.updatedAt, expected, '银行卡');
        if (await this.repository.activeJob(tx, card.id))
          throw new ConflictException('这张银行卡还有未结束的充值任务，暂不能删除');
        if (card.numberHash && card.billingNameEncrypted)
          await this.names.confirm(tx, card.numberHash, card.billingNameEncrypted);
        await this.repository.remove(
          tx,
          card,
          encryptedBankRechargeCardSummary(this.encryption, card.numberEncrypted)
        );
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.bank_recharge.card.delete_from_account',
          objectType: 'bank_recharge_card',
          objectId: card.id,
          beforeData: { accountId, last4: card.last4, linkedAccountCount, orderCount },
          afterData: { historyPreserved: true },
          remark: '删除开通银行卡资料，保留账号和付款历史快照'
        });
        return { deleted: true };
      },
      { changedScopes: ['auto-recharge'], requestId: randomUUID(), operator, retryMode: 'none' }
    );
  }
}
