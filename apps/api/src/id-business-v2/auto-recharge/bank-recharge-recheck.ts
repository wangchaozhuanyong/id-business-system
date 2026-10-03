import type { IdBusinessV2RechargeJob } from '@prisma/client';
import type { V2CommandTransaction } from '../runtime/public-api';
import { BankRechargeRepository } from './persistence/bank-recharge.repository';
import { object } from './recharge-validation';
import { hasOfficialRechargeQuote, rechargeOperationIdentifier } from './recharge-upgrade-protocol';

export async function resolveBankRechargeSource(
  tx: V2CommandTransaction,
  repository: BankRechargeRepository,
  job: IdBusinessV2RechargeJob,
  result: Record<string, unknown>
) {
  if (object(job.result ?? {}).recheck_only === true || result.recheck_only === true) {
    const sourceId = object(job.result ?? {}).source_job_id;
    if (typeof sourceId !== 'string') return null;
    const source = await repository.findRechargeJob(tx, sourceId);
    const original = object(source?.result ?? {});
    if (
      !source ||
      source.id === job.id ||
      source.ownerId !== job.ownerId ||
      source.accountKey !== job.accountKey ||
      source.plan !== job.plan ||
      !['bitbrowser', 'server'].includes(source.action) ||
      original.recheck_only === true ||
      original.payment_requests_sent !== 1 ||
      !hasOfficialRechargeQuote(original) ||
      typeof rechargeOperationIdentifier(original) !== 'string' ||
      rechargeOperationIdentifier(original) !== rechargeOperationIdentifier(result) ||
      result.payment_requests_sent !== 0
    )
      return null;
    job = source;
    result = {
      ...original,
      ...result,
      recheck_only: false,
      quote: original.quote,
      quote_authority: original.quote_authority,
      payment_requests_sent: 1
    };
  }
  return { job, result };
}
