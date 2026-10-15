import { resolvedDeclinedPayment } from './recharge-noncharge-proof';
import { isUnidentifiedUnpaidCheckout } from './recharge-unidentified-checkout';
import type {
  V2RechargeDetails,
  V2RechargeStart,
  V2RechargeOwnedBrowserProfile
} from '@apple-business/shared';
import { ConflictException } from '@nestjs/common';
import { uuidPattern } from './recharge-validation';
import { parseIdBusinessV2TotpSecret } from '../workspace/public-api';
import {
  hasVerifiedRechargePayment,
  isRechargeUpgrade,
  rechargeUpgradePaymentReference
} from './recharge-upgrade-protocol';

export function parseRechargeTotpSecret(secret: string) {
  const configuration = parseIdBusinessV2TotpSecret(secret);
  return {
    secret: configuration.secret,
    algorithm: configuration.algorithm,
    digits: configuration.digits,
    period: configuration.period
  };
}

const browserProfilePattern = /^[a-f0-9]{32}$/i;

type FinishedRechargeJob = {
  id: string;
  result: unknown;
};

type OwnedRechargeJob = FinishedRechargeJob & {
  ownerId: string;
  accountKey: string | null;
  action: string;
  state: string;
  plan: string;
};

type RechargeAddress = {
  country: string;
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  postalCode: string;
};

export function isBrowserProfileId(value: unknown): value is string {
  return typeof value === 'string' && browserProfilePattern.test(value);
}

/** 已发付款或已消耗确认的任务不能靠更换窗口重新执行。未付款原结算仍可恢复。 */
export function rechargeProfileHasPaymentRisk(result: Record<string, unknown>) {
  const zero = (value: unknown) => value === undefined || value === null || value === 0;
  return (
    (result.payment_attempted !== undefined && result.payment_attempted !== false) ||
    !zero(result.payment_requests_sent) ||
    !zero(result.confirmation_requests_sent) ||
    result.manual_confirmation_accepted === true ||
    Boolean(result.payment_evidence) ||
    (result.payment_status !== undefined &&
      result.payment_status !== null &&
      result.payment_status !== 'not_attempted') ||
    ['unknown', 'succeeded', 'subscription_activated'].includes(String(result.payment_outcome)) ||
    result.checkout_outcome === 'unknown' ||
    (Number(result.checkout_requests_sent ?? 0) > 0 &&
      !/^(?:cs|oaics)_[A-Za-z0-9_]{1,200}$/.test(String(result.checkout_identifier ?? '')))
  );
}

export function canRecreateRechargeBrowserProfile(result: Record<string, unknown>) {
  return (
    result.recheck_only !== true &&
    result.resolution_only !== true &&
    result.handoff_kind !== 'bank' &&
    (result.three_ds_status === undefined || result.three_ds_status === 'not_required') &&
    !rechargeProfileHasPaymentRisk(result)
  );
}

export function rechargeProfileRecordsHavePaymentRisk(
  records: { ownerId: string; fileKey: string; document: unknown }[],
  ownerId: string,
  accountKey: string,
  plan: string,
  previous: Record<string, unknown>
) {
  const identifier = previous.checkout_identifier ?? previous.upgrade_identifier;
  const checkoutFile = `${accountKey}${plan === 'plus' ? '' : `-${plan}`}.json`;
  return records.some((record) => {
    if (record.ownerId !== ownerId) return true;
    if (!record.document || typeof record.document !== 'object' || Array.isArray(record.document))
      return record.fileKey === checkoutFile || record.fileKey.startsWith('payments/');
    const document = record.document as Record<string, unknown>;
    if (resolvedDeclinedPayment(document)) return false;
    const bound =
      typeof identifier === 'string' &&
      (document.checkout_identifier === identifier || document.upgrade_identifier === identifier);
    const unresolved =
      record.fileKey.startsWith('payments/') &&
      ['unknown', 'requires_action'].includes(String(document.payment_status));
    const currentCheckout = previous.mode !== 'open_browser' && record.fileKey === checkoutFile;
    return (bound || unresolved || currentCheckout) && rechargeProfileHasPaymentRisk(document);
  });
}

export function staleProfile(job: FinishedRechargeJob, includeCompleted = false) {
  if (!job.result || typeof job.result !== 'object' || Array.isArray(job.result)) return null;
  const result = job.result as Record<string, unknown>;
  const profileId = result.browser_profile_id;
  const zero = (value: unknown) => value === undefined || value === null || value === 0;
  if (
    !isBrowserProfileId(profileId) ||
    typeof result.reason !== 'string' ||
    result.payment_attempted === true ||
    !zero(result.payment_requests_sent) ||
    !zero(result.confirmation_requests_sent) ||
    (result.payment_status !== undefined &&
      result.payment_status !== null &&
      result.payment_status !== 'not_attempted') ||
    result.payment_outcome === 'succeeded' ||
    result.subscription_status === 'active' ||
    result.user_action_required === true ||
    (!includeCompleted && result.browser_cleanup_status === 'completed')
  )
    return null;
  return { sourceJobId: job.id, profileId };
}

