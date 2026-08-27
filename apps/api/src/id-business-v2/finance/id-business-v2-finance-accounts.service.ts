import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  Rate8,
  V2CommandTransactionManager,
  V2TransactionalAuditService
} from '../runtime/public-api';
import type {
  CreateIdBusinessV2FinanceAccountDto,
  UpdateIdBusinessV2FinanceAccountDto
} from './dto/id-business-v2-finance.dto';
import { IdBusinessV2FinanceFxService } from './id-business-v2-finance-fx.service';
import {
  normalizeFinanceCurrency,
  normalizeFinanceIdempotencyKey,
  normalizeFinanceMoney,
  normalizeFinanceRate,
  normalizeFinanceText
} from './id-business-v2-finance-input';
import { IdBusinessV2FinancePostingService } from './id-business-v2-finance-posting.service';
import { IdBusinessV2FinanceCommandRepository } from './persistence/id-business-v2-finance-command.repository';
import { IdBusinessV2FinanceQueryRepository } from './persistence/id-business-v2-finance-query.repository';

const ACCOUNT_TYPES = new Set(['bank', 'cash', 'ewallet', 'usdt_wallet']);

@Injectable()
export class IdBusinessV2FinanceAccountsService {
  constructor(
    private readonly commandTransactions: V2CommandTransactionManager,
    private readonly commandRepository: IdBusinessV2FinanceCommandRepository,
    private readonly queryRepository: IdBusinessV2FinanceQueryRepository,
    private readonly audit: V2TransactionalAuditService,
    private readonly fxService: IdBusinessV2FinanceFxService,
    private readonly postingService: IdBusinessV2FinancePostingService
  ) {}

  async list(currency?: string, status?: string) {
    const normalizedCurrency = currency ? normalizeFinanceCurrency(currency) : undefined;
    if (status && status !== 'active' && status !== 'disabled') {
      throw new BadRequestException('资金账户状态不正确');
    }
    const items = await this.queryRepository.listFinanceAccounts(
      normalizedCurrency,
      status as 'active' | 'disabled' | undefined
    );
    return { items };
  }

  async create(dto: CreateIdBusinessV2FinanceAccountDto, operator?: AuthenticatedUser) {
    const name = normalizeFinanceText(dto.name, '账户名称', 160, true)!;
    if (!ACCOUNT_TYPES.has(dto.accountType)) throw new BadRequestException('资金账户类型不正确');
    const currency = normalizeFinanceCurrency(dto.currency);
    if (dto.accountType === 'usdt_wallet' && currency !== 'USDT') {
      throw new BadRequestException('USDT 钱包的币种必须是 USDT');
    }
    const openingBalance = normalizeFinanceMoney(dto.openingBalance ?? 0, '期初余额', true);
    const manualRate =
      dto.fxRateToCny === undefined ? null : normalizeFinanceRate(dto.fxRateToCny, currency);
    const occurredAt = new Date();
    const rate = await this.fxService.resolve({
      currency,
      occurredAt,
      fxRateSnapshotId: dto.fxRateSnapshotId,
      manualRate,
      manualReason: dto.manualRateReason,
      operator
    });
    const rateToCny = Rate8.from(rate.rateToCny);
    const openingBalanceCny = rateToCny.apply(openingBalance);
    const idempotencyKey = normalizeFinanceIdempotencyKey(dto.idempotencyKey, 'finance_account');
    const remark = normalizeFinanceText(dto.remark, '备注', 2000);
    return this.commandTransactions.execute(async (tx) => {
      const replay = await this.commandRepository.findOpeningAccountReplay(
        tx,
        `${idempotencyKey}:opening`
      );
      if (replay) {
        const account = await this.commandRepository.findAccountForOpeningJournal(tx, replay.id);
        if (account) return account;
      }
      const account = await this.commandRepository.createFinanceAccount(tx, {
        id: randomUUID(),
        name,
        accountType: dto.accountType,
        currency,
        openingBalance: openingBalance.toString(),
        currentBalance: '0',
        openingBalanceCny: openingBalanceCny.toString(),
        currentBalanceCny: '0',
        remark,
        createdByUserId: operator?.id,
        updatedByUserId: operator?.id
      });
      await this.postingService.post(tx, {
        journalType: 'opening_balance',
        sourceType: 'opening_balance',
        sourceId: account.id,
        sourceReference: account.name,
        occurredAt,
        summary: `资金账户期初余额：${account.name}`,
        metadata: { excludedFromProfit: true },
        idempotencyKey: `${idempotencyKey}:opening`,
        operator,
        lines: [
          {
            accountCode: 'cash',
            direction: 'debit',
            currency,
            amountOriginal: openingBalance,
            fxRateToCny: rateToCny,
            amountCny: openingBalanceCny,
            financeAccountId: account.id,
            fxRateSnapshotId: rate.id
          },
          {
            accountCode: 'opening_equity',
            direction: 'credit',
            currency,
            amountOriginal: openingBalance,
            fxRateToCny: rateToCny,
            amountCny: openingBalanceCny,
            fxRateSnapshotId: rate.id
          }
        ]
      });
      await this.audit.append(tx, {
        userId: operator?.id,
        module: 'id_business_v2_finance',
        action: 'id_business_v2.finance_account.create',
        objectType: 'id_business_v2_finance_account',
        objectId: account.id,
        afterData: {
          name,
          accountType: dto.accountType,
          currency,
          openingBalance: openingBalance.toString()
        },
        remark: `创建资金账户：${name}`
      });
      return this.commandRepository.findFinanceAccountOrThrow(tx, account.id);
    }, this.commandOptions(operator));
  }

  async update(id: string, dto: UpdateIdBusinessV2FinanceAccountDto, operator?: AuthenticatedUser) {
    return this.commandTransactions.execute(async (tx) => {
      const existing = await this.commandRepository.findFinanceAccount(tx, id);
      if (!existing) throw new NotFoundException('资金账户不存在');
      const name =
        dto.name === undefined
          ? existing.name
          : normalizeFinanceText(dto.name, '账户名称', 160, true)!;
      const status = dto.status ?? existing.status;
      if (status !== 'active' && status !== 'disabled') {
        throw new BadRequestException('资金账户状态不正确');
      }
      const remark =
        dto.remark === undefined ? existing.remark : normalizeFinanceText(dto.remark, '备注', 2000);
      const updated = await this.commandRepository.updateFinanceAccount(tx, id, {
        name,
        status,
        remark,
        updatedByUserId: operator?.id
      });
      await this.audit.append(tx, {
        userId: operator?.id,
        module: 'id_business_v2_finance',
        action: 'id_business_v2.finance_account.update',
        objectType: 'id_business_v2_finance_account',
        objectId: id,
        beforeData: { name: existing.name, status: existing.status, remark: existing.remark },
        afterData: { name, status, remark },
        remark: `更新资金账户：${name}`
      });
      return updated;
    }, this.commandOptions(operator));
  }

  private commandOptions(operator?: AuthenticatedUser) {
    return { changedScopes: ['finance-accounts'], requestId: randomUUID(), operator } as const;
  }
}
