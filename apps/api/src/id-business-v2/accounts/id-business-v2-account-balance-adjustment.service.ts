import { ConflictException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { IdBusinessV2BalanceCalculatorService } from '../balances/public-api';
import { IdBusinessV2FinancePostingService } from '../finance/public-api';
import {
  Amount4,
  Rate8,
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  toV2JsonDocument,
  type V2CommandTransaction
} from '../runtime/public-api';
import type { UpdateIdBusinessV2AccountDto } from './dto/update-id-business-v2-account.dto';
import { assertAccountLossNotReported } from './id-business-v2-account-balance-guard';
import {
  assertBalanceAdjustmentPermission,
  assertBalanceAdjustmentReplay,
  normalizeBalanceAdjustmentIdempotencyKey,
  normalizeBalanceAdjustmentReason,
  requireBalanceSnapshotValue,
  toAccountResponse,
  type AccountUpdateData,
  type AccountWithRelations
} from './id-business-v2-account-support';
import { IdBusinessV2AccountsRepository } from './persistence/id-business-v2-accounts.repository';

@Injectable()
export class IdBusinessV2AccountBalanceAdjustmentService {
  constructor(
    private readonly balanceCalculator: IdBusinessV2BalanceCalculatorService,
    private readonly financePostingService: IdBusinessV2FinancePostingService,
    private readonly transactionManager: V2CommandTransactionManager,
    private readonly transactionalAudit: V2TransactionalAuditService,
    private readonly repository: IdBusinessV2AccountsRepository
  ) {}

  async update(
    accountId: string,
    dto: UpdateIdBusinessV2AccountDto,
    buildUpdateData: (
      tx: V2CommandTransaction,
      existingAccount: AccountWithRelations
    ) => Promise<AccountUpdateData>,
    operator?: AuthenticatedUser,
    requestId: string = randomUUID()
  ) {
    assertBalanceAdjustmentPermission(operator);
    const normalizedExpected = this.balanceCalculator.normalizeSnapshot(
      String(requireBalanceSnapshotValue(dto.expectedCurrentBalance, '修改前余额')),
      String(requireBalanceSnapshotValue(dto.expectedBalanceCostAmount, '修改前人民币成本'))
    );
    const normalizedTarget = this.balanceCalculator.normalizeSnapshot(
      dto.currentBalance ?? normalizedExpected.currentBalance.toString(),
      dto.balanceCostAmount ?? normalizedExpected.balanceCostAmount.toString()
    );
    const expected = {
      currentBalance: Amount4.from(normalizedExpected.currentBalance.toString()),
      balanceCostAmount: Amount4.from(normalizedExpected.balanceCostAmount.toString()),
      averageCost: Rate8.from(normalizedExpected.averageCost.toString())
    };
    const target = {
      currentBalance: Amount4.from(normalizedTarget.currentBalance.toString()),
      balanceCostAmount: Amount4.from(normalizedTarget.balanceCostAmount.toString()),
      averageCost: Rate8.from(normalizedTarget.averageCost.toString())
    };
    const reason = normalizeBalanceAdjustmentReason(dto.balanceAdjustmentReason);
    const idempotencyKey = normalizeBalanceAdjustmentIdempotencyKey(
      dto.balanceAdjustmentIdempotencyKey
    );
    const verifyReplay = async (tx: V2CommandTransaction) => {
      const existingEntry = await this.repository.findBalanceLedgerByIdempotencyKey(
        tx,
        idempotencyKey
      );
      if (!existingEntry) {
        throw new ConflictException('余额修正已被并发处理，请刷新后核对');
      }
      assertBalanceAdjustmentReplay(existingEntry, {
        accountId,
        expectedBalance: expected.currentBalance,
        expectedCost: expected.balanceCostAmount,
        targetBalance: target.currentBalance,
        targetCost: target.balanceCostAmount,
        reason
      });
      const replayedAccount = await this.repository.findByIdOrThrow(accountId, tx);
      assertAccountLossNotReported(replayedAccount.lossReportedAt, '已报损冻结 ID 不能调整余额');
      return replayedAccount;
    };

    return this.transactionManager.execute(
      async (tx) => {
        const existingEntry = await this.repository.findBalanceLedgerByIdempotencyKey(
          tx,
          idempotencyKey
        );
        if (existingEntry) return verifyReplay(tx);

        const locked = await this.lockAccountBalance(tx, accountId);
        assertAccountLossNotReported(locked.lossReportedAt, '已报损冻结 ID 不能调整余额');
        if (
          !locked.currentBalance.equals(expected.currentBalance) ||
          !locked.balanceCostAmount.equals(expected.balanceCostAmount)
        ) {
          throw new ConflictException('ID 余额或人民币成本已发生变化，请刷新后重新修改');
        }

        const existingAccount = await this.repository.findByIdOrThrow(accountId, tx);
        const updateData = await buildUpdateData(tx, existingAccount);

        const balanceDelta = target.currentBalance.sub(locked.currentBalance);
        const costDelta = target.balanceCostAmount.sub(locked.balanceCostAmount);
        const ledgerEntry = await this.repository.appendBalanceAdjustment(tx, {
          accountId,
          balanceDelta,
          costDelta,
          balanceBefore: locked.currentBalance,
          balanceAfter: target.currentBalance,
          costBefore: locked.balanceCostAmount,
          costAfter: target.balanceCostAmount,
          averageCostBefore: expected.averageCost,
          averageCostAfter: target.averageCost,
          idempotencyKey,
          reason,
          operatorId: operator?.id
        });
        if (!costDelta.equals(0)) {
          const amount = costDelta.abs();
          await this.financePostingService.post(tx, {
            journalType: 'manual_adjustment',
            sourceType: 'account',
            sourceId: accountId,
            sourceReference: ledgerEntry.id,
            occurredAt: new Date(),
            summary: `ID 余额成本手工调整：${reason}`,
            metadata: {
              balanceLedgerId: ledgerEntry.id,
              balanceDelta: balanceDelta.toString(),
              costDelta: costDelta.toString(),
              reason
            },
            idempotencyKey: `auto:account_balance_adjustment:${ledgerEntry.id}`,
            operator,
            lines: [
              {
                accountCode: locked.ownershipTransferredAt
                  ? 'customer_owned_balance_cost'
                  : 'gift_card_inventory',
                direction: costDelta.gt(0) ? 'debit' : 'credit',
                currency: 'CNY',
                amountOriginal: amount,
                fxRateToCny: 1,
                amountCny: amount,
                memo: locked.ownershipTransferredAt
                  ? '调整客户已购 ID 余额备查成本'
                  : '调整 ID 余额库存成本'
              },
              {
                accountCode: 'manual_adjustment',
                direction: costDelta.gt(0) ? 'credit' : 'debit',
                currency: 'CNY',
                amountOriginal: amount,
                fxRateToCny: 1,
                amountCny: amount,
                memo: '余额成本手工调整对方科目'
              }
            ]
          });
        }

        const account = await this.repository.updateActive(tx, accountId, {
          ...updateData,
          currentBalance: target.currentBalance.toString(),
          balanceCostAmount: target.balanceCostAmount.toString()
        });
        await this.transactionalAudit.append(tx, {
          userId: operator?.id,
          module: 'id_business_v2_accounts',
          action: 'id_business_v2.account.update',
          objectType: 'id_business_v2_account',
          objectId: account.id,
          beforeData: toV2JsonDocument(toAccountResponse(existingAccount)),
          afterData: toV2JsonDocument(toAccountResponse(account)),
          remark: `修改 V2 ID：${existingAccount.appleIdMasked}`
        });
        return account;
      },
      {
        requestId,
        operator,
        retryMode: 'fullReplay',
        idempotencyKey,
        replay: verifyReplay,
        uniqueConflictMessage: '余额修正已被并发处理，请刷新后核对'
      }
    );
  }

  private async lockAccountBalance(tx: V2CommandTransaction, accountId: string) {
    return this.repository.lockAccountBalance(tx, accountId);
  }
}
