import type { IdBusinessV2RechargeJob } from '@prisma/client';
import {
  toV2JsonDocument,
  type V2CommandTransaction,
  type V2TransactionalAuditService
} from '../runtime/public-api';
import { RechargeRepository } from './persistence/recharge.repository';
import { object } from './recharge-validation';
import { rechargeOperationIdentifier } from './recharge-upgrade-protocol';
import { recoverRechargePaymentResult } from './recharge-payment-facts';

export async function recoverLocalRechargePaymentFacts(
  tx: V2CommandTransaction,
  repository: RechargeRepository,
  source: IdBusinessV2RechargeJob | null
) {
  return source?.accountKey
    ? recoverRechargePaymentResult(source, await repository.records(tx, source.accountKey))
    : object(source?.result ?? {});
}

export async function persistLocalPaymentFacts(
  tx: V2CommandTransaction,
  repository: RechargeRepository,
  audit: V2TransactionalAuditService,
  source: IdBusinessV2RechargeJob,
  result: Record<string, unknown>
) {
  if (JSON.stringify(result) === JSON.stringify(object(source.result ?? {}))) return;
  await repository.updateJob(tx, source.id, { result: toV2JsonDocument(result) });
  await audit.append(tx, {
    userId: source.ownerId,
    module: 'id_business_v2',
    action: 'id_business_v2.auto_recharge.bitbrowser.restore_payment_facts',
    objectType: 'recharge_job',
    objectId: source.id,
    afterData: {
      operationIdentifier: String(rechargeOperationIdentifier(result)),
      confirmationRequestsSent: Number(result.confirmation_requests_sent ?? 0)
    },
    remark: '依据原任务持久付款记录恢复只读复查资料，不重发付款'
  });
}
