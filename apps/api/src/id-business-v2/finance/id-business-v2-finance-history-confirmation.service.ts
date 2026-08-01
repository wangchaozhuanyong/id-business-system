import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { V2FinanceHistoryConfirmationPreview } from '@apple-business/shared';
import type { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { toV2DecimalString } from '../decimal-policy';
import type { ConfirmIdBusinessV2FinanceHistoryDto } from './dto/id-business-v2-finance.dto';
import { normalizeFinanceText } from './id-business-v2-finance-input';

type HistoryConfirmationClient = Pick<
  Prisma.TransactionClient,
  | 'idBusinessV2FinanceSettings'
  | 'idBusinessV2FinanceAccount'
  | 'idBusinessV2TopupSupplierAccount'
  | 'idBusinessV2FinanceExpense'
>;

type HistoryConfirmationSettings = {
  enabledAt: Date | null;
  historyStatus: V2FinanceHistoryConfirmationPreview['historyStatus'];
};

type HistoryConfirmationPreviewResult = Omit<
  V2FinanceHistoryConfirmationPreview,
  'generatedAt' | 'enabledAt'
> & {
  generatedAt: Date;
  enabledAt: Date;
};

@Injectable()
export class IdBusinessV2FinanceHistoryConfirmationService {
  constructor(private readonly prisma: PrismaService) {}

  async preview() {
    return this.buildPreview(this.prisma);
  }

  async confirm(dto: ConfirmIdBusinessV2FinanceHistoryDto, operator?: AuthenticatedUser) {
    if (
      dto.confirmed !== true ||
      dto.financeAccountsConfirmed !== true ||
      dto.supplierBalancesConfirmed !== true ||
      dto.historicalExpensesConfirmed !== true
    ) {
      throw new ConflictException('必须逐项确认自有资金、卡商余额和系统外历史开支');
    }
    const normalizedFingerprint = dto.previewFingerprint?.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(normalizedFingerprint)) {
      throw new ConflictException('请先加载历史确认预览');
    }
    const note = normalizeHistoryConfirmationText(dto.note, '历史确认说明');
    return this.prisma.$transaction(async (tx) => {
      const settings = await tx.idBusinessV2FinanceSettings.findUnique({ where: { id: 1 } });
      if (!settings?.enabledAt || settings.historyStatus === 'not_started') {
        throw new ConflictException('请先执行历史自动回填');
      }
      if (settings.historyStatus === 'in_progress') {
        throw new ConflictException('历史自动回填仍在进行中');
      }
      if (settings.historyStatus === 'completed') {
        throw new ConflictException('历史数据已经确认完成，如需修正请先重新开启核对');
      }
      const preview = await this.buildPreview(tx, settings);
      if (preview.fingerprint !== normalizedFingerprint) {
        throw new ConflictException('历史财务数据已发生变化，请重新核对后再确认');
      }
      const now = new Date();
      const updated = await tx.idBusinessV2FinanceSettings.update({
        where: { id: 1 },
        data: {
          historyStatus: 'completed',
          historyCompletedAt: now,
          historyNote: note,
          updatedByUserId: operator?.id
        }
      });
      await tx.auditLog.create({
        data: {
          userId: operator?.id,
          module: 'id_business_v2_finance',
          action: 'id_business_v2.finance.history_confirm',
          objectType: 'id_business_v2_finance_settings',
          objectId: null,
          beforeData: {
            settingsId: 1,
            historyStatus: settings.historyStatus,
            historyCompletedAt: settings.historyCompletedAt?.toISOString() ?? null,
            historyNote: settings.historyNote
          },
          afterData: {
            settingsId: 1,
            historyStatus: updated.historyStatus,
            historyCompletedAt: now.toISOString(),
            historyNote: note,
            confirmationChecklist: {
              financeAccountsConfirmed: true,
              supplierBalancesConfirmed: true,
              historicalExpensesConfirmed: true
            },
            confirmationSnapshot: serializePreview(preview)
          },
          remark: '财务历史数据完整性已人工确认'
        }
      });
      return financeSettingsResponse(updated);
    });
  }

  async reopen(reasonValue: string, operator?: AuthenticatedUser) {
    const reason = normalizeHistoryConfirmationText(reasonValue, '重新核对原因');
    return this.prisma.$transaction(async (tx) => {
      const settings = await tx.idBusinessV2FinanceSettings.findUnique({ where: { id: 1 } });
      if (!settings?.enabledAt || settings.historyStatus === 'not_started') {
        throw new ConflictException('请先执行历史自动回填');
      }
      if (settings.historyStatus !== 'completed') {
        throw new ConflictException('只有已确认的历史数据可以重新开启核对');
      }
      const historyNote = `历史确认已重新开启：${reason}`;
      const updated = await tx.idBusinessV2FinanceSettings.update({
        where: { id: 1 },
        data: {
          historyStatus: 'incomplete',
          historyCompletedAt: null,
          historyNote,
          updatedByUserId: operator?.id
        }
      });
      await tx.auditLog.create({
        data: {
          userId: operator?.id,
          module: 'id_business_v2_finance',
          action: 'id_business_v2.finance.history_reopen',
          objectType: 'id_business_v2_finance_settings',
          objectId: null,
          beforeData: {
            settingsId: 1,
            historyStatus: settings.historyStatus,
            historyCompletedAt: settings.historyCompletedAt?.toISOString() ?? null,
            historyNote: settings.historyNote
          },
          afterData: {
            settingsId: 1,
            historyStatus: updated.historyStatus,
            historyCompletedAt: null,
            historyNote,
            reason
          },
          remark: '财务历史完整性确认已重新开启核对'
        }
      });
      return financeSettingsResponse(updated);
    });
  }

  private async buildPreview(
    client: HistoryConfirmationClient,
    settingsValue?: HistoryConfirmationSettings
  ): Promise<HistoryConfirmationPreviewResult> {
    const generatedAt = new Date();
    const settings =
      settingsValue ??
      (await client.idBusinessV2FinanceSettings.findUnique({
        where: { id: 1 },
        select: { enabledAt: true, historyStatus: true }
      }));
    if (!settings?.enabledAt || settings.historyStatus === 'not_started') {
      throw new ConflictException('请先执行历史自动回填');
    }

    const financeAccountAggregate = await client.idBusinessV2FinanceAccount.aggregate({
      _count: { _all: true },
      _sum: { openingBalanceCny: true, currentBalanceCny: true }
    });
    const supplierWalletAggregate = await client.idBusinessV2TopupSupplierAccount.aggregate({
      _count: { _all: true },
      _sum: { openingBalanceCny: true, currentBalanceCny: true }
    });
    const historicalExpenseAggregate = await client.idBusinessV2FinanceExpense.aggregate({
      where: { occurredAt: { lte: settings.enabledAt } },
      _count: { _all: true },
      _sum: { amountCny: true }
    });

    const financeAccounts = {
      count: financeAccountAggregate._count._all,
      openingBalanceCny: toV2DecimalString(financeAccountAggregate._sum.openingBalanceCny ?? 0),
      currentBalanceCny: toV2DecimalString(financeAccountAggregate._sum.currentBalanceCny ?? 0)
    };
    const supplierWallets = {
      count: supplierWalletAggregate._count._all,
      openingBalanceCny: toV2DecimalString(supplierWalletAggregate._sum.openingBalanceCny ?? 0),
      currentBalanceCny: toV2DecimalString(supplierWalletAggregate._sum.currentBalanceCny ?? 0)
    };
    const historicalExpenses = {
      count: historicalExpenseAggregate._count._all,
      amountCny: toV2DecimalString(historicalExpenseAggregate._sum.amountCny ?? 0)
    };
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          enabledAt: settings.enabledAt.toISOString(),
          historyStatus: settings.historyStatus,
          financeAccounts,
          supplierWallets,
          historicalExpenses
        })
      )
      .digest('hex');

    return {
      generatedAt,
      enabledAt: settings.enabledAt,
      historyStatus: settings.historyStatus,
      canConfirm: settings.historyStatus === 'incomplete',
      fingerprint,
      financeAccounts,
      supplierWallets,
      historicalExpenses
    };
  }
}

