import type { IdBusinessV2RechargeJob } from '@prisma/client';
import type { V2CommandTransaction, V2TransactionalAuditService } from '../runtime/public-api';
import type { RechargeRepository } from './persistence/recharge.repository';
import { object } from './recharge-validation';

export function canReplaceCheckout(job: Pick<IdBusinessV2RechargeJob, 'action' | 'result'>) {
  return (
    ['quote', 'flow', 'bitbrowser'].includes(job.action) && object(job.result).recheck_only !== true
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
  const retired = await repository.retireCancelledCheckout(
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
      retiredRecords: retired,
      browserCleanup:
        typeof report.browser_cleanup_status === 'string' ? report.browser_cleanup_status : null
    },
    remark: '连接器确认停止；停用未付款的取消结算，保留原始记录'
  });
}
