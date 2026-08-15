import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  Amount4,
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  type V2CommandTransaction
} from '../runtime/public-api';
import { IdBusinessV2FinancePostingService } from '../finance/public-api';
import type { ReportIdBusinessV2AccountLossDto } from './dto/report-id-business-v2-account-loss.dto';
import type { UnfreezeIdBusinessV2AccountLossDto } from './dto/unfreeze-id-business-v2-account-loss.dto';
import {
  normalizeAccountLossIdempotencyKey,
  normalizeAccountLossReason,
  normalizeAccountLossUuid
} from './id-business-v2-account-loss-input';
import { IdBusinessV2AccountLossPostingCoordinator } from './id-business-v2-account-loss-posting.coordinator';
import {
  IdBusinessV2AccountLossRepository,
  type IdBusinessV2AccountLossRecord
} from './persistence/id-business-v2-account-loss.repository';
import {
  toAccountLossReportResult,
  toAccountLossUnfreezeResult
} from './id-business-v2-account-loss-response';

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

interface PreparedAccountLossUnfreezeCommand {
  accountId: string;
  expectedLossId: string;
  reason: string;
  requestIdempotencyKey: string;
  idempotencyKey: string;
}

@Injectable()
export class IdBusinessV2AccountLossCommandHandler {
  constructor(
    private readonly repository: IdBusinessV2AccountLossRepository,
    private readonly postingCoordinator: IdBusinessV2AccountLossPostingCoordinator,
    private readonly financePostingService: IdBusinessV2FinancePostingService,
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

  unfreezeLoss(
    accountIdValue: string,
    dto: UnfreezeIdBusinessV2AccountLossDto,
    operator?: AuthenticatedUser,
    invocation?: { requestId?: string; businessTime?: Date }
  ) {
    const command = this.prepareUnfreeze(accountIdValue, dto);
    return this.transactionManager.execute(
      (tx, context) => this.executeUnfreeze(tx, command, context.businessTime, operator),
      {
        requestId: invocation?.requestId ?? randomUUID(),
        operator,
        businessTime: invocation?.businessTime ?? new Date(),
        retryMode: 'fullReplay',
        idempotencyKey: command.idempotencyKey,
        replay: (tx) => this.verifyUnfreezeCommittedReplay(tx, command),
        uniqueConflictMessage: '该 ID 报损冻结解除请求已处理'
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

  private prepareUnfreeze(
    accountIdValue: string,
    dto: UnfreezeIdBusinessV2AccountLossDto
  ): PreparedAccountLossUnfreezeCommand {
    const accountId = normalizeAccountLossUuid(accountIdValue, 'ID');
    const expectedLossId = normalizeAccountLossUuid(dto.expectedLossId, '当前报损记录');
    const reason = normalizeAccountLossReason(dto.reason);
    const requestIdempotencyKey = normalizeAccountLossIdempotencyKey(dto.idempotencyKey);
    return {
      accountId,
      expectedLossId,
      reason,
      requestIdempotencyKey,
      idempotencyKey: `account_loss_unfreeze:${accountId}:${expectedLossId}:${requestIdempotencyKey}`
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
      lossRecordId: posting.lossRecord.id,
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
        statusOptionId: account.statusOptionId,
        statusName: account.statusName,
        recordStatus: account.recordStatus,
        saleState: account.soldByOrderId ? 'sold' : 'available'
      },
      afterData: {
        currentBalance: account.currentBalance.toString(),
        balanceCostAmount: account.balanceCostAmount.toString(),
        lossReportedAt: now.toISOString(),
        activeLossRecordId: posting.lossRecord.id,
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
      remark: `V2 ID 报损冻结：${account.appleIdMasked}`
    });

    return toAccountLossReportResult(posting.lossRecord, false);
  }

  private async executeUnfreeze(
    tx: V2CommandTransaction,
    command: PreparedAccountLossUnfreezeCommand,
    now: Date,
    operator?: AuthenticatedUser
  ) {
    const replay = await this.repository.findUnfreezeReplay(tx, command.idempotencyKey);
    if (replay) return this.verifyUnfreezeReplay(replay, command);

    const account = await this.repository.lockAccount(tx, command.accountId);
    if (!account.lossReportedAt || !account.activeLossRecordId) {
      throw new ConflictException('该 ID 当前不是报损冻结状态');
    }
    if (account.activeLossRecordId !== command.expectedLossId) {
      throw new ConflictException('ID 报损状态已变化，请刷新后重新解除冻结');
    }

    const loss = await this.repository.findById(tx, command.expectedLossId);
    if (!loss || loss.accountId !== command.accountId) {
      throw new ConflictException('当前报损记录不存在，请刷新后重试');
    }
    if (loss.status !== 'active') {
      throw new ConflictException('当前报损记录已经冲回，不能重复解除冻结');
    }
    if (!loss.financeJournalId) {
      throw new ConflictException('当前报损记录缺少原始财务日记，不能自动冲回');
    }

    const fallbackNormalStatus = loss.previousStatusOptionId
      ? null
      : await this.repository.findNormalStatus(tx);
    if (!loss.previousStatusOptionId && !fallbackNormalStatus) {
      throw new ConflictException('系统缺少固定的正常状态，请先完成数据库迁移');
    }

    const reversalJournal = await this.financePostingService.reverse(
      tx,
      loss.financeJournalId,
      command.reason,
      command.idempotencyKey,
      operator
    );
    const reversedLoss = await this.repository.markLossReversed(tx, {
      lossRecordId: loss.id,
      reversalFinanceJournalId: reversalJournal.id,
      reason: command.reason,
      now,
      operatorId: operator?.id,
      operatorName: operator?.username
    });
    await this.repository.unfreezeAccount(tx, {
      accountId: command.accountId,
      statusOptionId: loss.previousStatusOptionId ?? fallbackNormalStatus!.id,
      recordStatus: loss.previousRecordStatus ?? 'active',
      operatorId: operator?.id
    });
    await this.transactionalAudit.append(tx, {
      userId: operator?.id,
      module: 'id_business_v2_accounts',
      action: 'id_business_v2.account.unfreeze_loss',
      objectType: 'id_business_v2_account',
      objectId: command.accountId,
      beforeData: {
        currentBalance: account.currentBalance.toString(),
        balanceCostAmount: account.balanceCostAmount.toString(),
        lossReportedAt: account.lossReportedAt.toISOString(),
        activeLossRecordId: loss.id,
        statusOptionId: account.statusOptionId,
        statusName: account.statusName,
        recordStatus: account.recordStatus
      },
      afterData: {
        currentBalance: account.currentBalance.toString(),
        balanceCostAmount: account.balanceCostAmount.toString(),
        lossReportedAt: null,
        activeLossRecordId: null,
        restoredStatusOptionId: loss.previousStatusOptionId ?? fallbackNormalStatus!.id,
        restoredStatusName: loss.previousStatusName,
        restoredRecordStatus: loss.previousRecordStatus ?? 'active',
        reversalFinanceJournalId: reversalJournal.id,
        reason: command.reason
      },
      remark: `V2 ID 解除报损冻结：${account.appleIdMasked}`
    });

    return toAccountLossUnfreezeResult(reversedLoss, false);
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

  private async verifyUnfreezeCommittedReplay(
    tx: V2CommandTransaction,
    command: PreparedAccountLossUnfreezeCommand
  ) {
    const replay = await this.repository.findUnfreezeReplay(tx, command.idempotencyKey);
    if (replay) return this.verifyUnfreezeReplay(replay, command);
    throw new ConflictException('该 ID 报损冻结解除请求已处理');
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

  private verifyUnfreezeReplay(
    replay: IdBusinessV2AccountLossRecord,
    command: PreparedAccountLossUnfreezeCommand
  ) {
    if (
      replay.id !== command.expectedLossId ||
      replay.accountId !== command.accountId ||
      replay.status !== 'reversed' ||
      replay.reversalReason !== command.reason
    ) {
      throw new ConflictException('相同幂等键对应的解除冻结内容不一致');
    }
    return toAccountLossUnfreezeResult(replay, true);
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