function normalizeHistoryConfirmationText(value: unknown, label: string) {
  const normalized = normalizeFinanceText(value, label, 1000, true)!;
  if (normalized.length < 6 || !/\p{L}/u.test(normalized) || /^(.)\1+$/u.test(normalized)) {
    throw new BadRequestException(`${label}至少填写 6 个字符，并说明实际核对结论`);
  }
  return normalized;
}

function serializePreview(preview: HistoryConfirmationPreviewResult) {
  return {
    generatedAt: preview.generatedAt.toISOString(),
    enabledAt: preview.enabledAt.toISOString(),
    historyStatus: preview.historyStatus,
    fingerprint: preview.fingerprint,
    financeAccounts: preview.financeAccounts,
    supplierWallets: preview.supplierWallets,
    historicalExpenses: preview.historicalExpenses
  };
}

function financeSettingsResponse(settings: {
  timezone: string;
  enabledAt: Date | null;
  historyStatus: V2FinanceHistoryConfirmationPreview['historyStatus'];
  historyCompletedAt: Date | null;
  historyNote: string | null;
}) {
  return {
    baseCurrency: 'CNY' as const,
    timezone: settings.timezone,
    enabledAt: settings.enabledAt,
    historyStatus: settings.historyStatus,
    historyCompletedAt: settings.historyCompletedAt,
    historyNote: settings.historyNote
  };
}
