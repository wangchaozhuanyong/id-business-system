import { ConflictException } from '@nestjs/common';
import { type V2CommandTransaction, type V2TransactionalAuditService } from '../runtime/public-api';
import { RechargeAddressRepository } from './persistence/recharge-address.repository';
import { object, uuidPattern } from './recharge-validation';

export async function consumeRechargeAddress(input: {
  tx: V2CommandTransaction;
  rechargeJobId: string;
  job: { action: string; ownerId: string; result: unknown };
  report: Record<string, unknown>;
  addressRepository: RechargeAddressRepository;
  audit: V2TransactionalAuditService;
}) {
  const { tx, rechargeJobId, job, report, addressRepository, audit } = input;
  const jobResult = object(job.result);
  if (jobResult.recheck_only === true || jobResult.resolution_only === true) return;
  const addressConsumed =
    report.status === 'subscription_activated' ||
    (report.payment_attempted === true && Number(report.confirmation_requests_sent) === 1) ||
    Number(report.payment_requests_sent) === 1;
  if (!['prepare', 'flow', 'bitbrowser'].includes(job.action) || !addressConsumed) return;
  const addressId = jobResult.addressId;
  if (typeof addressId !== 'string' || !uuidPattern.test(addressId)) {
    throw new ConflictException('本次充值地址记录不完整');
  }
  const changed = await addressRepository.markUsed(tx, job.ownerId, addressId);
  if (!changed.changed) return;
  await audit.append(tx, {
    userId: job.ownerId,
    module: 'id_business_v2',
    action: 'id_business_v2.auto_recharge.addresses.consume',
    objectType: 'recharge_address',
    objectId: addressId,
    beforeData: { status: changed.before.status },
    afterData: { status: changed.after.status, rechargeJobId },
    remark: '账单地址已用于本次官方付款请求，自动标记已使用'
  });
}
