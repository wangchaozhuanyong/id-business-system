import { randomUUID } from 'node:crypto';
import type { IdBusinessV2RechargeJob } from '@prisma/client';
import { vi } from 'vitest';
import { RechargeRepository } from './persistence/recharge.repository';
import { RechargeService } from './recharge.service';
import { RechargeLocalService } from './recharge-local.service';
import { hash, object } from './recharge-validation';
import { rechargeDocumentDigest } from './recharge-callback-receipts';
import type { CycleRecord } from './recharge-cycle-state';

export function cyclePaidDocument(accountKey: string, checkout = 'cs_old', period = true) {
  const quote = {
    plan: 'plus',
    today: { amount: '20.00', amount_minor: 2000, currency: 'USD' },
    tax: { amount: '0.00', amount_minor: 0, currency: 'USD' },
    renewal: { amount: '20.00', amount_minor: 2000, currency: 'USD' },
    renewal_interval: 'monthly'
  };
  return {
    account_key: accountKey,
    target_plan: 'plus',
    checkout_identifier: checkout,
    status: 'subscription_activated',
    subscription_status: 'plus',
    current_plan: 'plus',
    quote,
    quote_digest: rechargeDocumentDigest(quote),
    payment_status: 'paid',
    payment_attempted: true,
    confirmation_requests_sent: 1,
    payment_requests_sent: 1,
    payment_evidence: {
      kind: 'checkout_session',
      identifier: checkout,
      amount_minor: 2000,
      currency: 'USD'
    },
    ...(period
      ? {
          subscription_period: {
            source: 'official_subscription_response',
            start: new Date(Date.now() - 32 * 86400000).toISOString(),
            end: new Date(Date.now() - 2 * 86400000).toISOString(),
            account_key: accountKey,
            target_plan: 'plus'
          }
        }
      : {})
  } as Record<string, unknown>;
}

