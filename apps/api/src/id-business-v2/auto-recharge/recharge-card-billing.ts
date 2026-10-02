import type { IdBusinessV2RechargeJob } from '@prisma/client';
import type { V2CommandTransaction } from '../runtime/public-api';
import type { BankRechargeCardService } from './bank-recharge-card.service';
import type { RechargeNameService } from './recharge-name.service';
import { object } from './recharge-validation';

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
