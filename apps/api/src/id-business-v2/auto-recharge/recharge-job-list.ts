import { RechargeRepository } from './persistence/recharge.repository';
import { withResolutionVerification } from './recharge-resolution';
import { resultWithConfirmation } from './recharge-validation';
import { isRechargeWorkerConfigured } from './recharge-worker-client';
import { recoverRechargePaymentResult } from './recharge-payment-facts';
import { object } from './recharge-validation';

export async function listRechargeJobs(
  repository: RechargeRepository,
  ownerId: string,
  workerToken: string
) {
  const items = await repository.list(ownerId);
  const accountKeys = [
    ...new Set(
      items
        .filter(
          (job) =>
            job.action === 'server' &&
            job.accountKey &&
            object(job.result).recheck_only !== true &&
            object(job.result).quote_authority === 'official_checkout_response'
        )
        .map((job) => job.accountKey!)
    )
  ];
  const records = accountKeys.length ? await repository.paymentRecords(ownerId, accountKeys) : [];
  return {
    items: items.map((job) => {
      const storedResult =
        job.action === 'server' && object(job.result).recheck_only !== true
          ? recoverRechargePaymentResult(job, records)
          : object(job.result);
      const result = resultWithConfirmation({ ...job, result: storedResult }, workerToken);
      return {
        ...job,
        nonceHash: undefined,
        accountKey: undefined,
        expectedEmailEncrypted: undefined,
        billingNameEncrypted: undefined,
        state:
          job.state !== 'finished' && job.leaseUntil.getTime() < Date.now() ? 'unknown' : job.state,
        result: withResolutionVerification(result, job, items)
      };
    }),
    configured: isRechargeWorkerConfigured()
  };
}