export function cycleFixture(period = true, targetPlan = 'plus', syntheticAccountId?: string) {
  const id = randomUUID(),
    ownerId = randomUUID(),
    accountKey = hash(syntheticAccountId ?? randomUUID());
  const token = 'synthetic-local-token-' + randomUUID();
  const operator = {
    id: ownerId,
    username: 'cycle',
    displayName: '周期合成',
    roles: ['admin'],
    permissions: []
  };
  const document = cyclePaidDocument(accountKey, 'cs_old_' + id.replaceAll('-', ''), period);
  const records: CycleRecord[] = [
    {
      ownerId,
      accountKey,
      fileKey: accountKey + '.json',
      revision: 2,
      document: structuredClone(document)
    },
    {
      ownerId,
      accountKey,
      fileKey: 'payments/' + hash(String(document.checkout_identifier)) + '.json',
      revision: 3,
      document: structuredClone(document)
    }
  ];
  const job = {
    id,
    ownerId,
    accountKey,
    action: 'bitbrowser',
    plan: targetPlan,
    state: 'running',
    nonceHash: hash(token),
    leaseUntil: new Date(Date.now() + 45 * 60000),
    createdAt: new Date(),
    result: {
      mode: 'payment',
      client_cycle_protocol: 1,
      payment_attempted: false,
      payment_requests_sent: 0
    }
  } as unknown as IdBusinessV2RechargeJob;
  const jobs = [job];
  const jobTable = {
    findUnique: vi.fn(
      async ({ where }: { where: { id: string } }) =>
        jobs.find((item) => item.id === where.id) ?? null
    ),
    findMany: vi.fn(
      async ({
        where
      }: {
        where: { id?: { not: string }; action?: string; state?: string; plan?: string };
      }) =>
        jobs.filter(
          (item) =>
            item.id !== where.id?.not &&
            (!where.action || item.action === where.action) &&
            (!where.state || item.state === where.state) &&
            (!where.plan || item.plan === where.plan)
        )
    ),
    findFirst: vi.fn(async () => null),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: object }) => {
      const target = jobs.find((item) => item.id === where.id)!;
      Object.assign(target, data);
      return target;
    })
  };
  const recordTable = {
    findMany: vi.fn(async () => records),
    findUnique: vi.fn(
      async ({ where }: { where: { accountKey_fileKey: { fileKey: string } } }) =>
        records.find((item) => item.fileKey === where.accountKey_fileKey.fileKey) ?? null
    ),
    create: vi.fn(async ({ data }: { data: CycleRecord }) => {
      records.push(structuredClone(data));
      return data;
    }),
    update: vi.fn(
      async ({
        where,
        data
      }: {
        where: { accountKey_fileKey: { fileKey: string } };
        data: { revision: { increment: number }; document: unknown };
      }) => {
        const target = records.find((item) => item.fileKey === where.accountKey_fileKey.fileKey)!;
        target.revision += data.revision.increment;
        target.document = data.document;
        return target;
      }
    ),
    upsert: vi.fn(
      async ({
        where,
        create,
        update
      }: {
        where: { accountKey_fileKey: { fileKey: string } };
        create: CycleRecord;
        update: { revision: number; document: unknown };
      }) => {
        const target = records.find((item) => item.fileKey === where.accountKey_fileKey.fileKey);
        if (target) {
          Object.assign(target, update);
          return target;
        }
        records.push(create);
        return create;
      }
    )
  };
  const tx = { idBusinessV2RechargeJob: jobTable, idBusinessV2RechargeRecord: recordTable };
  const repository = new RechargeRepository({} as never);
  vi.spyOn(repository, 'lock').mockResolvedValue();
  const audit = { append: vi.fn() };
  const transactions = {
    execute: vi.fn(async (work: (value: typeof tx) => unknown) => {
      const beforeRecords = structuredClone(records),
        beforeJobs = structuredClone(jobs);
      try {
        return await work(tx);
      } catch (error) {
        records.splice(0, records.length, ...beforeRecords);
        jobs.forEach((item, index) => Object.assign(item, beforeJobs[index]));
        throw error;
      }
    })
  };
  const service = new RechargeService(
    repository,
    {} as never,
    transactions as never,
    audit as never
  );
  const local = new RechargeLocalService(
    repository,
    {} as never,
    {} as never,
    service,
    transactions as never,
    audit as never
  );
  const callback = (value: unknown) => local.callback(id, token, value);
  const inspection = (patch: Record<string, unknown> = {}) => ({
    source: 'official_account_response',
    account_key: accountKey,
    account_matched: true,
    current_plan: 'free',
    has_active_subscription: false,
    checked_at: new Date(Date.now() - 10).toISOString(),
    ...patch
  });
  const prepare = (phase: string, patch: Record<string, unknown> = {}) =>
    callback({
      type: 'prepare_next_subscription_cycle',
      subscriptionCycleProtocol: 1,
      accountKey,
      phase,
      ...patch
    });
  const marker = () => {
    const state = object(object(job.result)._subscription_cycle_private_v1);
    const grant = object(state.grant);
    return {
      type: 'ledger',
      accountKey,
      fileKey: grant.checkoutFileKey,
      revision: grant.checkoutRevision,
      document: {
        status: 'checkout_attempted',
        stage: 'checkout_create',
        run_id: 'a'.repeat(32),
        checkout_outcome: 'unknown',
        payment_status: 'not_attempted',
        target_plan: targetPlan,
        current_plan_before: 'free',
        account_matched: true,
        next_cycle_grant: {
          protocol: 1,
          jobId: id,
          accountKey,
          targetPlan,
          reviewDigest: grant.reviewDigest
        }
      }
    };
  };
  return {
    id,
    ownerId,
    accountKey,
    token,
    operator,
    job,
    jobs,
    records,
    document,
    repository,
    tx,
    audit,
    local,
    service,
    callback,
    inspection,
    prepare,
    marker,
    jobTable,
    recordTable
  };
}
