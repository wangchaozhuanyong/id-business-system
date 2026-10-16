import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { IdBusinessV2BankRechargeCard } from '@prisma/client';
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
    const config = await this.prisma.onlineRechargeConfig.findUnique({ where: { id: 'global' } });
    const policy = sharedCardLimits(config?.settings);
    const items = await this.prisma.onlineRechargeCard.findMany({
      where: {
        status: 'active',
        leaseOwner: null,
        allowedPlans: { array_contains: [sharedCardPlan(plan)] },
        successCount: { lt: policy.maxSubscriptionCount },
        declineCount: { lt: policy.maxDeclineCount }
      },
      select: { id: true, last4: true, allowedPlans: true, expiryMonth: true, expiryYear: true },
      orderBy: [{ successCount: 'asc' }, { lastUsedAt: 'asc' }, { id: 'asc' }]
    });
    return {
      items: items.map((card) => ({
        ...card,
        label: `银行卡 ····${card.last4}`,
        active: true,
        hasNumber: true
      }))
    };
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
    assertSharedCardPlan(shared.allowedPlans, plan);
    const config = await tx.onlineRechargeConfig.findUnique({ where: { id: 'global' } });
    const policy = sharedCardLimits(config?.settings);
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
    verified: boolean
  ) {
    await lockSharedBankCards(tx);
    const noPayment =
      report.payment_attempted === false && Number(report.payment_requests_sent ?? 0) === 0;
    const declined = report.payment_status === 'declined';
    if (!verified && !noPayment && !declined) return;
    const card = await tx.onlineRechargeCard.findFirst({ where: { leaseOwner: jobId } });
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
      where: { leaseOwner: jobId },
      data: {
        status,
        leaseOwner: null,
        leaseId: null,
        leaseExpiresAt: null,
        ...(verified
          ? { successCount: { increment: 1 }, declineCount: 0, lastUsedAt: new Date() }
          : {}),
        ...(!verified && declined ? { declineCount: { increment: 1 } } : {})
      }
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
      (await tx.onlineRechargeTask.count({ where: { cardId: shared.id } })) ||
      (await tx.onlineRechargeBill.count({ where: { cardId: shared.id } }))
    )
      throw new ConflictException('共享银行卡存在执行任务或线上代充历史，请在银行卡共享池停用');
    await tx.onlineRechargeCard.delete({ where: { id: shared.id } });
  }
}
