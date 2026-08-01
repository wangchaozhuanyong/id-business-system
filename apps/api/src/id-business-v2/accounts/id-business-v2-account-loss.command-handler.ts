import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  Amount4,
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  type V2CommandTransaction
} from '../runtime/public-api';
import type { ReportIdBusinessV2AccountLossDto } from './dto/report-id-business-v2-account-loss.dto';
import {
  normalizeAccountLossIdempotencyKey,
  normalizeAccountLossReason,
  normalizeAccountLossUuid
} from './id-business-v2-account-loss-input';
import { IdBusinessV2AccountLossPostingCoordinator } from './id-business-v2-account-loss-posting.coordinator';
import {
  IdBusinessV2AccountLossRepository,
  type IdBusinessV2AccountLossRecord
} from './id-business-v2-account-loss.repository';
import { toAccountLossReportResult } from './id-business-v2-account-loss-response';

export interface IdBusinessV2AccountLossAuditContext {
  source: 'gift_card_redeemed';
  giftCardId: string;
  giftCardMasked: string;
  reversalLedgerEntryId: string;
}

interface PreparedAccountLossCommand {
  accountId: string;
  reason: string;
  requestIdempotencyKey: string;
  idempotencyKey: string;
  expected: {
    currentBalance: Amount4;
    balanceCostAmount: Amount4;
  };
}

@Injectable()
export class IdBusinessV2AccountLossCommandHandler {
  constructor(
    private readonly repository: IdBusinessV2AccountLossRepository,
    private readonly postingCoordinator: IdBusinessV2AccountLossPostingCoordinator,
    private readonly transactionManager: V2CommandTransactionManager,
    private readonly transactionalAudit: V2TransactionalAuditService
  ) {}

  reportLoss(
    accountIdValue: string,
    dto: ReportIdBusinessV2AccountLossDto,
    operator?: AuthenticatedUser,
    invocation?: { requestId?: string; businessTime?: Date }
  ) {
    const command = this.prepare(accountIdValue, dto);
    return this.transactionManager.execute(
      (tx, context) => this.execute(tx, command, context.businessTime, operator),
      {
        requestId: invocation?.requestId ?? randomUUID(),
        operator,
        businessTime: invocation?.businessTime ?? new Date(),
        retryMode: 'fullReplay',
        idempotencyKey: command.idempotencyKey,
        replay: (tx) => this.verifyCommittedReplay(tx, command),
        uniqueConflictMessage: '该 ID 已报损或本次请求已处理'
      }
    );
  }

  reportLossInTransaction(
    tx: V2CommandTransaction,
    accountIdValue: string,
    dto: ReportIdBusinessV2AccountLossDto,
    operator?: AuthenticatedUser,
    auditContext?: IdBusinessV2AccountLossAuditContext,
    outerContext?: { requestId?: string; businessTime?: Date }
  ) {
    const command = this.prepare(accountIdValue, dto);
    return this.execute(
      tx,
      command,
      outerContext?.businessTime ?? new Date(),
      operator,
      auditContext
    );
  }

  private prepare(
    accountIdValue: string,
    dto: ReportIdBusinessV2AccountLossDto
  ): PreparedAccountLossCommand {
    const accountId = normalizeAccountLossUuid(accountIdValue, 'ID');
    const reason = normalizeAccountLossReason(dto.reason);
    const requestIdempotencyKey = normalizeAccountLossIdempotencyKey(dto.idempotencyKey);
    return {
      accountId,
      reason,
      requestIdempotencyKey,
      idempotencyKey: `account_loss:${accountId}:${requestIdempotencyKey}`,
      expected: {
        currentBalance: normalizeExpectedAmount(dto.expectedCurrentBalance, '报损前余额'),
        balanceCostAmount: normalizeExpectedAmount(
          dto.expectedBalanceCostAmount,
          '报损前人民币总成本'
        )
      }
    };
  }

