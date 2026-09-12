import { randomUUID } from 'node:crypto';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import { IdBusinessV2BalanceCalculatorService } from '../balances/public-api';
import { IdBusinessV2FinancePostingService } from './id-business-v2-finance-posting.service';
import { IdBusinessV2FinanceJournalsService } from './id-business-v2-finance-journals.service';
import { IdBusinessV2FinanceCommandRepository } from './persistence/id-business-v2-finance-command.repository';
import { IdBusinessV2FinanceQueryRepository } from './persistence/id-business-v2-finance-query.repository';
import { IdBusinessV2OrdersRepository } from '../orders/persistence/id-business-v2-orders.repository';
import { IdBusinessV2OrderLockService } from '../orders/id-business-v2-order-lock.service';
import { IdBusinessV2OrderLifecycleService } from '../orders/id-business-v2-order-lifecycle.service';
import { IdBusinessV2GiftCardsRepository } from '../gift-cards/persistence/id-business-v2-gift-cards.repository';
import { IdBusinessV2GiftCardReversalService } from '../gift-cards/id-business-v2-gift-card-reversal.service';
import { IdBusinessV2TopupSupplierAccountRepository } from '../topup-supplier-funds/persistence/id-business-v2-topup-supplier-account.repository';
import { IdBusinessV2TopupSupplierCommandRepository } from '../topup-supplier-funds/persistence/id-business-v2-topup-supplier-command.repository';
import { IdBusinessV2TopupSupplierGiftCardFundsService } from '../topup-supplier-funds/id-business-v2-topup-supplier-gift-card-funds.service';
import { IdBusinessV2AccountLossRepository } from '../accounts/persistence/id-business-v2-account-loss.repository';
import { IdBusinessV2AccountLossPostingCoordinator } from '../accounts/id-business-v2-account-loss-posting.coordinator';
import { IdBusinessV2AccountLossCommandHandler } from '../accounts/id-business-v2-account-loss.command-handler';
import { IdBusinessV2DataGovernanceRepository } from '../data-governance/persistence/id-business-v2-data-governance.repository';
import { IdBusinessV2DataGovernanceQueryRepository } from '../data-governance/persistence/id-business-v2-data-governance-query.repository';
import { IdBusinessV2DataGovernanceQueryService } from '../data-governance/id-business-v2-data-governance-query.service';
import { IdBusinessV2DataGovernanceItemExecutorService } from '../data-governance/id-business-v2-data-governance-item-executor.service';
import { IdBusinessV2DataGovernancePreviewService } from '../data-governance/id-business-v2-data-governance-preview.service';
import { IdBusinessV2DataGovernanceApprovalService } from '../data-governance/id-business-v2-data-governance-approval.service';
import { IdBusinessV2DataGovernanceExecutionService } from '../data-governance/id-business-v2-data-governance-execution.service';

const databaseUrl = process.env.V2_FINANCIAL_INTEGRITY_DATABASE_URL;
const describeMysql = databaseUrl?.includes('/id_business_v2_rollback_integrity_')
  ? describe
  : describe.skip;
const key = () => `rollback-test:${randomUUID()}`;
const operator = (name: string): AuthenticatedUser => ({
  id: randomUUID(),
  username: name,
  displayName: name,
  roles: ['admin'],
  permissions: []
});
const requester = operator('rollback-requester');
const approver = operator('rollback-approver');

