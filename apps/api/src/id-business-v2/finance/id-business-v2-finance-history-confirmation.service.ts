import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { V2FinanceHistoryConfirmationPreview } from '@apple-business/shared';
import { createHash, randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import type { ConfirmIdBusinessV2FinanceHistoryDto } from './dto/id-business-v2-finance.dto';
import { normalizeFinanceText } from './id-business-v2-finance-input';
import { IdBusinessV2FinanceHistoryConfirmationRepository } from './persistence/id-business-v2-finance-history-confirmation.repository';

type HistoryConfirmationPreviewResult = Omit<
  V2FinanceHistoryConfirmationPreview,
  'generatedAt' | 'enabledAt'
> & {
  generatedAt: Date;
  enabledAt: Date;
};

@Injectable()
export class IdBusinessV2FinanceHistoryConfirmationService {
  constructor(
    private readonly commandTransactions: V2CommandTransactionManager,
    private readonly repository: IdBusinessV2FinanceHistoryConfirmationRepository,
    private readonly audit: V2TransactionalAuditService
  ) {}

  async preview() {
    return this.buildPreview(await this.repository.loadPreviewData());
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
    return this.commandTransactions.execute(
      async (tx) => {
        const settings = await this.repository.findSettings(tx);
        if (!settings?.enabledAt || settings.historyStatus === 'not_started') {
          throw new ConflictException('请先执行历史自动回填');
        }
        if (settings.historyStatus === 'in_progress') {
          throw new ConflictException('历史自动回填仍在进行中');
        }
        if (settings.historyStatus === 'completed') {
          throw new ConflictException('历史数据已经确认完成，如需修正请先重新开启核对');
        }
        const preview = this.buildPreview(
          await this.repository.loadPreviewDataInTransaction(tx, settings)
        );
        if (preview.fingerprint !== normalizedFingerprint) {
          throw new ConflictException('历史财务数据已发生变化，请重新核对后再确认');
        }
        const now = new Date();
        const updated = await this.repository.confirm(tx, now, note, operator?.id);
        await this.audit.append(tx, {
          userId: operator?.id,
          module: 'id_business_v2_finance',
          action: 'id_business_v2.finance.history_confirm',
          objectType: 'id_business_v2_finance_settings',
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
        });
        return financeSettingsResponse(updated);
      },
      { requestId: randomUUID(), operator }
    );
  }

  async reopen(reasonValue: string, operator?: AuthenticatedUser) {
    const reason = normalizeHistoryConfirmationText(reasonValue, '重新核对原因');
    return this.commandTransactions.execute(
      async (tx) => {
        const settings = await this.repository.findSettings(tx);
        if (!settings?.enabledAt || settings.historyStatus === 'not_started') {
          throw new ConflictException('请先执行历史自动回填');
        }
        if (settings.historyStatus !== 'completed') {
          throw new ConflictException('只有已确认的历史数据可以重新开启核对');
        }
        const historyNote = `历史确认已重新开启：${reason}`;
        const updated = await this.repository.reopen(tx, historyNote, operator?.id);
        await this.audit.append(tx, {
          userId: operator?.id,
          module: 'id_business_v2_finance',
          action: 'id_business_v2.finance.history_reopen',
          objectType: 'id_business_v2_finance_settings',
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
        });
        return financeSettingsResponse(updated);
      },
      { requestId: randomUUID(), operator }
    );
  }

  private buildPreview(
    data: Awaited<ReturnType<IdBusinessV2FinanceHistoryConfirmationRepository['loadPreviewData']>>
  ): HistoryConfirmationPreviewResult {
    const generatedAt = new Date();
    const { settings, aggregates } = data;
    if (!settings?.enabledAt || settings.historyStatus === 'not_started') {
      throw new ConflictException('请先执行历史自动回填');
    }
    if (!aggregates) throw new ConflictException('历史确认预览数据不完整');
    const { financeAccounts, supplierWallets, historicalExpenses } = aggregates;
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
