import type { IdBusinessV2RechargeJob } from '@prisma/client';
import type { V2CommandTransaction, V2TransactionalAuditService } from '../runtime/public-api';
import type { RechargeRepository } from './persistence/recharge.repository';
import { object } from './recharge-validation';

export function canReplaceCheckout(job: Pick<IdBusinessV2RechargeJob, 'action' | 'result'>) {
  return (
    ['quote', 'flow', 'server'].includes(job.action) && object(job.result).recheck_only !== true
  );
}

export async function completeCancellation(
  tx: V2CommandTransaction,
  job: IdBusinessV2RechargeJob,
  report: Record<string, unknown>,
  repository: RechargeRepository,
  audit: V2TransactionalAuditService
) {
  if (
    job.action !== 'bitbrowser' ||
    report.cancellation_confirmed !== true ||
    report.payment_requests_sent !== 0 ||
    report.payment_attempted !== false ||
    !job.accountKey ||
    object(job.result).recheck_only === true
  )
    return;
  const checkoutReadOnlyRecoverable = await repository.inspectStoppedCheckout(
    tx,
    job.accountKey,
    job.plan,
    job.ownerId
  );
  await audit.append(tx, {
    userId: job.ownerId,
    module: 'id_business_v2',
    action: 'id_business_v2.auto_recharge.bitbrowser.cancel',
    objectType: 'recharge_job',
    objectId: job.id,
    afterData: {
      checkoutReadOnlyRecoverable,
      browserCleanup:
        typeof report.browser_cleanup_status === 'string' ? report.browser_cleanup_status : null
    },
    remark: '仅停止本次任务并撤销确认；未证明官网订单取消，保留原订单及付款事实'
  });
}
