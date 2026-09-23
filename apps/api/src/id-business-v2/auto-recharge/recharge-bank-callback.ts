import type { IdBusinessV2RechargeJob } from '@prisma/client';
import type { V2CommandTransaction } from '../runtime/public-api';
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
    job.action === 'bitbrowser' &&
    job.chatgptAccountId &&
    job.accountKey &&
    report.account_matched === true &&
    accounts
  ) {
    await accounts.bindOfficialAccount(tx, job.chatgptAccountId, job.accountKey);
  }
}

export async function recordVerifiedBankRecharge(
  tx: V2CommandTransaction,
  job: IdBusinessV2RechargeJob,
  report: Record<string, unknown>,
  orders?: BankRechargeOrderService
) {
  if (job.action === 'bitbrowser' && orders) {
    await orders.recordVerifiedSuccess(tx, job, { ...object(job.result), ...report });
  }
}
