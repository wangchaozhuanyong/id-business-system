import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  type V2CommandTransaction
} from '../runtime/public-api';
import { BankRechargeRepository } from './persistence/bank-recharge.repository';
import {
  bankRechargeCurrency,
  bankRechargeObject,
  bankRechargeText
} from './bank-recharge-validation';

// 兼容银充订单旧入口：只建立尾号标识，不替代银行卡管理页的完整卡号资料。
export async function createLegacyCard(
  value: unknown,
  operator: AuthenticatedUser,
  repository: BankRechargeRepository,
  transactions: V2CommandTransactionManager,
  audit: V2TransactionalAuditService,
  requireCurrency: (tx: V2CommandTransaction, code: string) => Promise<unknown>
) {
  const input = bankRechargeObject(value);
  const label = bankRechargeText(input.label, '银行卡名称', 80);
  const last4 = bankRechargeText(input.last4, '银行卡尾号', 4);
  if (!/^\d{4}$/.test(last4)) throw new BadRequestException('只允许保存银行卡后四位');
  if (input.fundingType !== undefined && input.fundingType !== 'prepaid') {
    throw new BadRequestException('银充只支持预存资金银行卡');
  }
  const currencyCode = bankRechargeCurrency(input.currencyCode);
  return transactions.execute(
    async (tx) => {
      await requireCurrency(tx, currencyCode);
      const item = await repository.createCard(tx, {
        data: { label, last4, currencyCode, createdByUserId: operator.id }
      });
      await audit.append(tx, {
        userId: operator.id,
        module: 'id_business_v2',
        action: 'id_business_v2.bank_recharge.card.create',
        objectType: 'bank_recharge_card',
        objectId: item.id,
        afterData: { label, last4, currencyCode },
        remark: '新增银充银行卡标识'
      });
      return item;
    },
    { changedScopes: ['auto-recharge'], requestId: randomUUID(), operator, retryMode: 'none' }
  );
}