describeMysql('rollback/delete/restore real MySQL integrity', () => {
  let prisma: PrismaService;
  let transactions: V2CommandTransactionManager;
  let posting: IdBusinessV2FinancePostingService;
  let journals: IdBusinessV2FinanceJournalsService;
  let orders: IdBusinessV2OrderLifecycleService;
  let orderRepository: IdBusinessV2OrdersRepository;
  let giftRepository: IdBusinessV2GiftCardsRepository;
  let gifts: IdBusinessV2GiftCardReversalService;
  let funds: IdBusinessV2TopupSupplierGiftCardFundsService;
  let losses: IdBusinessV2AccountLossCommandHandler;
  let preview: IdBusinessV2DataGovernancePreviewService;
  let approvals: IdBusinessV2DataGovernanceApprovalService;
  let execution: IdBusinessV2DataGovernanceExecutionService;
  let normalStatusId: string;

  beforeAll(async () => {
    const target = new URL(databaseUrl!);
    expect(target.hostname).toBe('127.0.0.1');
    expect(target.pathname).toMatch(/^\/id_business_v2_rollback_integrity_\d+$/);
    prisma = new PrismaService({ datasourceUrl: databaseUrl });
    await prisma.$connect();
    transactions = new V2CommandTransactionManager(prisma);
    const audit = new V2TransactionalAuditService();
    const calculator = new IdBusinessV2BalanceCalculatorService();
    posting = new IdBusinessV2FinancePostingService(new IdBusinessV2FinanceCommandRepository());
    journals = new IdBusinessV2FinanceJournalsService(
      transactions,
      new IdBusinessV2FinanceQueryRepository(prisma),
      audit,
      posting
    );
    orderRepository = new IdBusinessV2OrdersRepository(prisma);
    // Only the post-command response reader is replaced; all business writes, locks and audits use MySQL.
    orders = new IdBusinessV2OrderLifecycleService(
      undefined as never,
      calculator,
      new IdBusinessV2OrderLockService(orderRepository, transactions),
      {
        get: (id: string) => prisma.idBusinessV2Order.findUniqueOrThrow({ where: { id } })
      } as never,
      posting,
      transactions,
      orderRepository
    );
    giftRepository = new IdBusinessV2GiftCardsRepository(prisma);
    funds = new IdBusinessV2TopupSupplierGiftCardFundsService(
      new IdBusinessV2TopupSupplierCommandRepository(
        new IdBusinessV2TopupSupplierAccountRepository()
      ),
      audit
    );
    gifts = new IdBusinessV2GiftCardReversalService(
      calculator,
      undefined as never,
      funds,
      posting,
      giftRepository,
      transactions,
      undefined as never,
      undefined as never
    );
    const lossRepository = new IdBusinessV2AccountLossRepository(prisma);
    losses = new IdBusinessV2AccountLossCommandHandler(
      lossRepository,
      new IdBusinessV2AccountLossPostingCoordinator(lossRepository, calculator, posting),
      posting,
      transactions,
      audit
    );
    const governance = new IdBusinessV2DataGovernanceRepository(prisma);
    const queryRepository = new IdBusinessV2DataGovernanceQueryRepository(prisma);
    const queryService = new IdBusinessV2DataGovernanceQueryService(queryRepository);
    preview = new IdBusinessV2DataGovernancePreviewService(
      governance,
      queryRepository,
      transactions,
      audit,
      queryService
    );
    approvals = new IdBusinessV2DataGovernanceApprovalService(
      governance,
      transactions,
      audit,
      queryService
    );
    execution = new IdBusinessV2DataGovernanceExecutionService(
      governance,
      transactions,
      audit,
      new IdBusinessV2DataGovernanceItemExecutorService(governance, transactions, audit),
      queryService
    );
    const role = await prisma.role.create({ data: { name: '隔离回滚验收管理员', code: 'admin' } });
    for (const user of [requester, approver]) {
      await prisma.user.create({
        data: {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          passwordHash: 'synthetic-not-a-login-secret'
        }
      });
      await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
      await prisma.v2AuthIdentity.create({
        data: {
          authUserId: randomUUID(),
          userId: user.id,
          usernameNormalized: user.username,
          authEmail: `${user.username}@integration.invalid`,
          enabled: true
        }
      });
    }
    normalStatusId = (
      await prisma.idBusinessV2Option.create({
        data: {
          type: 'id_status',
          code: 'normal',
          name: '正常',
          uniqueKey: key(),
          isSystem: true
        }
      })
    ).id;
    await prisma.idBusinessV2Option.create({
      data: { type: 'id_status', code: 'frozen', name: '冻结', uniqueKey: key(), isSystem: true }
    });
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function seedAccount(balance = '30', cost = '90') {
    const country = await prisma.idBusinessV2Option.create({
      data: {
        type: 'country',
        code: key(),
        name: '隔离测试国家',
        uniqueKey: key(),
        currencyCode: 'USD'
      }
    });
    const account = await prisma.idBusinessV2Account.create({
      data: {
        appleIdEncrypted: 'synthetic-encrypted-placeholder',
        appleIdHash: randomUUID(),
        appleIdMasked: 'test***@integration.invalid',
        countryOptionId: country.id,
        statusOptionId: normalStatusId,
        currentBalance: balance,
        balanceCostAmount: cost
      }
    });
    return { country, account };
  }
  async function seedOrder(status: 'processing' | 'completed') {
    const { account, country } = await seedAccount();
    const category = await prisma.idBusinessV2Option.create({
      data: { type: 'business_category', code: key(), name: '隔离分类', uniqueKey: key() }
    });
    const service = await prisma.idBusinessV2Option.create({
      data: {
        type: 'service',
        code: key(),
        name: '隔离业务',
        uniqueKey: key(),
        countryOptionId: country.id,
        parentId: category.id
      }
    });
    const customer = await prisma.idBusinessV2Customer.create({ data: { name: '隔离客户' } });
    const cash = await prisma.idBusinessV2FinanceAccount.create({
      data: {
        name: key(),
        accountType: 'bank',
        currency: 'CNY',
        openingBalance: '100',
        currentBalance: '100',
        openingBalanceCny: '100',
        currentBalanceCny: '100'
      }
    });
    const completed = status === 'completed';
    const order = await prisma.idBusinessV2Order.create({
      data: {
        orderNo: `RB-${randomUUID()}`,
        customerId: customer.id,
        serviceOptionId: service.id,
        accountId: account.id,
        status,
        balanceAmount: '20',
        balanceCostAmount: '60',
        appliedBalanceCostAmount: '60',
        receivedAmount: completed ? '100' : '0',
        receivedOriginalAmount: completed ? '100' : '0',
        receivedFinanceAccountId: cash.id,
        profitAmount: completed ? '40' : '-60',
        idempotencyKey: key()
      }
    });
    await prisma.idBusinessV2BalanceLedger.create({
      data: {
        accountId: account.id,
        orderId: order.id,
        entryType: 'order_consumption',
        direction: 'debit',
        balanceAmount: '20',
        costAmount: '60',
        balanceBefore: '50',
        balanceAfter: '30',
        costBefore: '150',
        costAfter: '90',
        averageCostBefore: '3',
        averageCostAfter: '3',
        idempotencyKey: key()
      }
    });
    let journalId: string | null = null;
    if (completed) {
      const journal = await transactions.execute(
        (tx) =>
          posting.post(tx, {
            journalType: 'order_completed',
            sourceType: 'order',
            sourceId: order.id,
            sourceReference: order.orderNo,
            occurredAt: new Date(),
            summary: '隔离订单入账',
            idempotencyKey: key(),
            lines: [
              {
                accountCode: 'cash',
                direction: 'debit',
                currency: 'CNY',
                amountOriginal: '100',
                amountCny: '100',
                fxRateToCny: '1',
                financeAccountId: cash.id
              },
              {
                accountCode: 'sales_revenue',
                direction: 'credit',
                currency: 'CNY',
                amountOriginal: '100',
                amountCny: '100',
                fxRateToCny: '1'
              },
              {
                accountCode: 'gift_card_cost',
                direction: 'debit',
                currency: 'CNY',
                amountOriginal: '60',
                amountCny: '60',
                fxRateToCny: '1'
              },
              {
                accountCode: 'gift_card_inventory',
                direction: 'credit',
                currency: 'CNY',
                amountOriginal: '60',
                amountCny: '60',
                fxRateToCny: '1'
              }
            ]
          }),
        { changedScopes: ['finance-ledger'], requestId: key() }
      );
      journalId = journal.id;
    }
    return { order, account, cash, journalId };
  }
  async function snapshot() {
    const [
      accounts,
      orders,
      cards,
      wallets,
      losses,
      ledger,
      supplierLedger,
      journals,
      lines,
      audits,
      financeAccounts
    ] = await Promise.all([
      prisma.idBusinessV2Account.findMany({ orderBy: { id: 'asc' } }),
      prisma.idBusinessV2Order.findMany({ orderBy: { id: 'asc' } }),
      prisma.idBusinessV2GiftCard.findMany({ orderBy: { id: 'asc' } }),
      prisma.idBusinessV2TopupSupplierAccount.findMany({ orderBy: { id: 'asc' } }),
      prisma.idBusinessV2AccountLoss.findMany({ orderBy: { id: 'asc' } }),
      prisma.idBusinessV2BalanceLedger.count(),
      prisma.idBusinessV2TopupSupplierLedger.count(),
      prisma.idBusinessV2FinanceJournal.count(),
      prisma.idBusinessV2FinanceJournalLine.count(),
      prisma.auditLog.count(),
      prisma.idBusinessV2FinanceAccount.findMany({ orderBy: { id: 'asc' } })
    ]);
    return JSON.stringify({
      accounts,
      orders,
      cards,
      wallets,
      losses,
      ledger,
      supplierLedger,
      journals,
      lines,
      audits,
      financeAccounts
    });
  }

  it('rejects generic order reversal without changing cash, order, journals or audit', async () => {
    const { journalId } = await seedOrder('completed');
    const before = await snapshot();
    await expect(
      journals.reverse(journalId!, '错误入口验证', key(), requester)
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await snapshot()).toBe(before);
  });

  it('rolls back all refund writes when the final audit fails, then restores exact balances once', async () => {
    const { order, account, cash } = await seedOrder('completed');
    const dto = {
      reason: '隔离订单退款验收',
      refundCostAmount: '0',
      balanceRefundMode: 'full' as const,
      idempotencyKey: key()
    };
    const before = await snapshot();
    const fault = vi
      .spyOn(orderRepository, 'appendAudit')
      .mockRejectedValueOnce(new Error('forced-final-audit-failure'));
    await expect(orders.refund(order.id, dto, requester)).rejects.toThrow(
      'forced-final-audit-failure'
    );
    fault.mockRestore();
    expect(await snapshot()).toBe(before);
    await orders.refund(order.id, dto, requester);
    const once = await snapshot();
    await orders.refund(order.id, dto, requester);
    expect(await snapshot()).toBe(once);
    const restored = await prisma.idBusinessV2Account.findUniqueOrThrow({
      where: { id: account.id }
    });
    expect([restored.currentBalance.toString(), restored.balanceCostAmount.toString()]).toEqual([
      '50',
      '150'
    ]);
    expect(
      (
        await prisma.idBusinessV2FinanceAccount.findUniqueOrThrow({ where: { id: cash.id } })
      ).currentBalance.toString()
    ).toBe('100');
    const refunded = await prisma.idBusinessV2Order.findUniqueOrThrow({ where: { id: order.id } });
    expect([refunded.status, refunded.profitAmount?.toString()]).toEqual(['refunded', '0']);
  });

  it('cancels and soft-deletes without losing or duplicating the original ledger', async () => {
    const { order, account } = await seedOrder('processing');
    const dto = { reason: '隔离取消验收', idempotencyKey: key() };
    await orders.cancel(order.id, dto, requester);
    const once = await snapshot();
    await orders.cancel(order.id, dto, requester);
    expect(await snapshot()).toBe(once);
    const restored = await prisma.idBusinessV2Account.findUniqueOrThrow({
      where: { id: account.id }
    });
    expect([restored.currentBalance.toString(), restored.balanceCostAmount.toString()]).toEqual([
      '50',
      '150'
    ]);
    await orders.remove(order.id, { reason: '隔离误录清理' }, requester);
    expect(await prisma.idBusinessV2BalanceLedger.count({ where: { orderId: order.id } })).toBe(2);
    const afterDelete = await snapshot();
    await orders.remove(order.id, { reason: '隔离误录清理' }, requester);
    expect(await snapshot()).toBe(afterDelete);
  });

  it('withdraws a gift card with weighted ID cost and exact supplier credit, with failure rollback and replay', async () => {
    const { account, country } = await seedAccount('150', '840');
    const cardName = await prisma.idBusinessV2Option.create({
      data: { type: 'gift_card_name', code: key(), name: '隔离卡', uniqueKey: key() }
    });
    const supplier = await prisma.idBusinessV2Option.create({
      data: { type: 'topup_supplier', code: key(), name: '隔离供应商', uniqueKey: key() }
    });
    const wallet = await prisma.idBusinessV2TopupSupplierAccount.create({
      data: {
        supplierOptionId: supplier.id,
        currency: 'CNY',
        openingBalance: '1000',
        currentBalance: '1000',
        openingBalanceCny: '1000',
        currentBalanceCny: '1000',
        initializedAt: new Date()
      }
    });
    const card = await prisma.idBusinessV2GiftCard.create({
      data: {
        accountId: account.id,
        cardNameOptionId: cardName.id,
        countryOptionId: country.id,
        supplierOptionId: supplier.id,
        cardNameSnapshot: '隔离卡',
        countryNameSnapshot: '隔离国家',
        codeEncrypted: 'synthetic-encrypted-placeholder',
        codeHash: randomUUID(),
        codeMasked: 'TEST****0000',
        codeTail: '0000',
        faceValue: '20',
        exchangeRate: '5.4',
        costAmount: '108',
        status: 'credited',
        creditedAt: new Date()
      }
    });
    await prisma.idBusinessV2BalanceLedger.create({
      data: {
        accountId: account.id,
        giftCardId: card.id,
        entryType: 'gift_card_credit',
        direction: 'credit',
        balanceAmount: '20',
        costAmount: '108',
        balanceBefore: '130',
        balanceAfter: '150',
        costBefore: '732',
        costAfter: '840',
        averageCostBefore: '5.63076923',
        averageCostAfter: '5.6',
        idempotencyKey: key()
      }
    });
    await prisma.$transaction((tx) =>
      funds.debitGiftCard(tx, {
        supplierOptionId: supplier.id,
        supplierAccountId: wallet.id,
        giftCardId: card.id,
        amountCny: '108',
        operator: requester
      })
    );
    const dto = { action: 'withdrawn' as const, reason: '隔离撤卡验收', idempotencyKey: key() };
    const before = await snapshot();
    const fault = vi
      .spyOn(giftRepository, 'appendAudit')
      .mockRejectedValueOnce(new Error('forced-gift-audit-failure'));
    await expect(gifts.reverse(card.id, dto, requester)).rejects.toThrow(
      'forced-gift-audit-failure'
    );
    fault.mockRestore();
    expect(await snapshot()).toBe(before);
    const requests = [dto, { ...dto, idempotencyKey: key() }];
    const results = await Promise.allSettled(
      requests.map((request) => gifts.reverse(card.id, request, requester))
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const accepted = results.find(
      (result) => result.status === 'fulfilled'
    )! as PromiseFulfilledResult<Awaited<ReturnType<typeof gifts.reverse>>>;
    expect(accepted.value.ledgerEntry.costAmount).toBe('112');
    const once = await snapshot();
    const acceptedRequest = requests[results.findIndex((result) => result.status === 'fulfilled')]!;
    await gifts.reverse(card.id, acceptedRequest, requester);
    expect(await snapshot()).toBe(once);
    const withdrawn = await prisma.idBusinessV2Account.findUniqueOrThrow({
      where: { id: account.id }
    });
    expect([withdrawn.currentBalance.toString(), withdrawn.balanceCostAmount.toString()]).toEqual([
      '130',
      '728'
    ]);
    expect(
      (
        await prisma.idBusinessV2TopupSupplierAccount.findUniqueOrThrow({
          where: { id: wallet.id }
        })
      ).currentBalance.toString()
    ).toBe('1000');
    expect(await prisma.idBusinessV2BalanceLedger.count({ where: { giftCardId: card.id } })).toBe(
      2
    );
    expect(
      await prisma.idBusinessV2TopupSupplierLedger.count({ where: { giftCardId: card.id } })
    ).toBe(2);
  });

  it('restores a reported loss through its original finance reversal without changing ID balances', async () => {
    const { account } = await seedAccount();
    await losses.reportLoss(
      account.id,
      {
        reason: '隔离报损验收',
        expectedCurrentBalance: '30',
        expectedBalanceCostAmount: '90',
        idempotencyKey: key()
      },
      requester
    );
    const reported = await prisma.idBusinessV2Account.findUniqueOrThrow({
      where: { id: account.id }
    });
    expect(reported.activeLossRecordId).not.toBeNull();
    const dto = {
      expectedLossId: reported.activeLossRecordId!,
      reason: '隔离恢复验收',
      idempotencyKey: key()
    };
    await losses.unfreezeLoss(account.id, dto, requester);
    const once = await snapshot();
    await losses.unfreezeLoss(account.id, dto, requester);
    expect(await snapshot()).toBe(once);
    const restored = await prisma.idBusinessV2Account.findUniqueOrThrow({
      where: { id: account.id }
    });
    expect([restored.currentBalance.toString(), restored.balanceCostAmount.toString()]).toEqual([
      '30',
      '90'
    ]);
    expect([restored.lossReportedAt, restored.activeLossRecordId]).toEqual([null, null]);
    const loss = await prisma.idBusinessV2AccountLoss.findUniqueOrThrow({
      where: { id: dto.expectedLossId }
    });
    expect(loss.status).toBe('reversed');
    expect(loss.reversalFinanceJournalId).not.toBeNull();
  });

  it('checks dependent masters both before approval and during execution, then permits a valid retry', async () => {
    const country = await prisma.idBusinessV2Option.create({
      data: { type: 'country', code: key(), name: '恢复测试国家', uniqueKey: key() }
    });
    const category = await prisma.idBusinessV2Option.create({
      data: {
        type: 'business_category',
        code: key(),
        name: '恢复测试分类',
        uniqueKey: key(),
        status: 'disabled'
      }
    });
    const deletedAt = new Date();
    const serviceKey = key();
    const serviceId = randomUUID();
    const countryKey = country.uniqueKey;
    await prisma.idBusinessV2Option.update({
      where: { id: country.id },
      data: {
        deletedAt,
        statusBeforeDeletion: 'active',
        uniqueKey: `deleted:${country.id}:${countryKey}`
      }
    });
    await prisma.idBusinessV2Option.create({
      data: {
        id: serviceId,
        type: 'service',
        code: key(),
        name: '恢复测试业务',
        countryOptionId: country.id,
        parentId: category.id,
        deletedAt,
        statusBeforeDeletion: 'active',
        deletedByParentOptionId: country.id,
        uniqueKey: `deleted:${serviceId}:${serviceKey}`
      }
    });
    const dto = () => ({
      items: [{ entity: 'option', id: country.id }],
      reason: '隔离依赖恢复完整性验收',
      backupEvidence: '隔离库合成数据，无生产数据',
      idempotencyKey: key()
    });
    await expect(preview.createRestoreJob(dto(), requester)).rejects.toThrow('不满足恢复条件');
    await prisma.idBusinessV2Option.update({
      where: { id: category.id },
      data: { status: 'active' }
    });
    const planned = await preview.createRestoreJob(dto(), requester);
    await approvals.decide(
      planned.id,
      { decision: 'approved', reason: '隔离审批验收通过' },
      approver
    );
    await prisma.idBusinessV2Option.update({
      where: { id: category.id },
      data: { status: 'disabled' }
    });
    const stopped = await execution.execute(
      planned.id,
      { batchSize: 1, idempotencyKey: key() },
      requester
    );
    expect(stopped.job.skippedItems).toBe(1);
    expect(
      (await prisma.idBusinessV2Option.findUniqueOrThrow({ where: { id: serviceId } })).deletedAt
    ).not.toBeNull();
    await prisma.idBusinessV2Option.update({
      where: { id: category.id },
      data: { status: 'active' }
    });
    const retry = await preview.createRestoreJob(dto(), requester);
    await approvals.decide(
      retry.id,
      { decision: 'approved', reason: '依赖恢复后重新审批' },
      approver
    );
    const executeDto = { batchSize: 1, idempotencyKey: key() };
    await execution.execute(retry.id, executeDto, requester);
    const auditCount = await prisma.auditLog.count();
    expect((await execution.execute(retry.id, executeDto, requester)).idempotentReplay).toBe(true);
    expect(await prisma.auditLog.count()).toBe(auditCount);
    const restored = await prisma.idBusinessV2Option.findUniqueOrThrow({
      where: { id: serviceId }
    });
    expect([restored.deletedAt, restored.status, restored.uniqueKey]).toEqual([
      null,
      'active',
      serviceKey
    ]);
  });

  it('queries missing MySQL rollback targets normally rather than failing SQL parsing', async () => {
    await expect(
      prisma.$transaction((tx) => orderRepository.lockOrderId(tx, randomUUID()))
    ).resolves.toBeNull();
    await expect(
      prisma.$transaction((tx) => giftRepository.lockReversalAccount(tx, randomUUID()))
    ).resolves.toBeNull();
    await expect(
      prisma.$transaction((tx) =>
        new IdBusinessV2AccountLossRepository(prisma).lockAccount(tx, randomUUID())
      )
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
