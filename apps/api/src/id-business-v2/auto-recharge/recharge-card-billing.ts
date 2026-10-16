import type { IdBusinessV2RechargeJob } from '@prisma/client';
import type { V2CommandTransaction } from '../runtime/public-api';
import type { BankRechargeCardService } from './bank-recharge-card.service';
import type { RechargeNameService } from './recharge-name.service';
import type { RechargeRepository } from './persistence/recharge.repository';
import { object } from './recharge-validation';
import { BadRequestException, ConflictException } from '@nestjs/common';

export async function finalizeRechargeCard(input: {
  tx: V2CommandTransaction;
  job: IdBusinessV2RechargeJob;
  report: Record<string, unknown>;
  order: { cardId: string | null; rechargeJobId: string | null } | null;
  repository: RechargeRepository;
  cards?: BankRechargeCardService;
  names?: RechargeNameService;
}) {
  const { tx, report, order, repository, cards, names } = input;
  let { job } = input;
  const stored = object(job.result);
  if (stored.recheck_only === true) {
    // 只读核对本身没有占卡；只有已核实入单后，才结算可信原任务。
    if (!order) return;
    if (!order.rechargeJobId || order.rechargeJobId !== stored.source_job_id)
      throw new ConflictException('核对订单与原付款任务不一致');
    const source = await repository.findJob(tx, order.rechargeJobId);
    if (
      !source ||
      source.id === job.id ||
      source.ownerId !== job.ownerId ||
      source.accountKey !== job.accountKey ||
      source.plan !== job.plan ||
      object(source.result).recheck_only === true
    )
      throw new ConflictException('核对订单的原付款任务已经变化');
    job = source;
  }
  await finalizeRechargeCardBilling(tx, job, order, cards, names);
  await cards?.finishSharedCard(tx, job.id, report, Boolean(order));
}

export async function resolveLocalRechargeCard(
  tx: V2CommandTransaction,
  input: {
    cardId?: string;
    billingName?: string;
    lockedCurrency: string;
    plan: string;
    id: string;
  },
  names?: RechargeNameService
) {
  if (names && !input.cardId) throw new BadRequestException('请先登记并选择本次充值银行卡');
  return input.cardId && names
    ? names.localCard(
        tx,
        input.cardId,
        input.billingName!,
        input.lockedCurrency,
        input.plan,
        input.id
      )
    : null;
}

export async function finalizeRechargeCardBilling(
  tx: V2CommandTransaction,
  job: Pick<
    IdBusinessV2RechargeJob,
    'id' | 'ownerId' | 'cardId' | 'billingNameEncrypted' | 'result'
  >,
  verifiedOrder: { cardId: string | null } | null,
  cards?: BankRechargeCardService,
  names?: RechargeNameService
) {
  if (!job.cardId || !job.billingNameEncrypted || !cards || verifiedOrder?.cardId !== job.cardId)
    return;
  const addressId = object(job.result).addressId;
  if (typeof addressId !== 'string') return;
  // 与姓名匹配、卡登记保持相同顺序，避免先锁卡片再等待姓名锁。
  await names?.lock(tx);
  const bound = await cards.bindVerifiedBilling(
    tx,
    job.cardId,
    job.billingNameEncrypted,
    addressId,
    job.ownerId,
    job.id
  );
  if (!bound || !names) return;
  const card = await cards.billingIdentity(tx, job.cardId);
  if (card?.numberHash) await names.confirm(tx, card.numberHash, job.billingNameEncrypted);
}
