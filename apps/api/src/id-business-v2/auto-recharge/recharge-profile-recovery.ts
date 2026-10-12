import { BadRequestException, ConflictException } from '@nestjs/common';
import type { IdBusinessV2RechargeJob } from '@prisma/client';
import type { V2RechargeBitBrowserOpenStart } from '@apple-business/shared';
import {
  toV2JsonDocument,
  type V2CommandTransaction,
  type V2TransactionalAuditService
} from '../runtime/public-api';
import type { RechargeRepository } from './persistence/recharge.repository';
import type { BankRechargeAccountService } from './bank-recharge-account.service';
import { object } from './recharge-validation';
import {
  canRecreateRechargeBrowserProfile,
  isBrowserProfileId,
  rechargeProfileRecordsHavePaymentRisk
} from './recharge-job-helpers';

export async function startRechargeOpenProfile(input: {
  tx: V2CommandTransaction;
  request: V2RechargeBitBrowserOpenStart;
  ownerId: string;
  nonceHash: string;
  repository: RechargeRepository;
  accounts?: BankRechargeAccountService;
  audit: V2TransactionalAuditService;
}) {
  const { tx, request, ownerId, repository, accounts } = input;
  const account = request.chatgptAccountId
    ? await accounts?.requireRechargeInspection(tx, request.chatgptAccountId)
    : null;
  if (request.chatgptAccountId && !account)
    throw new BadRequestException('所选 ChatGPT 账号不可用');
  const accountKey = account?.officialAccountKey;
  const ownedProfile = accountKey
    ? await repository.retainedProfileForAccount(tx, ownerId, accountKey, request.id, true)
    : undefined;
  const job = await repository.createJob(tx, {
    id: request.id,
    ownerId,
    chatgptAccountId: account?.id ?? null,
    ...(accountKey ? { accountKey } : {}),
    plan: 'plus',
    action: 'bitbrowser',
    state: 'running',
    nonceHash: input.nonceHash,
    leaseUntil: new Date(Date.now() + 45 * 60000),
    result: toV2JsonDocument({
      status: 'waiting_local_connector',
      stage: 'connector_dispatch',
      mode: 'open_browser',
      ...(request.directMode ? { transport: 'web_direct' } : {}),
      window_name: request.windowName,
      payment_requests_sent: 0,
      ...(ownedProfile ? { browser_profile_id: ownedProfile.profileId } : {})
    })
  });
  await input.audit.append(tx, {
    userId: ownerId,
    module: 'id_business_v2',
    action: 'id_business_v2.auto_recharge.bitbrowser.open_window',
    objectType: 'recharge_job',
    objectId: job.id,
    afterData: {
      windowName: request.windowName,
      mode: 'open_browser',
      chatgptAccountId: account?.id ?? null
    },
    remark: '创建本机比特浏览器仅登录窗口任务'
  });
  return { job, accountKey, ownedProfile };
}

export async function retainOrReplaceRechargeBrowserProfile(input: {
  tx: V2CommandTransaction;
  job: IdBusinessV2RechargeJob;
  eventType: unknown;
  report: Record<string, unknown>;
  repository: RechargeRepository;
  audit: V2TransactionalAuditService;
}) {
  const { tx, job, eventType, report, repository, audit } = input;
  if (job.action !== 'bitbrowser') return;
  const previous = object(job.result);
  const originalProfileId = previous.browser_profile_id;
  if (
    !isBrowserProfileId(originalProfileId) ||
    report.browser_profile_id === undefined ||
    report.browser_profile_id === '' ||
    report.browser_profile_id === originalProfileId
  ) {
    if (isBrowserProfileId(originalProfileId)) report.browser_profile_id = originalProfileId;
    // 只有实际替换分支可以持久化证明；普通或迟到进度不能伪造、清空该证明。
    delete report.replaced_browser_profile_id;
    delete report.browser_profile_missing_confirmed;
    return;
  }
  if (
    eventType !== 'progress' ||
    report.stage !== 'bitbrowser_profile_created' ||
    !job.accountKey ||
    !canRecreateRechargeBrowserProfile(previous) ||
    !canRecreateRechargeBrowserProfile(report) ||
    previous.browser_profile_missing_confirmed === true ||
    report.replaced_browser_profile_id !== originalProfileId ||
    report.browser_profile_missing_confirmed !== true ||
    !isBrowserProfileId(report.browser_profile_id) ||
    report.payment_attempted !== false ||
    report.payment_requests_sent !== 0 ||
    [
      'checkout_identifier',
      'upgrade_identifier',
      'upgrade_invoice_identifier',
      'upgrade_payment_intent_identifier'
    ].some((key) => report[key] !== undefined && report[key] !== previous[key])
  )
    throw new ConflictException('本次任务已绑定原比特窗口，不能更换窗口');
  const records = await repository.records(tx, job.accountKey);
  if (
    previous.mode !== 'open_browser' &&
    rechargeProfileRecordsHavePaymentRisk(records, job.ownerId, job.accountKey, job.plan, previous)
  )
    throw new ConflictException('原单付款状态未安全核实，不能更换比特窗口');
  report.account_matched = false;
  await audit.append(tx, {
    userId: job.ownerId,
    module: 'id_business_v2',
    action: 'id_business_v2.auto_recharge.bitbrowser.recreate_missing_window',
    objectType: 'recharge_job',
    objectId: job.id,
    afterData: {
      previousProfileId: originalProfileId,
      browserProfileId: report.browser_profile_id
    },
    remark: '执行端确认原窗口不存在后重建，保留账号和原单；仍须核实官网身份'
  });
}
