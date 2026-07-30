import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma as PrismaNamespace } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { roundV2Decimal, toV2DecimalString } from '../decimal-policy';
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

const ACCOUNT_TYPES = new Set(['bank', 'cash', 'ewallet', 'usdt_wallet']);

@Injectable()
export class IdBusinessV2FinanceAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fxService: IdBusinessV2FinanceFxService,
    private readonly postingService: IdBusinessV2FinancePostingService
  ) {}

  async list(currency?: string, status?: string) {
    const normalizedCurrency = currency ? normalizeFinanceCurrency(currency) : undefined;
    if (status && status !== 'active' && status !== 'disabled') {
      throw new BadRequestException('资金账户状态不正确');
    }
    const items = await this.prisma.idBusinessV2FinanceAccount.findMany({
      where: { currency: normalizedCurrency, status: status as 'active' | 'disabled' | undefined },
      orderBy: [{ status: 'asc' }, { name: 'asc' }, { id: 'asc' }]
    });
    return { items: items.map((item) => this.toResponse(item)) };
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
    const openingBalanceCny = roundV2Decimal(openingBalance.mul(rate.rateToCny));
    const idempotencyKey = normalizeFinanceIdempotencyKey(dto.idempotencyKey, 'finance_account');
    const remark = normalizeFinanceText(dto.remark, '备注', 2000);
    return this.prisma.$transaction(async (tx) => {
      const replay = await tx.idBusinessV2FinanceJournal.findUnique({
        where: { idempotencyKey: `${idempotencyKey}:opening` }
      });
      if (replay) {
        const account = await tx.idBusinessV2FinanceAccount.findFirst({
          where: { journalLines: { some: { journalId: replay.id, accountCode: 'cash' } } }
        });
        if (account) return this.toResponse(account);
      }
      const account = await tx.idBusinessV2FinanceAccount.create({
        data: {
          id: randomUUID(),
          name,
          accountType: dto.accountType,
          currency,
          openingBalance,
          currentBalance: 0,
          openingBalanceCny,
          currentBalanceCny: 0,
          remark,
          createdByUserId: operator?.id,
          updatedByUserId: operator?.id
        }
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
            fxRateToCny: rate.rateToCny,
            amountCny: openingBalanceCny,
            financeAccountId: account.id,
            fxRateSnapshotId: rate.id
          },
          {
            accountCode: 'opening_equity',
            direction: 'credit',
            currency,
            amountOriginal: openingBalance,
            fxRateToCny: rate.rateToCny,
            amountCny: openingBalanceCny,
            fxRateSnapshotId: rate.id
          }
        ]
      });
      await tx.auditLog.create({
        data: {
          userId: operator?.id,
          module: 'id_business_v2_finance',
          action: 'id_business_v2.finance_account.create',
          objectType: 'id_business_v2_finance_account',
          objectId: account.id,
          afterData: {
            name,
            accountType: dto.accountType,
            currency,
            openingBalance: toV2DecimalString(openingBalance)
          },
          remark: `创建资金账户：${name}`
        }
      });
      return this.toResponse(
        await tx.idBusinessV2FinanceAccount.findUniqueOrThrow({ where: { id: account.id } })
      );
    });
  }

  async update(id: string, dto: UpdateIdBusinessV2FinanceAccountDto, operator?: AuthenticatedUser) {
    const existing = await this.prisma.idBusinessV2FinanceAccount.findUnique({ where: { id } });
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
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.idBusinessV2FinanceAccount.update({
        where: { id },
        data: { name, status, remark, updatedByUserId: operator?.id }
      });
      await tx.auditLog.create({
        data: {
          userId: operator?.id,
          module: 'id_business_v2_finance',
          action: 'id_business_v2.finance_account.update',
          objectType: 'id_business_v2_finance_account',
          objectId: id,
          beforeData: { name: existing.name, status: existing.status, remark: existing.remark },
          afterData: { name, status, remark },
          remark: `更新资金账户：${name}`
        }
      });
      return this.toResponse(updated);
    });
  }

  private toResponse(account: {
    id: string;
    name: string;
    accountType: string;
    currency: string;
    openingBalance: PrismaNamespace.Decimal;
    currentBalance: PrismaNamespace.Decimal;
    openingBalanceCny: PrismaNamespace.Decimal;
    currentBalanceCny: PrismaNamespace.Decimal;
    status: string;
    remark: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      ...account,
      openingBalance: toV2DecimalString(account.openingBalance),
      currentBalance: toV2DecimalString(account.currentBalance),
      openingBalanceCny: toV2DecimalString(account.openingBalanceCny),
      currentBalanceCny: toV2DecimalString(account.currentBalanceCny)
    };
  }
}
