import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { IdBusinessV2BankRechargeCard, OnlineRechargeCard } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../../auth/auth.types';
import { FieldEncryptionService } from '../../../common/crypto/field-encryption.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { acquireMysqlTransactionLock } from '../../../common/prisma/mysql-transaction-lock';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  type V2CommandTransaction
} from '../../runtime/public-api';
import {
  assertSharedCardPlan,
  sharedCardPlan,
  sharedCardLimits,
  SHARED_CARD_PLANS
} from '../card-plan-policy';
import { bitBrowserPendingCapacity, SharedCardBusyConflict } from './shared-card-capacity';
import { releaseExpiredBitBrowserCardHold } from './shared-card-hold';

export type BitBrowserCardAttempt = {
  cardId: string;
  authorizedAt: string;
  outcome: 'pending' | 'paid' | 'declined' | 'resolved';
  holdReleasedAt?: string;
};
type CardOption = Pick<
  OnlineRechargeCard,
  'id' | 'last4' | 'allowedPlans' | 'expiryMonth' | 'expiryYear'
> & { label: string; active: boolean; hasNumber: boolean };
class UnchangedCardOptions extends Error {
  constructor(readonly value: { items: CardOption[] }) {
    super('unchanged card options');
  }
}

export function lockSharedBankCards(tx: V2CommandTransaction) {
  return acquireMysqlTransactionLock(tx, 'shared-bank-card-pool');
}

