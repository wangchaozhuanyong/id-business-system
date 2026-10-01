import { BadRequestException, Injectable } from '@nestjs/common';
import type { IdBusinessV2BankRechargeOrder } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { FinancePostingLineInput } from '../finance/public-api';
import {
  Amount4,
  Rate8,
  V2TransactionalAuditService,
  toIdBusinessV2BusinessDate,
  type V2CommandTransaction
} from '../runtime/public-api';
import {
  normalizeFinanceCurrency,
  normalizeFinanceMoney,
  normalizeFinanceRate
} from '../finance/public-api';
import {
  BankRechargeRepository,
  type BankRechargeOrderFeeUpdate
} from './persistence/bank-recharge.repository';
import { bankRechargeOptionalId, bankRechargeText } from './bank-recharge-validation';

export const BANK_RECHARGE_FEE_PREFIXES = ['usdtFee', 'shoppingFee'] as const;
const labels = { usdtFee: 'USDT 手续费', shoppingFee: '购物网手续费' };
@Injectable()
export class BankRechargeFeesService {
  constructor(
    private readonly repository: BankRechargeRepository,
    private readonly audit: V2TransactionalAuditService
  ) {}
  async prepare(
    tx: V2CommandTransaction,
    previous: IdBusinessV2BankRechargeOrder,
    input: Record<string, unknown>,
    operator: AuthenticatedUser
  ) {
    const data: BankRechargeOrderFeeUpdate = {};
    for (const prefix of BANK_RECHARGE_FEE_PREFIXES) {
      const label = labels[prefix];
      const keyAmount = `${prefix}Amount` as const,
        keyCurrency = `${prefix}CurrencyCode` as const,
        keyAccount = `${prefix}FinanceAccountId` as const,
        keyRate = `${prefix}FxRateToCny` as const,
        keySnapshot = `${prefix}FxSnapshotId` as const,
        keyCny = `${prefix}AmountCny` as const;
      const raw = input[keyAmount] === undefined ? previous[keyAmount] : input[keyAmount];
      if (raw === null || raw === undefined || raw === '') {
        data[keyAmount] = null;
        data[keyCny] = null;
        data[keyRate] = null;
        data[keySnapshot] = null;
        data[keyAccount] = null;
        data[keyCurrency] = normalizeFinanceCurrency(
          input[keyCurrency] ?? previous[keyCurrency] ?? (prefix === 'usdtFee' ? 'USDT' : 'CNY')
        );
        continue;
      }
      const amount = normalizeFinanceMoney(raw, label, true);
      const currency = normalizeFinanceCurrency(
        input[keyCurrency] ?? previous[keyCurrency] ?? (prefix === 'usdtFee' ? 'USDT' : 'CNY')
      );
      const accountId = bankRechargeOptionalId(
        input[keyAccount] === undefined ? previous[keyAccount] : input[keyAccount],
        `${label}付款账户`
      );
      data[keyAmount] = amount.toString();
      data[keyCurrency] = currency;
      data[keyAccount] = accountId;
      if (amount.isZero()) {
        data[keyRate] = '1';
        data[keySnapshot] = null;
        data[keyCny] = '0';
        continue;
      }
      const account = accountId ? await this.repository.findFinanceAccount(tx, accountId) : null;
      if (!account || account.status !== 'active' || account.currency !== currency)
        throw new BadRequestException(`${label}请选择同币种的有效付款账户`);
      if (currency === 'CNY') {
        data[keyRate] = '1';
        data[keySnapshot] = null;
        data[keyCny] = amount.toString();
        continue;
      }
      const suppliedRate = input[keyRate];
      const normalizedRate =
        suppliedRate !== undefined && suppliedRate !== null && suppliedRate !== ''
          ? normalizeFinanceRate(suppliedRate, currency)
          : null;
      const previousSnapshot = previous[keySnapshot]
        ? await this.repository.financeFxSnapshot(tx, currency, previous[keySnapshot]!)
        : null;
      let snapshot =
        previousSnapshot &&
        previousSnapshot.currency === currency &&
        (suppliedRate === undefined ||
          suppliedRate === '' ||
          normalizedRate?.equals(previousSnapshot.rateToCny))
          ? previousSnapshot
          : null;
      if (!snapshot && suppliedRate !== undefined && suppliedRate !== null && suppliedRate !== '') {
        const rate = normalizedRate!;
        const reason = bankRechargeText(
          input[`${prefix}ManualRateReason`],
          `${label}人工汇率原因`,
          500
        );
        snapshot = await this.repository.createFinanceFxSnapshot(tx, {
          id: randomUUID(),
          currency,
          rateToCny: rate.toString(),
          source: 'manual',
          manualReason: reason,
          businessDate: toIdBusinessV2BusinessDate(new Date()).date,
          capturedAt: new Date(),
          createdByUserId: operator.id
        });
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2_finance',
          action: 'id_business_v2.finance.fx_rate.manual',
          objectType: 'id_business_v2_finance_fx_rate_snapshot',
          objectId: snapshot.id,
          afterData: { currency, rateToCny: rate.toString(), reason },
          remark: '订阅手续费人工汇率'
        });
      }
      if (!snapshot) {
        snapshot = await this.repository.financeFxSnapshot(tx, currency);
        if (!snapshot || (snapshot.expiresAt && snapshot.expiresAt.getTime() <= Date.now()))
          throw new BadRequestException(`${label}缺少有效汇率，请填写人工汇率及原因`);
      }
      const rate = Rate8.from(snapshot.rateToCny);
      if (!rate.gt('0')) throw new BadRequestException(`${label}汇率不正确`);
      data[keyRate] = rate.toString();
      data[keySnapshot] = snapshot.id;
      data[keyCny] = rate.apply(amount).toString();
    }
    return data;
  }
  async postingLines(tx: V2CommandTransaction, order: IdBusinessV2BankRechargeOrder) {
    const lines: FinancePostingLineInput[] = [];
    let total = Amount4.zero();
    for (const prefix of BANK_RECHARGE_FEE_PREFIXES) {
      const amountValue = order[`${prefix}Amount`],
        currency = order[`${prefix}CurrencyCode`];
      if (amountValue === null || amountValue === undefined)
        throw new BadRequestException(`请核对${labels[prefix]}，没有费用请填写 0`);
      const amount = Amount4.from(amountValue);
      if (amount.isZero()) continue;
      const accountId = order[`${prefix}FinanceAccountId`],
        rateValue = order[`${prefix}FxRateToCny`],
        cnyValue = order[`${prefix}AmountCny`];
      const account = accountId ? await this.repository.findFinanceAccount(tx, accountId) : null;
      if (
        !currency ||
        !account ||
        account.status !== 'active' ||
        account.currency !== currency ||
        !rateValue ||
        cnyValue === null
      )
        throw new BadRequestException(`${labels[prefix]}付款账户或汇率不完整`);
      const rate = Rate8.from(rateValue),
        cny = Amount4.from(cnyValue);
      if (!rate.gt('0') || !rate.apply(amount).equals(cny))
        throw new BadRequestException(`${labels[prefix]}金额和汇率快照不一致`);
      total = total.add(cny);
      lines.push(
        {
          accountCode:
            prefix === 'usdtFee' ? 'bank_recharge_usdt_fee' : 'bank_recharge_shopping_fee',
          direction: 'debit',
          currency,
          amountOriginal: amount,
          fxRateToCny: rate,
          amountCny: cny,
          financeAccountId: account.id,
          fxRateSnapshotId: order[`${prefix}FxSnapshotId`]
        },
        {
          accountCode: 'cash',
          direction: 'credit',
          currency,
          amountOriginal: amount,
          fxRateToCny: rate,
          amountCny: cny,
          financeAccountId: account.id,
          fxRateSnapshotId: order[`${prefix}FxSnapshotId`],
          memo: labels[prefix]
        }
      );
    }
    return { lines, total };
  }
}