export function findOwnedRechargeBrowserProfile(
  jobs: OwnedRechargeJob[],
  ownerId: string,
  accountKey: string
): V2RechargeOwnedBrowserProfile | undefined {
  if (!/^[a-f0-9]{64}$/.test(accountKey)) return undefined;
  for (const job of jobs) {
    if (
      job.ownerId !== ownerId ||
      job.accountKey !== accountKey ||
      job.action !== 'bitbrowser' ||
      job.state !== 'finished' ||
      !uuidPattern.test(job.id) ||
      !job.result ||
      typeof job.result !== 'object' ||
      Array.isArray(job.result)
    )
      continue;
    const result = job.result as Record<string, unknown>;
    const evidence = result.payment_evidence as
      | { kind?: unknown; identifier?: unknown; amount_minor?: unknown; currency?: unknown }
      | undefined;
    const today = (result.quote as { today?: typeof evidence } | undefined)?.today;
    const paymentReference = isRechargeUpgrade(result)
      ? rechargeUpgradePaymentReference(result)
      : typeof result.checkout_identifier === 'string' &&
        /^(?:cs|oaics)_[A-Za-z0-9_]{1,200}$/.test(result.checkout_identifier) &&
        ((evidence?.kind === 'checkout_session' &&
          evidence.identifier === result.checkout_identifier) ||
          (evidence?.kind === 'payment_intent' &&
            typeof evidence.identifier === 'string' &&
            /^pi_[A-Za-z0-9]{1,180}$/.test(evidence.identifier)));
    if (
      !isBrowserProfileId(result.browser_profile_id) ||
      result.mode === 'open_browser' ||
      result.recheck_only === true ||
      result.browser_cleanup_status === 'completed' ||
      !hasVerifiedRechargePayment(result, job) ||
      result.confirmation_requests_sent !== 1 ||
      !paymentReference ||
      typeof evidence?.amount_minor !== 'number' ||
      !Number.isSafeInteger(evidence?.amount_minor) ||
      evidence.amount_minor <= 0 ||
      evidence?.amount_minor !== today?.amount_minor ||
      typeof evidence?.currency !== 'string' ||
      evidence.currency !== today?.currency
    )
      continue;
    return { sourceJobId: job.id, profileId: result.browser_profile_id, accountKey };
  }
  return undefined;
}

/** 按创建时间倒序读取目标窗口归属；不表示官网身份或付款已经核实。 */
export function findRetainedRechargeBrowserProfile(
  jobs: OwnedRechargeJob[],
  ownerId: string,
  accountKey: string,
  allowDeletedProfile = false
): V2RechargeOwnedBrowserProfile | undefined {
  if (!/^[a-f0-9]{64}$/.test(accountKey)) return undefined;
  for (const job of jobs) {
    if (
      job.ownerId !== ownerId ||
      job.accountKey !== accountKey ||
      job.action !== 'bitbrowser' ||
      job.state !== 'finished' ||
      !uuidPattern.test(job.id) ||
      !job.result ||
      typeof job.result !== 'object' ||
      Array.isArray(job.result)
    )
      continue;
    const result = job.result as Record<string, unknown>;
    if (result.recheck_only === true) continue;
    // 返回已删除原ID供正常登录核实；复查仍停止，也绝不回退到更旧窗口。
    if (
      result.browser_cleanup_status === 'completed' &&
      (!allowDeletedProfile || !isBrowserProfileId(result.browser_profile_id))
    )
      throw new ConflictException('原比特浏览器资料已被删除，请恢复原资料后重试');
    if (!isBrowserProfileId(result.browser_profile_id)) continue;
    return { sourceJobId: job.id, profileId: result.browser_profile_id, accountKey };
  }
  return undefined;
}

export function rechargeCheckoutIdentifier(result: Record<string, unknown>): string | undefined {
  if (
    result.mode === 'open_browser' ||
    result.recheck_only === true ||
    result.operation === 'subscription_upgrade'
  )
    return undefined;
  if (result.checkout_identifier !== undefined && result.checkout_identifier !== null) {
    if (
      typeof result.checkout_identifier !== 'string' ||
      !/^(?:cs|oaics)_[A-Za-z0-9_]{1,200}$/.test(result.checkout_identifier)
    )
      throw new ConflictException('原订单编号未核实，禁止创建新订单');
    return result.checkout_identifier;
  }
  if (
    Number(result.checkout_requests_sent ?? 0) > 0 ||
    ['created', 'unknown'].includes(String(result.checkout_outcome ?? ''))
  )
    throw new ConflictException('原订单编号未核实，禁止创建新订单');
  return undefined;
}

export function findOriginalRechargeCheckout(
  jobs: OwnedRechargeJob[],
  ownerId: string,
  accountKey: string,
  plan: string,
  unidentifiedSourceJobId?: string
) {
  for (const job of jobs) {
    if (
      job.ownerId !== ownerId ||
      job.accountKey !== accountKey ||
      job.action !== 'bitbrowser' ||
      job.state !== 'finished' ||
      job.plan !== plan ||
      !uuidPattern.test(job.id) ||
      !job.result ||
      typeof job.result !== 'object' ||
      Array.isArray(job.result)
    )
      continue;
    if (resolvedDeclinedPayment(job.result)) continue;
    if (job.id === unidentifiedSourceJobId && isUnidentifiedUnpaidCheckout(job.result)) continue;
    const identifier = rechargeCheckoutIdentifier(job.result as Record<string, unknown>);
    if (identifier) return identifier;
  }
  return undefined;
}

export function rechargeDetailsWithAddress(
  details: V2RechargeDetails,
  address: RechargeAddress
): V2RechargeDetails {
  return {
    ...details,
    country: address.country,
    line1: address.line1,
    line2: address.line2 ?? '',
    city: address.city,
    state: address.state,
    postal_code: address.postalCode
  };
}

export function clearRechargeDetails(details?: V2RechargeDetails) {
  if (!details) return;
  Object.keys(details).forEach((key) => {
    details[key as keyof V2RechargeDetails] = '';
  });
}

export function clearRechargeStartSecrets(input: V2RechargeStart) {
  input.sessionJson = '';
  if (input.login) {
    input.login.password = '';
    input.login.totpSecret = '';
  }
  clearRechargeDetails(input.details);
}
