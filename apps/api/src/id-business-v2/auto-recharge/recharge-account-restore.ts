import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import type { IdBusinessV2RechargeJob } from '@prisma/client';
import type { V2CommandTransaction } from '../runtime/public-api';
import { toV2JsonDocument } from '../runtime/public-api';
import type { RechargeRepository } from './persistence/recharge.repository';
import type { BankRechargeAccountService } from './bank-recharge-account.service';
import { object } from './recharge-validation';
import {
  canRecreateRechargeBrowserProfile,
  isBrowserProfileId,
  rechargeCheckoutIdentifier,
  staleProfile
} from './recharge-job-helpers';
import { cycleContext, readCycleState } from './recharge-cycle-state';
import { unpaidCheckoutRecoveryIdentifier } from './recharge-checkout-recovery';
import {
  findUnidentifiedCheckoutSource,
  isUnidentifiedUnpaidCheckout
} from './recharge-unidentified-checkout';

export async function restoreRechargeAccount(input: {
  tx: V2CommandTransaction;
  job: IdBusinessV2RechargeJob;
  callback: Record<string, unknown>;
  repository: RechargeRepository;
  accounts?: BankRechargeAccountService;
}) {
  const { tx, job, repository, accounts, callback } = input;
  const accountKey = callback.accountKey;
  if (
    typeof accountKey !== 'string' ||
    !/^[a-f0-9]{64}$/.test(accountKey) ||
    (job.accountKey && job.accountKey !== accountKey)
  )
    throw new BadRequestException('账户标识不一致');
  const records = await repository.records(tx, accountKey);
  const expiredCheckoutIdentifiers = records.flatMap((record) => {
    if (
      !record.fileKey.startsWith('history/') ||
      object(record.document).kind !== 'expired_checkout'
    )
      return [];
    const proof = object(object(record.document).proof);
    return proof.account_key === accountKey &&
      proof.target_plan === job.plan &&
      proof.status === 'expired' &&
      proof.payment_status === 'unpaid' &&
      typeof proof.checkout_identifier === 'string'
      ? [proof.checkout_identifier]
      : [];
  });
  if (records.some((record) => record.ownerId !== job.ownerId))
    throw new ForbiddenException('该账户属于另一操作人的原任务');
  if (job.chatgptAccountId && accounts) {
    await accounts.assertOfficialAccount(tx, job.chatgptAccountId, accountKey);
  }
  const currentResult = object(job.result);
  const boundJob = { ...job, accountKey };
  const nextCycleContext = cycleContext(boundJob, records, callback.subscriptionCycleProtocol);
  const pendingCycleMarker =
    readCycleState(boundJob)?.grant?.status === 'consumed' && !currentResult.checkout_identifier;
  let ownedProfile =
    job.action === 'bitbrowser'
      ? await repository.retainedProfileForAccount(
          tx,
          job.ownerId,
          accountKey,
          job.id,
          canRecreateRechargeBrowserProfile(currentResult),
          currentResult.connection_api_key as string | undefined,
          currentResult.connection_profile_id as string | null | undefined
        )
      : undefined;
  const finished =
    job.action === 'bitbrowser'
      ? []
      : await repository.finishedJobsForAccount(tx, job.ownerId, accountKey, job.id);
  let originalCheckoutIdentifier: string | undefined;
  const unidentifiedRecord = records.find(
    (r) =>
      r.fileKey === `${accountKey}${job.plan === 'plus' ? '' : `-${job.plan}`}.json` &&
      Number.isSafeInteger(r.revision) &&
      r.revision >= 0 &&
      (object(r.document).target_plan ?? 'plus') === job.plan &&
      isUnidentifiedUnpaidCheckout(r.document)
  );
  let unidentifiedSource =
    unidentifiedRecord && ownedProfile
      ? await repository.findJob(tx, ownedProfile.sourceJobId)
      : null;
  if (
    unidentifiedRecord &&
    ownedProfile &&
    unidentifiedSource &&
    !isUnidentifiedUnpaidCheckout(unidentifiedSource.result)
  ) {
    const history = await repository.finishedJobsForAccount(tx, job.ownerId, accountKey, job.id);
    // 现有查询最多30条；不能把截断历史当作唯一来源的证明。
    unidentifiedSource =
      history.length < 30
        ? (findUnidentifiedCheckoutSource(
            history,
            job.ownerId,
            accountKey,
            job.plan,
            ownedProfile.profileId
          ) ?? null)
        : null;
  }
  const unidentifiedRecovery = Boolean(
    unidentifiedRecord &&
    ownedProfile &&
    unidentifiedSource &&
    job.action === 'bitbrowser' &&
    job.state === 'running' &&
    currentResult.mode !== 'open_browser' &&
    currentResult.recheck_only !== true &&
    currentResult.resolution_only !== true &&
    currentResult.payment_requests_sent === 0 &&
    !currentResult.manual_confirmation_accepted &&
    !records.some((r) => r.fileKey.startsWith('payments/')) &&
    unidentifiedSource.ownerId === job.ownerId &&
    unidentifiedSource.accountKey === accountKey &&
    unidentifiedSource.plan === job.plan &&
    unidentifiedSource.action === 'bitbrowser' &&
    unidentifiedSource.state === 'finished' &&
    isUnidentifiedUnpaidCheckout(unidentifiedSource.result) &&
    (object(unidentifiedSource.result).target_plan ?? 'plus') === job.plan &&
    (object(unidentifiedSource.result).browser_profile_id === ownedProfile.profileId ||
      unidentifiedSource.id !== ownedProfile.sourceJobId)
  );
  if (job.action === 'bitbrowser' && currentResult.recheck_only === true) {
    const source =
      typeof currentResult.source_job_id === 'string'
        ? await repository.findJob(tx, currentResult.source_job_id)
        : null;
    if (
      !source ||
      source.ownerId !== job.ownerId ||
      source.accountKey !== accountKey ||
      source.plan !== job.plan
    )
      throw new ConflictException('原单账号或归属未核实，不能只读复查');
    const sourceResult = object(source.result);
    if (sourceResult.recheck_only === true)
      throw new ConflictException('请复查原付款任务，不使用复查任务代替原单');
    if (sourceResult.operation !== 'subscription_upgrade') {
      const identifier = rechargeCheckoutIdentifier(sourceResult);
      if (!identifier) throw new ConflictException('原订单编号未核实，不能只读复查');
      originalCheckoutIdentifier = repository.restoreCheckoutIdentifier(
        records,
        accountKey,
        job.plan,
        [identifier]
      );
      if (originalCheckoutIdentifier !== identifier)
        throw new ConflictException('原订单编号不一致，不能只读复查');
    }
  }
  if (
    job.action === 'bitbrowser' &&
    currentResult.mode !== 'open_browser' &&
    currentResult.recheck_only !== true &&
    !pendingCycleMarker
  ) {
    const boundIdentifier = rechargeCheckoutIdentifier(currentResult);
    // 当前任务绑定与付款账本必须先一致；历史恢复资格不能覆盖当前任务的冲突。
    const persistedIdentifier = repository.restoreCheckoutIdentifier(
      records,
      accountKey,
      job.plan,
      [boundIdentifier],
      unidentifiedRecovery
    );
    let historicalIdentifier = await repository.originalCheckoutForAccount(
      tx,
      job.ownerId,
      accountKey,
      job.plan,
      job.id,
      undefined,
      unidentifiedRecovery ? unidentifiedSource?.id : undefined,
      ...(expiredCheckoutIdentifiers.length
        ? ([expiredCheckoutIdentifiers] as const)
        : ([] as const))
    );
    if (
      persistedIdentifier &&
      historicalIdentifier &&
      persistedIdentifier !== historicalIdentifier &&
      unpaidCheckoutRecoveryIdentifier(job, accountKey, records) === persistedIdentifier
    ) {
      historicalIdentifier = await repository.originalCheckoutForAccount(
        tx,
        job.ownerId,
        accountKey,
        job.plan,
        job.id,
        persistedIdentifier,
        undefined,
        expiredCheckoutIdentifiers
      );
    }
    originalCheckoutIdentifier = repository.restoreCheckoutIdentifier(
      records,
      accountKey,
      job.plan,
      [boundIdentifier, historicalIdentifier],
      unidentifiedRecovery
    );
  }
  if (
    ownedProfile &&
    isBrowserProfileId(currentResult.browser_profile_id) &&
    currentResult.browser_profile_id !== ownedProfile.profileId
  ) {
    if (
      currentResult.browser_profile_missing_confirmed !== true ||
      currentResult.replaced_browser_profile_id !== ownedProfile.profileId
    )
      throw new ConflictException('本次任务已绑定另一比特窗口，不能覆盖原窗口');
    ownedProfile = { ...ownedProfile, profileId: currentResult.browser_profile_id };
  }
  const staleProfiles =
    job.action === 'bitbrowser'
      ? []
      : finished
          .map((item) => staleProfile(item))
          .filter((item): item is { sourceJobId: string; profileId: string } => Boolean(item));
  await repository.updateJob(tx, job.id, {
    accountKey,
    ...(ownedProfile || originalCheckoutIdentifier
      ? {
          result: toV2JsonDocument({
            ...currentResult,
            ...(ownedProfile ? { browser_profile_id: ownedProfile.profileId } : {}),
            ...(originalCheckoutIdentifier
              ? { checkout_identifier: originalCheckoutIdentifier }
              : {})
          })
        }
      : {})
  });
  return {
    ...(callback.subscriptionCycleProtocol === 1 && currentResult.client_cycle_protocol === 1
      ? { subscriptionCycleProtocol: 1 as const }
      : {}),
    ...(nextCycleContext ? { nextCycleContext } : {}),
    records: records.filter((record) => !record.fileKey.startsWith('history/')),
    staleProfiles,
    ...(ownedProfile ? { ownedProfile } : {}),
    ...(unidentifiedRecovery ? { unidentifiedCheckoutRecovery: true as const } : {}),
    ...(originalCheckoutIdentifier ? { originalCheckoutIdentifier } : {})
  };
}