@Injectable()
export class SharedBankCardRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
    private readonly transactions: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService
  ) {}

  async options(plan: string) {
    try {
      return await this.transactions.execute(
        async (tx) => {
          await lockSharedBankCards(tx);
          const config = await tx.onlineRechargeConfig.findUnique({ where: { id: 'global' } });
          const policy = sharedCardLimits(config?.settings);
          const candidates = await tx.onlineRechargeCard.findMany({
            where: {
              status: 'active',
              allowedPlans: { array_contains: [sharedCardPlan(plan)] },
              successCount: { lt: policy.maxSubscriptionCount },
              declineCount: { lt: policy.maxDeclineCount },
              OR: [{ leaseOwner: null }, { leaseExpiresAt: { lte: new Date() } }]
            },
            orderBy: [{ successCount: 'asc' }, { lastUsedAt: 'asc' }, { id: 'asc' }],
            take: 500
          });
          const items = [];
          let changed = false;
          for (const card of candidates) {
            try {
              if (card.leaseOwner) {
                if (!(await releaseExpiredBitBrowserCardHold(tx, card))) continue;
                changed = true;
              }
              if (
                card.successCount + (await bitBrowserPendingCapacity(tx, card.id)) >=
                policy.maxSubscriptionCount
              )
                continue;
              items.push({
                id: card.id,
                last4: card.last4,
                allowedPlans: card.allowedPlans,
                expiryMonth: card.expiryMonth,
                expiryYear: card.expiryYear,
                label: `银行卡 ····${card.last4}`,
                active: true,
                hasNumber: true
              });
            } catch (error) {
              if (error instanceof SharedCardBusyConflict) continue;
              throw error;
            }
          }
          if (!changed) throw new UnchangedCardOptions({ items });
          return { items };
        },
        {
          changedScopes: ['auto-recharge', 'online-recharge'],
          requestId: randomUUID(),
          retryMode: 'none'
        }
      );
    } catch (error) {
      if (error instanceof UnchangedCardOptions) return error.value;
      throw error;
    }
  }

  async paymentDetails(id: string, plan: string, operator: AuthenticatedUser) {
    return this.transactions.execute(
      async (tx) => {
        const card = await tx.onlineRechargeCard.findUnique({ where: { id } });
        if (!card) throw new NotFoundException('银行卡不存在');
        assertSharedCardPlan(card.allowedPlans, plan);
        if (card.status !== 'active' || card.leaseOwner)
          throw new ConflictException('银行卡已停用或正在使用');
        const legacy = await tx.idBusinessV2BankRechargeCard.findUnique({
          where: { numberHash: card.numberHash }
        });
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.bank_card_pool.payment_read',
          objectType: 'bank_card_pool',
          objectId: id,
          afterData: { plan: sharedCardPlan(plan), last4: card.last4 },
          remark: '为当前套餐读取共享银行卡资料'
        });
        return {
          id: card.id,
          number: this.encryption.decrypt(card.numberEncrypted),
          expiry: `${String(card.expiryMonth).padStart(2, '0')}/${String(card.expiryYear).slice(-2)}`,
          status: card.status,
          allowedPlans: card.allowedPlans,
          billingName: legacy?.billingNameEncrypted
            ? this.encryption.decrypt(legacy.billingNameEncrypted)
            : null,
          billingAddressId: legacy?.billingAddressId ?? null
        };
      },
      { changedScopes: ['audit-logs'], requestId: randomUUID(), operator, retryMode: 'none' }
    );
  }

  async ensureLegacy(tx: V2CommandTransaction, card: IdBusinessV2BankRechargeCard) {
    await lockSharedBankCards(tx);
    if (!card.numberHash || !card.numberEncrypted || !card.expiry) return null;
    const [month, year] = card.expiry.split('/').map(Number);
    return tx.onlineRechargeCard.upsert({
      where: { numberHash: card.numberHash },
      create: {
        numberHash: card.numberHash,
        numberEncrypted: card.numberEncrypted,
        last4: card.last4,
        expiryMonth: month,
        expiryYear: 2000 + year,
        status: card.active ? 'active' : 'disabled',
        allowedPlans: [...SHARED_CARD_PLANS]
      },
      update: {}
    });
  }

  async reserveLegacy(
    tx: V2CommandTransaction,
    card: IdBusinessV2BankRechargeCard,
    plan: string,
    jobId: string
  ) {
    const shared = await this.ensureLegacy(tx, card);
    if (!shared) throw new ConflictException('银行卡资料不完整');
    await releaseExpiredBitBrowserCardHold(tx, shared);
    assertSharedCardPlan(shared.allowedPlans, plan);
    const config = await tx.onlineRechargeConfig.findUnique({ where: { id: 'global' } });
    const policy = sharedCardLimits(config?.settings);
    if (
      shared.successCount + (await bitBrowserPendingCapacity(tx, shared.id, jobId)) >=
      policy.maxSubscriptionCount
    )
      throw new ConflictException('银行卡成功与待核对订阅已达上限');
    const result = await tx.onlineRechargeCard.updateMany({
      where: {
        id: shared.id,
        status: 'active',
        allowedPlans: { array_contains: [sharedCardPlan(plan)] },
        successCount: { lt: policy.maxSubscriptionCount },
        declineCount: { lt: policy.maxDeclineCount },
        OR: [{ leaseOwner: null }, { leaseOwner: jobId }]
      },
      data: {
        leaseOwner: jobId,
        leaseId: randomUUID(),
        leaseVersion: { increment: 1 },
        leaseExpiresAt: new Date(Date.now() + 45 * 60000)
      }
    });
    if (result.count !== 1) throw new ConflictException('银行卡已停用或正被另一充值任务使用');
  }

  async assertNumber(tx: V2CommandTransaction, numberHash: string, plan?: string) {
    await lockSharedBankCards(tx);
    const shared = await tx.onlineRechargeCard.findUnique({ where: { numberHash } });
    if (!shared) return;
    if (await releaseExpiredBitBrowserCardHold(tx, shared)) shared.leaseOwner = null;
    if (plan) assertSharedCardPlan(shared.allowedPlans, plan);
    if (shared.status !== 'active' || shared.leaseOwner)
      throw new ConflictException('银行卡已停用或正被另一充值任务使用');
    return shared;
  }

  availability(numberHash: string) {
    return this.prisma.onlineRechargeCard.findUnique({
      where: { numberHash },
      select: { status: true, leaseOwner: true }
    });
  }

  async assertLegacyAvailable(tx: V2CommandTransaction, card: IdBusinessV2BankRechargeCard) {
    await this.ensureLegacy(tx, card);
    const shared = card.numberHash ? await this.assertNumber(tx, card.numberHash) : null;
    // 历史投影的启停状态只用于尚未进入共享池的残缺资料。
    if (!shared && !card.active) throw new ConflictException('该银行卡已停用，不能用于充值');
  }

  async finishBitBrowser(
    tx: V2CommandTransaction,
    jobId: string,
    report: Record<string, unknown>,
    verified: boolean,
    attempt?: BitBrowserCardAttempt
  ) {
    await lockSharedBankCards(tx);
    const noPayment =
      report.payment_attempted === false && Number(report.payment_requests_sent ?? 0) === 0;
    const declined = report.payment_status === 'declined';
    if (!verified && !noPayment && !declined) return attempt;
    if (attempt && attempt.outcome !== 'pending') {
      if (verified && attempt.outcome !== 'paid')
        throw new ConflictException('原付款结算与迟到结果冲突，请人工核对');
      await this.releaseBitBrowserHold(tx, jobId);
      return attempt;
    }
    const card = attempt
      ? await tx.onlineRechargeCard.findUnique({ where: { id: attempt.cardId } })
      : await this.ownedBitBrowserCard(tx, jobId);
    if (!card) return;
    const config = await tx.onlineRechargeConfig.findUnique({ where: { id: 'global' } });
    const policy = sharedCardLimits(config?.settings);
    const status =
      verified && card.successCount + 1 >= policy.maxSubscriptionCount
        ? 'exhausted'
        : !verified && declined && card.declineCount + 1 >= policy.maxDeclineCount
          ? 'retired'
          : card.status;
    await tx.onlineRechargeCard.updateMany({
      where: attempt ? { id: card.id } : { leaseOwner: jobId },
      data: {
        status,
        ...(!attempt ? { leaseOwner: null, leaseId: null, leaseExpiresAt: null } : {}),
        ...(verified
          ? { successCount: { increment: 1 }, declineCount: 0, lastUsedAt: new Date() }
          : {}),
        ...(!verified && declined ? { declineCount: { increment: 1 } } : {})
      }
    });
    if (attempt) {
      await this.releaseBitBrowserHold(tx, jobId);
      return {
        ...attempt,
        outcome: verified
          ? ('paid' as const)
          : declined
            ? ('declined' as const)
            : ('resolved' as const)
      };
    }
  }

  private async ownedBitBrowserCard(
    tx: V2CommandTransaction,
    jobId: string,
    legacyCardId?: string | null
  ) {
    const matches = await tx.onlineRechargeCard.findMany({ where: { leaseOwner: jobId }, take: 2 });
    if (matches.length > 1) throw new ConflictException('原任务关联多张银行卡，禁止自动处理');
    const card = matches[0];
    if (card && legacyCardId) {
      const legacy = await tx.idBusinessV2BankRechargeCard.findUnique({
        where: { id: legacyCardId }
      });
      if (!legacy || legacy.numberHash !== card.numberHash)
        throw new ConflictException('原任务银行卡归属未核实');
    }
    return card;
  }

  async authorizeBitBrowserAttempt(
    tx: V2CommandTransaction,
    jobId: string,
    legacyCardId: string | null
  ): Promise<BitBrowserCardAttempt> {
    await lockSharedBankCards(tx);
    if (!legacyCardId) throw new ConflictException('本次银行卡归属缺失，禁止付款');
    const card = await this.ownedBitBrowserCard(tx, jobId, legacyCardId);
    if (
      !card ||
      card.status !== 'active' ||
      !card.leaseExpiresAt ||
      card.leaseExpiresAt.getTime() <= Date.now()
    )
      throw new ConflictException('本次银行卡租约已失效，禁止付款');
    const config = await tx.onlineRechargeConfig.findUnique({ where: { id: 'global' } });
    if (
      card.successCount + (await bitBrowserPendingCapacity(tx, card.id, jobId)) >=
      sharedCardLimits(config?.settings).maxSubscriptionCount
    )
      throw new ConflictException('银行卡成功与待核对订阅已达上限');
    const authorizedAt = new Date().toISOString();
    const updated = await tx.onlineRechargeCard.updateMany({
      where: { id: card.id, leaseOwner: jobId },
      data: { leaseExpiresAt: new Date(Date.parse(authorizedAt) + 120000) }
    });
    if (updated.count !== 1) throw new ConflictException('本次银行卡租约已变化，禁止付款');
    return { cardId: card.id, authorizedAt, outcome: 'pending' };
  }

  async recoverBitBrowserAttempt(
    tx: V2CommandTransaction,
    jobId: string,
    authorizedAt: string,
    legacyCardId: string | null
  ) {
    await lockSharedBankCards(tx);
    if (!legacyCardId) return;
    const card = await this.ownedBitBrowserCard(tx, jobId, legacyCardId);
    if (!card) return;
    await tx.onlineRechargeCard.updateMany({
      where: { id: card.id, leaseOwner: jobId },
      data: { leaseExpiresAt: new Date(Date.parse(authorizedAt) + 120000) }
    });
    return { cardId: card.id, authorizedAt, outcome: 'pending' as const };
  }

  async releaseBitBrowserHold(tx: V2CommandTransaction, jobId: string) {
    await lockSharedBankCards(tx);
    return tx.onlineRechargeCard.updateMany({
      where: { leaseOwner: jobId },
      data: { leaseOwner: null, leaseId: null, leaseExpiresAt: null }
    });
  }

  async syncLegacy(
    tx: V2CommandTransaction,
    card: IdBusinessV2BankRechargeCard,
    status?: 'active' | 'disabled'
  ) {
    const shared = await this.ensureLegacy(tx, card);
    if (!shared) return;
    if (shared.leaseOwner) throw new ConflictException('银行卡关联执行中或待核对任务，不能更改');
    const [month, year] = card.expiry!.split('/').map(Number);
    await tx.onlineRechargeCard.update({
      where: { id: shared.id },
      data: {
        numberEncrypted: card.numberEncrypted!,
        last4: card.last4,
        expiryMonth: month,
        expiryYear: 2000 + year,
        ...(status ? { status } : {})
      }
    });
  }

  async disableLegacy(tx: V2CommandTransaction, numberHash: string | null) {
    if (!numberHash) return;
    await lockSharedBankCards(tx);
    const shared = await tx.onlineRechargeCard.findUnique({ where: { numberHash } });
    if (shared?.leaseOwner) throw new ConflictException('银行卡关联执行中或待核对任务，不能更改');
    if (shared)
      await tx.onlineRechargeCard.update({
        where: { id: shared.id },
        data: { status: 'disabled' }
      });
  }

  async removeLegacyData(tx: V2CommandTransaction, numberHash: string | null) {
    if (!numberHash) return;
    await lockSharedBankCards(tx);
    const shared = await tx.onlineRechargeCard.findUnique({ where: { numberHash } });
    if (!shared) return;
    if (
      shared.leaseOwner ||
      (await bitBrowserPendingCapacity(tx, shared.id)) > 0 ||
      (await tx.onlineRechargeTask.count({ where: { cardId: shared.id } })) ||
      (await tx.onlineRechargeBill.count({ where: { cardId: shared.id } }))
    )
      throw new ConflictException('共享银行卡存在执行任务或线上代充历史，请在银行卡共享池停用');
    await tx.onlineRechargeCard.delete({ where: { id: shared.id } });
  }
}