  private async execute(
    tx: V2CommandTransaction,
    command: PreparedAccountLossCommand,
    now: Date,
    operator?: AuthenticatedUser,
    auditContext?: IdBusinessV2AccountLossAuditContext
  ) {
    const replay = await this.repository.findByIdempotencyKey(tx, command.idempotencyKey);
    if (replay) return this.verifyReplay(replay, command);

    const account = await this.repository.lockAccount(tx, command.accountId);
    if (account.lossReportedAt) {
      const committedReplay = await this.repository.findByAccountId(tx, command.accountId);
      if (committedReplay?.idempotencyKey === command.idempotencyKey) {
        return this.verifyReplay(committedReplay, command);
      }
      throw new ConflictException('该 ID 已报损，不能重复操作');
    }
    if (
      !account.currentBalance.equals(command.expected.currentBalance) ||
      !account.balanceCostAmount.equals(command.expected.balanceCostAmount)
    ) {
      throw new ConflictException('ID 余额已发生变化，请刷新后重新确认报损');
    }

    if ((await this.repository.countActiveLocks(tx, command.accountId, now)) > 0) {
      throw new ConflictException('该 ID 有未释放的订单锁，请先处理关联订单再报损');
    }
    const frozenStatus = await this.repository.findFrozenStatus(tx);
    if (!frozenStatus) {
      throw new ConflictException('系统缺少固定的冻结状态，请先完成数据库迁移');
    }

    const posting = await this.postingCoordinator.post(tx, {
      accountId: command.accountId,
      account,
      reason: command.reason,
      idempotencyKey: command.idempotencyKey,
      now,
      operator
    });
    await this.repository.freezeAccount(tx, {
      accountId: command.accountId,
      frozenStatusId: frozenStatus.id,
      now,
      operatorId: operator?.id
    });
    await this.repository.markActivationsAbnormal(tx, {
      accountId: command.accountId,
      now,
      operatorId: operator?.id
    });
    await this.transactionalAudit.append(tx, {
      userId: operator?.id,
      module: 'id_business_v2_accounts',
      action: 'id_business_v2.account.report_loss',
      objectType: 'id_business_v2_account',
      objectId: command.accountId,
      beforeData: {
        currentBalance: account.currentBalance.toString(),
        balanceCostAmount: account.balanceCostAmount.toString(),
        lossReportedAt: null,
        saleState: account.soldByOrderId ? 'sold' : 'available'
      },
      afterData: {
        currentBalance: '0',
        balanceCostAmount: '0',
        lossReportedAt: now.toISOString(),
        lossRecordId: posting.lossRecord.id,
        ledgerEntryId: posting.ledgerEntry.id,
        idPurchaseCostLossAmount: posting.idPurchaseCostLossAmount.toString(),
        financeJournalId: posting.financeJournal.id,
        reason: command.reason,
        ...(auditContext
          ? {
              source: auditContext.source,
              sourceGiftCardId: auditContext.giftCardId,
              sourceGiftCardMasked: auditContext.giftCardMasked,
              sourceReversalLedgerEntryId: auditContext.reversalLedgerEntryId
            }
          : {})
      },
      remark: `V2 ID 永久报损：${account.appleIdMasked}`
    });

    return toAccountLossReportResult(posting.lossRecord, false);
  }

  private async verifyCommittedReplay(
    tx: V2CommandTransaction,
    command: PreparedAccountLossCommand
  ) {
    const replay = await this.repository.findByIdempotencyKey(tx, command.idempotencyKey);
    if (replay) return this.verifyReplay(replay, command);

    const accountLoss = await this.repository.findByAccountId(tx, command.accountId);
    if (accountLoss?.idempotencyKey === command.idempotencyKey) {
      return this.verifyReplay(accountLoss, command);
    }
    throw new ConflictException('该 ID 已报损或本次请求已处理');
  }

  private verifyReplay(replay: IdBusinessV2AccountLossRecord, command: PreparedAccountLossCommand) {
    if (
      replay.accountId !== command.accountId ||
      replay.reason !== command.reason ||
      !replay.lossBalance.equals(command.expected.currentBalance) ||
      !replay.lossCostAmount.equals(command.expected.balanceCostAmount)
    ) {
      throw new ConflictException('相同幂等键对应的报损内容不一致');
    }
    return toAccountLossReportResult(replay, true);
  }
}

function normalizeExpectedAmount(value: string | number, label: string) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+(\.\d{1,4})?$/.test(normalized)) {
    throw new BadRequestException(`${label}必须是最多 4 位小数的非负数字`);
  }
  const amount = Amount4.from(normalized);
  if (amount.gt('99999999999999.9999')) {
    throw new BadRequestException(`${label}数值过大`);
  }
  return amount;
}
