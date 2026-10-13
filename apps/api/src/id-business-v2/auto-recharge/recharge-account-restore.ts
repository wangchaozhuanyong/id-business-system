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
      [boundIdentifier]
    );
    let historicalIdentifier = await repository.originalCheckoutForAccount(
      tx,
      job.ownerId,
      accountKey,
      job.plan,
      job.id
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
        persistedIdentifier
      );
    }
    originalCheckoutIdentifier = repository.restoreCheckoutIdentifier(
      records,
      accountKey,
      job.plan,
      [boundIdentifier, historicalIdentifier]
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
    records,
    staleProfiles,
    ...(ownedProfile ? { ownedProfile } : {}),
    ...(originalCheckoutIdentifier ? { originalCheckoutIdentifier } : {})
  };
}
