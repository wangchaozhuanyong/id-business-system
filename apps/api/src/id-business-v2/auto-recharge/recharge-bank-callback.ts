import type { IdBusinessV2RechargeJob } from '@prisma/client';
import { ConflictException } from '@nestjs/common';
import { toV2JsonDocument, type V2CommandTransaction } from '../runtime/public-api';
import { BankRechargeAccountService } from './bank-recharge-account.service';
import { BankRechargeOrderService } from './bank-recharge-order.service';
import { object } from './recharge-validation';

export async function bindSavedChatgptAccount(
  tx: V2CommandTransaction,
  job: IdBusinessV2RechargeJob,
  report: Record<string, unknown>,
  accounts?: BankRechargeAccountService
) {
  if (
    ['bitbrowser', 'server'].includes(job.action) &&
    job.chatgptAccountId &&
    job.accountKey &&
    report.account_matched === true &&
    accounts
  ) {
    await accounts.bindOfficialAccount(tx, job.chatgptAccountId, job.accountKey);
  }
}

export async function recordServerLoginNetwork(
  tx: V2CommandTransaction,
  job: IdBusinessV2RechargeJob,
  report: Record<string, unknown>,
  accounts?: BankRechargeAccountService
) {
  if (
    job.action !== 'server' ||
    !['login_verified', 'session_verified'].includes(String(report.stage))
  )
    return;
  const network =
    report.network && typeof report.network === 'object' && !Array.isArray(report.network)
      ? (report.network as Record<string, unknown>)
      : {};
  const expectedCountryCode = object(job.result).expected_proxy_country;
  if (
    !accounts ||
    report.account_matched !== true ||
    !job.accountKey ||
    !job.expectedEmailEncrypted ||
    typeof network.ip !== 'string' ||
    typeof network.country !== 'string' ||
    typeof expectedCountryCode !== 'string'
  )
    throw new ConflictException('代理出口未核实，已限制登录');
  await accounts.recordVerifiedLoginNetwork(tx, {
    email: accounts.decryptExpectedEmail(job.expectedEmailEncrypted),
    accountKey: job.accountKey,
    ip: network.ip,
    countryCode: network.country,
    expectedCountryCode,
    jobId: job.id,
    ownerId: job.ownerId
  });
}

export async function recordVerifiedBankRecharge(
  tx: V2CommandTransaction,
  job: IdBusinessV2RechargeJob,
  report: Record<string, unknown>,
  orders?: BankRechargeOrderService
) {
  if (['bitbrowser', 'server'].includes(job.action) && orders) {
    return orders.recordVerifiedSuccess(tx, job, { ...object(job.result), ...report });
  }
  return null;
}

export function mergeRechargeCallbackResult(
  job: IdBusinessV2RechargeJob,
  report: Record<string, unknown>
) {
  const previous = object(job.result ?? {});
  return toV2JsonDocument({
    ...previous,
    ...report,
    ...(previous.recheck_only === true
      ? { recheck_only: true, source_job_id: previous.source_job_id }
      : {})
  });
}
