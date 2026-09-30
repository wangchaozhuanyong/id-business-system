import { RechargeRepository } from './persistence/recharge.repository';
import { withResolutionVerification } from './recharge-resolution';
import { resultWithConfirmation } from './recharge-validation';
import { isRechargeWorkerConfigured } from './recharge-worker-client';

export async function listRechargeJobs(
  repository: RechargeRepository,
  ownerId: string,
  workerToken: string
) {
  const items = await repository.list(ownerId);
  return {
    items: items.map((job) => {
      const result = resultWithConfirmation(job, workerToken);
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
