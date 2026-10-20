import { RechargeRepository } from './persistence/recharge.repository';
import { withResolutionVerification } from './recharge-resolution';
import { resultWithConfirmation } from './recharge-validation';
import { isRechargeWorkerConfigured } from './recharge-worker-client';
import { recoverRechargePaymentResult } from './recharge-payment-facts';
import { object, uuidPattern } from './recharge-validation';
import { rechargeAvailability } from './recharge-availability';
import type { IdBusinessV2RechargeJob, IdBusinessV2RechargeRecord } from '@prisma/client';

export async function listRechargeJobs(
  repository: RechargeRepository,
  ownerId: string,
  workerToken: string
) {
  const items = await repository.list(ownerId);
  const accountKeys = [
    ...new Set(items.map((job) => job.accountKey).filter((key): key is string => Boolean(key)))
  ];
  const records = accountKeys.length
    ? await repository.paymentRecords(ownerId, accountKeys, true)
    : [];
  return {
    items: presentRechargeJobs(items, records, workerToken),
    configured: isRechargeWorkerConfigured(),
    subscriptionCycleProtocol: 1 as const
  };
}

export function presentRechargeJobs(
  items: IdBusinessV2RechargeJob[],
  records: IdBusinessV2RechargeRecord[],
  workerToken: string,
  verificationItems: IdBusinessV2RechargeJob[] = items
) {
  return items.map((job) => {
    const storedResult =
      object(job.result).recheck_only !== true
        ? recoverRechargePaymentResult(job, records)
        : object(job.result);
    const publicResult = { ...storedResult };
    for (const key of Object.keys(publicResult))
      if (key.startsWith('connection_') || key.startsWith('_')) delete publicResult[key];
    const result = resultWithConfirmation({ ...job, result: publicResult }, workerToken);
    return {
      ...job,
      connectionProfileId:
        storedResult.connection_profile_id === null ||
        (typeof storedResult.connection_profile_id === 'string' &&
          uuidPattern.test(storedResult.connection_profile_id))
          ? storedResult.connection_profile_id
          : undefined,
      connectionProfileName:
        typeof storedResult.connection_profile_name === 'string'
          ? storedResult.connection_profile_name.slice(0, 80)
          : undefined,
      availability: rechargeAvailability({ ...job, result: storedResult as never }, records),
      nonceHash: undefined,
      accountKey: undefined,
      expectedEmailEncrypted: undefined,
      billingNameEncrypted: undefined,
      state:
        job.state !== 'finished' && job.leaseUntil.getTime() < Date.now() ? 'unknown' : job.state,
      result: withResolutionVerification(result, job, verificationItems)
    };
  });
}
