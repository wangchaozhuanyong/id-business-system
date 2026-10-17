import { ConfigService } from '@nestjs/config';
import { Prisma, type OnlineRechargeTask } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import type { PrismaService } from '../../common/prisma/prisma.service';
import { BankRechargeOnlineOrderService } from '../auto-recharge/public-api';
import { BankRechargeOnlineOrderRepository } from '../auto-recharge/persistence/bank-recharge-online-order.repository';
import { BankRechargeRepository } from '../auto-recharge/persistence/bank-recharge.repository';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  type V2CommandTransaction
} from '../runtime/public-api';
import type { OnlineRechargePaymentContext } from './contracts';
import type { OnlineRechargeEphemeralCredentials } from './ephemeral-credentials.service';
import { OnlineRechargeOrderSyncService } from './order-sync.service';
import { OnlineRechargeOrderSyncRepository } from './persistence/order-sync.repository';
import { OnlineRechargeRepository } from './persistence/online-recharge.repository';
import { OnlineRechargeSettingsRepository } from './persistence/settings.repository';
import { OnlineRechargeTasksRepository } from './persistence/tasks.repository';
import { OnlineRechargeWorkerRepository } from './persistence/worker.repository';
import { OnlineRechargeWorkerRpcRepository } from './persistence/worker-rpc.repository';
import { OnlineRechargeSettingsService } from './settings.service';
import { OnlineRechargeTasksService } from './tasks.service';
import { OnlineRechargeWorkerService } from './worker.service';

type Row = Record<string, unknown>;
type Query = {
  where?: Row;
  data?: Row;
  create?: Row;
  update?: Row;
  orderBy?: Row | Row[];
  take?: number;
};

/**
 * Only the Prisma storage boundary is replaced. Real task/RPC/worker/order services,
 * repositories, encryption, audit and command transaction manager run below.
 * This deliberately does not claim MySQL isolation, a browser or bank acceptance.
 */
function storageFixture() {
  const tables = new Map<string, Row[]>();
  const rows = (name: string) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  };
  const copy = <T>(value: T): T => {
    if (value instanceof Date) return new Date(value) as T;
    if (Prisma.Decimal.isDecimal(value)) return new Prisma.Decimal(String(value)) as T;
    if (Array.isArray(value)) return value.map(copy) as T;
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)])) as T;
    return value;
  };
  const matches = (row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([key, expected]) => {
      if (expected === undefined) return true;
      if (key === 'OR') return (expected as Row[]).some((condition) => matches(row, condition));
      if (key === 'AND') return (expected as Row[]).every((condition) => matches(row, condition));
      let actual = row[key];
      if (expected === null) return actual === null || actual === undefined;
      if (expected instanceof Date) return actual instanceof Date && +actual === +expected;
      if (!expected || typeof expected !== 'object') return actual === expected;
      const condition = expected as Row;
      if (condition.path) {
        actual = String(condition.path)
          .replace(/^\$\./, '')
          .split('.')
          .reduce<unknown>((value, part) => (value as Row | undefined)?.[part], actual);
      }
      return Object.entries(condition).every(([operator, value]) => {
        if (operator === 'path') return true;
        if (operator === 'equals') return actual === value;
        if (operator === 'in') return (value as unknown[]).includes(actual);
        if (operator === 'notIn') return !(value as unknown[]).includes(actual);
        if (operator === 'array_contains')
          return (
            Array.isArray(actual) && (value as unknown[]).every((item) => actual.includes(item))
          );
        if (operator === 'lt') return (actual as number) < (value as number);
        if (operator === 'lte') return (actual as number) <= (value as number);
        if (operator === 'gt') return (actual as number) > (value as number);
        throw new Error(`Unsupported isolated storage filter: ${operator}`);
      });
    });
  const patch = (row: Row, data: Row) => {
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      row[key] =
        value && typeof value === 'object' && 'increment' in value
          ? Number(row[key] ?? 0) + Number((value as Row).increment)
          : copy(value);
    }
    row.updatedAt = new Date();
    return row;
  };
  const relation = (name: string, row: Row) =>
    copy(
      name === 'onlineRechargeTask'
        ? {
            ...row,
            rechargeOrder:
              rows('idBusinessV2BankRechargeOrder').find(
                (order) => order.onlineRechargeTaskId === row.id
              ) ?? null,
            orderSync:
              rows('onlineRechargeOrderSync').find((queue) => queue.taskId === row.id) ?? null
          }
        : row
    );
  const defaults: Record<string, Row> = {
    onlineRechargeTask: {
      status: 'queued',
      progress: 0,
      stage: 'queued',
      paymentStarted: false,
      confirmedPaid: false,
      leaseVersion: 0,
      leaseOwner: null,
      leaseId: null,
      leaseExpiresAt: null,
      cardId: null,
      cardLast4: null,
      codeId: null,
      deletedAt: null,
      result: null,
      providerOrderId: null,
      providerTaskId: null,
      emailEncrypted: null
    },
    onlineRechargeOrderSync: { status: 'pending', attempts: 0, lastErrorCode: null },
    idBusinessV2ChatgptAccount: { status: 'active', deletedAt: null },
    idBusinessV2BankRechargeOrder: { manualEvidenceRef: null }
  };
  const unique: Record<string, string[]> = {
    onlineRechargeEvent: ['dedupeKey'],
    onlineRechargeBill: ['idempotencyKey'],
    onlineRechargeOrderSync: ['taskId'],
    idBusinessV2BankRechargeOrder: [
      'onlineRechargeTaskId',
      'paymentEvidenceId',
      'checkoutIdentifier',
      'orderNo'
    ],
    idBusinessV2ChatgptAccount: ['emailHash', 'officialAccountKey']
  };
  const model = (name: string) => {
    const find = (query: Query = {}) => rows(name).find((row) => matches(row, query.where));
    const create = async ({ data = {} }: Query) => {
      for (const key of ['id', ...(unique[name] ?? [])])
        if (data[key] != null && rows(name).some((row) => row[key] === data[key]))
          throw new Error(`Isolated unique constraint: ${name}.${key}`);
      const row = patch(
        {
          id: randomUUID(),
          createdAt: new Date(),
          updatedAt: new Date(),
          ...(name === 'onlineRechargeOrderSync' ? { nextAttemptAt: new Date() } : {}),
          ...copy(defaults[name] ?? {})
        },
        data
      );
      rows(name).push(row);
      return relation(name, row);
    };
    return {
      findUnique: async (query: Query) => {
        const row = find(query);
        return row ? relation(name, row) : null;
      },
      findFirst: async (query: Query) => {
        const row = find(query);
        return row ? relation(name, row) : null;
      },
      findMany: async (query: Query = {}) => {
        let selected = rows(name).filter((row) => matches(row, query.where));
        const orderBy = query.orderBy
          ? Array.isArray(query.orderBy)
            ? query.orderBy
            : [query.orderBy]
          : [];
        selected = selected.sort((a, b) => {
          for (const order of orderBy)
            for (const [key, direction] of Object.entries(order)) {
              if (a[key] === b[key]) continue;
              return (
                ((a[key] as number) < (b[key] as number) ? -1 : 1) * (direction === 'desc' ? -1 : 1)
              );
            }
          return 0;
        });
        return selected.slice(0, query.take).map((row) => relation(name, row));
      },
      count: async (query: Query = {}) =>
        rows(name).filter((row) => matches(row, query.where)).length,
      create,
      update: async ({ where, data = {} }: Query) => {
        const row = find({ where });
        if (!row) throw new Error(`Missing isolated row: ${name}`);
        return relation(name, patch(row, data));
      },
      updateMany: async ({ where, data = {} }: Query) => {
        const selected = rows(name).filter((row) => matches(row, where));
        selected.forEach((row) => patch(row, data));
        return { count: selected.length };
      },
      upsert: async ({ where, create: data, update = {} }: Query) => {
        const row = find({ where });
        return row ? relation(name, patch(row, update)) : create({ data });
      }
    };
  };
  const names = [
    'onlineRechargeTask',
    'onlineRechargeCard',
    'onlineRechargeConfig',
    'onlineRechargeCode',
    'onlineRechargeBill',
    'onlineRechargeEvent',
    'onlineRechargeAddress',
    'onlineRechargeOrderSync',
    'auditLog',
    'idBusinessV2RechargeProxy',
    'idBusinessV2BankRechargeCard',
    'idBusinessV2BankRechargeOrder',
    'idBusinessV2ChatgptAccount',
    'idBusinessV2ScopeVersion'
  ];
  const transactionOptions: unknown[] = [];
  let previous = Promise.resolve<unknown>(undefined);
  const client = Object.assign(Object.fromEntries(names.map((name) => [name, model(name)])), {
    $executeRaw: async () => 1,
    $queryRaw: async () => [{ locked: 1 }],
    $transaction: <T>(work: (tx: V2CommandTransaction) => Promise<T>, options: unknown) => {
      transactionOptions.push(options);
      const next = previous.then(async () => {
        const snapshot = copy([...tables.entries()]);
        try {
          return await work(client as unknown as V2CommandTransaction);
        } catch (error) {
          tables.clear();
          for (const [name, data] of snapshot) tables.set(name, data);
          throw error;
        }
      });
      previous = next.catch(() => undefined);
      return next;
    }
  });
  return { client, rows, transactionOptions };
}

function fixture() {
  const storage = storageFixture();
  const config = new ConfigService({
    FIELD_ENCRYPTION_KEY: 'synthetic-chain-encryption',
    HASH_SECRET: 'synthetic-chain-hash',
    ONLINE_RECHARGE_WORKER_KEY: 'synthetic-chain-worker-at-least-32-characters'
  });
  const encryption = new FieldEncryptionService(config);
  const accountId = randomUUID(),
    cardId = randomUUID();
  const operator = {
    id: randomUUID(),
    roles: ['admin'],
    permissions: ['id_business_v2.online_recharge.read', 'id_business_v2.online_recharge.manage']
  } as unknown as AuthenticatedUser;
  const session = JSON.stringify({
    accessToken: `fixture.${Buffer.from(JSON.stringify({ exp: 4102444800, 'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_user_id: accountId } })).toString('base64url')}.unused`,
    user: { id: accountId, email: 'chain-fixture@example.invalid' },
    sessionToken: 'synthetic-only-session-token',
    expires: '2100-01-01T00:00:00Z'
  });
  storage.rows('onlineRechargeConfig').push({
    id: 'global',
    version: 1,
    settings: {
      proxyCountryCode: 'PH',
      planRegionRoutingEnabled: true,
      cardMaxSubscriptionCount: 2,
      cardMaxDeclineCount: 3
    },
    secretsEncrypted: null
  });
  storage
    .rows('idBusinessV2RechargeProxy')
    .push({ id: randomUUID(), active: true, countryCode: 'PH' });
  storage.rows('onlineRechargeCard').push({
    id: cardId,
    last4: '4242',
    allowedPlans: ['pro_20x'],
    status: 'active',
    successCount: 0,
    declineCount: 0,
    holderName: 'Synthetic Fixture',
    paymentName: 'Synthetic Fixture',
    numberEncrypted: encryption.encrypt('4242424242424242'),
    numberHash: null,
    expiryMonth: 12,
    expiryYear: 2031,
    leaseOwner: null,
    leaseId: null,
    leaseVersion: 0,
    leaseExpiresAt: null,
    addressId: null,
    lastUsedAt: null
  });
  storage.rows('onlineRechargeAddress').push({
    id: randomUUID(),
    active: true,
    region: 'PH',
    country: 'US',
    street: '1 Synthetic Street',
    city: 'Synthetic',
    state: 'Oregon',
    postalCode: '97201',
    successCount: 0,
    createdAt: new Date()
  });
  const prisma = storage.client as unknown as PrismaService;
  const audit = new V2TransactionalAuditService();
  const repository = new OnlineRechargeRepository(
    {} as never,
    prisma,
    audit,
    new V2CommandTransactionManager(prisma)
  );
  const settings = new OnlineRechargeSettingsService(
    new OnlineRechargeSettingsRepository(repository, encryption)
  );
  const memory = {
    available: async (ids: string[]) => ids
  } as unknown as OnlineRechargeEphemeralCredentials;
  const orders = new BankRechargeOnlineOrderService(
    new BankRechargeRepository(prisma),
    new BankRechargeOnlineOrderRepository(),
    encryption,
    audit
  );
  const sync = new OnlineRechargeOrderSyncService(
    new OnlineRechargeOrderSyncRepository(repository, encryption, orders)
  );
  const tasksRepository = new OnlineRechargeTasksRepository(
    repository,
    settings,
    encryption,
    memory,
    sync
  );
  const tasks = new OnlineRechargeTasksService(tasksRepository);
  const workerRepository = new OnlineRechargeWorkerRepository(
    repository,
    settings,
    encryption,
    memory,
    sync
  );
  const worker = new OnlineRechargeWorkerService(
    new OnlineRechargeWorkerRpcRepository(
      {} as never,
      config,
      repository,
      workerRepository,
      settings,
      encryption,
      {} as never
    )
  );
  const rpc = (method: string, claim?: Row, args: Row = {}) =>
    worker.rpc(config.get<string>('ONLINE_RECHARGE_WORKER_KEY'), {
      method,
      taskId: claim?.id,
      workerId: 'chain-fixture',
      leaseId: claim?.leaseId,
      leaseVersion: claim?.leaseVersion,
      args: method === 'claimJob' ? { workerId: 'chain-fixture' } : args
    });
  const start = async (reserve = true) => {
    const task = await tasks.start(
      { session, plan: 'pro_20x', cardId, paymentLimit: { currency: 'PHP', maxAmount: '9990' } },
      operator
    );
    const claim = (await rpc('claimJob')) as Row;
    expect(claim.id).toBe(task.id);
    if (reserve) await rpc('reserveCard', claim);
    return claim;
  };
  const payment = (claim: Row) => {
    const checkoutId = `cs_live_${String(claim.id).replaceAll('-', '')}`;
    const context: OnlineRechargePaymentContext = {
      kind: 'initial',
      sourcePlan: 'free',
      targetPlan: 'pro_20x',
      accountId,
      cardId,
      cardLast4: '4242',
      amount: '8919.6400',
      currency: 'PHP',
      quoteId: `quote:${createHash('sha256').update(checkoutId).digest('hex').slice(0, 32)}`
    };
    return {
      context,
      recovery: {
        ...context,
        version: 1,
        checkoutId,
        processorEntity: 'openai',
        checkoutUrl: `https://chatgpt.com/checkout/openai/${checkoutId}`,
        source: { kind: 'official_checkout_response', checkoutId, processorEntity: 'openai' }
      },
      evidence: {
        ...context,
        verified: true,
        source: 'checkout',
        checkoutId,
        paymentReference: `pi_${String(claim.id).replaceAll('-', '')}`,
        countryCode: 'PH'
      },
      confirmation: {
        source: 'subscription',
        querySucceeded: true,
        verified: true,
        hasActiveSubscription: true,
        accountId,
        expectedAccountId: accountId,
        targetPlan: 'pro_20x',
        tierVerified: true,
        observedCanonicalPlan: 'pro_20x',
        observedPlan: 'pro_20x'
      }
    };
  };
  const submit = async (claim: Row) => {
    const value = payment(claim);
    await rpc('beforeExternalSubmit', claim, {
      paymentContext: value.context,
      checkoutRecovery: value.recovery
    });
    return value;
  };
  const recordPayment = async (claim: Row, value: ReturnType<typeof payment>) => {
    await rpc('recordCardUsage', claim, { cardId, paymentEvidence: value.evidence });
    return rpc('createBillingRecord', claim, {
      record: {
        status: 'success',
        amount: value.context.amount,
        amountSource: 'checkout',
        currency: 'PHP',
        checkoutId: value.recovery.checkoutId,
        paymentEvidence: value.evidence
      }
    });
  };
  const complete = (claim: Row, value: ReturnType<typeof payment>, overrides: Row = {}) =>
    rpc('completeJob', claim, {
      status: 'succeeded',
      result: {
        confirmedPaid: true,
        paymentEvidence: value.evidence,
        confirmation: value.confirmation,
        ...overrides
      }
    });
  const row = (claim: Row) =>
    storage
      .rows('onlineRechargeTask')
      .find((item) => item.id === claim.id)! as unknown as OnlineRechargeTask;
  const card = () => storage.rows('onlineRechargeCard')[0]!;
  return {
    storage,
    repository,
    encryption,
    accountId,
    cardId,
    operator,
    tasks,
    tasksRepository,
    sync,
    rpc,
    start,
    payment,
    submit,
    recordPayment,
    complete,
    row,
    card
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('本地后端链路验收（隔离存储，无官网、银行或数据库连接）', () => {
  it.each(['success', 'recover', 'unknown', 'readiness', 'prepared', 'refresh'] as const)(
    '真实Chromium任务子进程与实际API服务图贯通：%s',
    async (scene) => {
      type BrowserAcceptance = {
        directory: string;
        result: { status: string; result: Row; message: string };
        failure: string;
        metrics: Row;
        actions: { method: string; taskScoped: boolean; stage?: string }[];
      };
      const harness = createRequire(resolve(process.cwd(), 'package.json'))(
        resolve(
          process.cwd(),
          'src/id-business-v2/online-recharge/engine/test/recharge-flow-acceptance.test.cjs'
        )
      ) as {
        runSyntheticRecharge: (
          scene: string,
          options: {
            task: Row;
            cardFields: string;
            billingFields: string;
            sessionRefresh?: 'same-account' | 'wrong-account';
            outputDir?: string;
            diagnosticDelay?: { stage: 'verify'; milliseconds: number };
            rpc: (method: string, args: Row) => Promise<unknown>;
          }
        ) => Promise<BrowserAcceptance>;
      };
      const f = fixture(),
        claim = await f.start(false);
      const cardFields = {
        success: 'legacy-names',
        recover: 'legacy-placeholders',
        unknown: 'legacy-stable-nested',
        readiness: 'standard',
        prepared: 'prepared-visible-shadow',
        refresh: 'standard'
      }[scene];
      const billingFields = {
        success: 'legacy-names',
        recover: 'legacy-collapsed',
        unknown: 'legacy-testids',
        readiness: 'standard',
        prepared: 'standard',
        refresh: 'standard'
      }[scene];
      const actual = await harness.runSyntheticRecharge(
        ['prepared', 'refresh'].includes(scene) ? 'success' : scene,
        {
          task: claim,
          cardFields,
          billingFields,
          ...(scene === 'refresh' ? { sessionRefresh: 'same-account' as const } : {}),
          outputDir: resolve(
            process.cwd(),
            '../../.runtime/online-checkout-repair-20261018',
            `api-${scene}-${claim.id}`
          ),
          ...(scene === 'recover'
            ? { diagnosticDelay: { stage: 'verify' as const, milliseconds: 350 } }
            : {}),
          rpc: async (method, args) => {
            expect(args).toMatchObject({
              taskId: claim.id,
              leaseId: claim.leaseId,
              leaseVersion: claim.leaseVersion
            });
            // Network/browser allocation is the explicit synthetic boundary. All
            // card, payment, billing, task and order RPCs below use real services.
            if (method === 'getActiveProxy')
              return { proxy_url: 'http://proxy-fixture.invalid:8080' };
            const result = await f.rpc(method, claim, args);
            return method === 'getRuntimeConfig'
              ? {
                  ...(result as Row),
                  checkoutMode: 'api',
                  headful: false,
                  hcaptcha: {},
                  telegram: {}
                }
              : result;
          }
        }
      );
      expect(actual.failure).toBe('');
      expect(actual.metrics).toMatchObject({
        checkoutCreations: 1,
        checkoutDocuments: scene === 'recover' ? 2 : 1,
        initializations: 1,
        actualPaymentClicks: 1,
        trustedPaymentClicks: 1,
        paymentRequests: 1,
        cardReadBack: true,
        billingReadBack: true,
        cardFields,
        billingFields,
        billingOpens: billingFields === 'legacy-collapsed' ? 1 : 0,
        countryChoices: billingFields === 'legacy-collapsed' ? 1 : 0,
        renewalRequests: scene === 'unknown' ? 0 : 1,
        cookieLessRequests: 0,
        cardFrameDocuments: cardFields === 'legacy-stable-nested' ? 2 : 1,
        unexpectedNetwork: 0
      });
      expect(actual.metrics.formReadFailures).toEqual([]);
      if (scene === 'refresh') {
        expect(actual.metrics).toMatchObject({
          loginCookieVerified: 1,
          refreshedAuthResponses: 1,
          originalBearerRequests: 0
        });
        expect(actual.metrics.refreshedBearerRequests).toBeGreaterThanOrEqual(2);
      }
      if (scene === 'prepared') {
        expect(actual.metrics).toMatchObject({
          loginCookieVerified: 1,
          checkboxClicks: 1,
          checkboxCleared: true,
          cardMounts: 1,
          animationCallbacks: 0
        });
        expect(actual.metrics.preparationScrolls).toBeGreaterThan(0);
        expect(actual.metrics.emptyCardRecordingCaptures).toBeGreaterThan(0);
        expect(actual.metrics.filledCardRecordingCaptures).toBeGreaterThan(0);
      }
      if (scene === 'readiness') {
        expect(actual.metrics).toMatchObject({
          loginCookieVerified: 1,
          checkboxClicks: 1,
          checkboxCleared: true,
          checkoutDomContentLoaded: 0,
          pendingModuleRequests: 1,
          readinessProof: {
            domContentLoadedAtPayment: 0,
            pageDomContentLoadedAtPayment: 0,
            documentReadyStateAtPayment: 'interactive',
            hiddenCloudflareResidueAtPayment: true
          }
        });
      }
      if (['readiness', 'prepared', 'refresh'].includes(scene))
        expect(actual.result.result).toMatchObject({
          success: true,
          confirmedPaid: true,
          paymentEvidence: { verified: true, amount: '8919.64', currency: 'PHP' },
          confirmation: { verified: true, observedCanonicalPlan: 'pro_20x' }
        });
      if (scene === 'recover')
        expect(actual.metrics.injectedReadDelay).toEqual({
          stage: 'verify',
          frame: 'captcha',
          milliseconds: 350
        });
      expect(
        actual.actions.filter(
          (action) => action.method === 'beforeExternalSubmit' && action.stage === 'payment_submit'
        )
      ).toHaveLength(1);
      expect(
        actual.actions.filter(
          (action) => action.method === 'beforeExternalSubmit' && action.stage === 'renewal_update'
        )
      ).toHaveLength(scene === 'unknown' ? 0 : 1);
      expect(actual.actions.every((action) => action.taskScoped)).toBe(true);
      // Exact production parent-worker projection (worker.cjs completeJob):
      // only the actual child's result supplies payment and subscription proof.
      await f.rpc('completeJob', claim, {
        status: actual.result.status,
        result: actual.result.result,
        message: actual.result.message,
        definitiveFailure: actual.result.result.definitiveFailure === true,
        confirmedPaid: actual.result.result.confirmedPaid === true,
        evidence: []
      });
      await f.sync.processPending();
      expect(f.row(claim).paymentStarted).toBe(true);
      if (scene === 'unknown') {
        expect(actual.result.status).toBe('awaiting_review');
        expect(actual.metrics.duplicateAdmissionBlocked).toBe(true);
        expect(f.row(claim)).toMatchObject({ status: 'awaiting_review', confirmedPaid: false });
        expect(f.storage.rows('onlineRechargeBill')).toHaveLength(0);
        expect(f.storage.rows('idBusinessV2BankRechargeOrder')).toHaveLength(0);
        expect(f.card()).toMatchObject({ successCount: 0, declineCount: 0 });
        await expect(f.start(false)).rejects.toThrow('先核对原任务');
      } else {
        expect(actual.result.status).toBe('succeeded');
        expect(actual.result.result.autoRenewCancellation).toEqual({ ok: true });
        expect(f.row(claim)).toMatchObject({ status: 'succeeded', confirmedPaid: true });
        expect(f.storage.rows('onlineRechargeBill')).toHaveLength(1);
        expect(f.storage.rows('idBusinessV2BankRechargeOrder')).toHaveLength(1);
        if (['readiness', 'prepared', 'refresh'].includes(scene)) {
          const bill = f.storage.rows('onlineRechargeBill')[0]!;
          expect(bill).toMatchObject({
            taskId: claim.id,
            status: 'success',
            currency: 'PHP',
            cardId: f.cardId
          });
          expect(new Prisma.Decimal(String(bill.amount)).equals('8919.64')).toBe(true);
        }
        const order = f.storage.rows('idBusinessV2BankRechargeOrder')[0]!;
        expect(order).toMatchObject({
          onlineRechargeTaskId: claim.id,
          onlineRechargeCardId: f.cardId,
          plan: 'pro-20x',
          chargeCurrencyCode: 'PHP',
          financeStatus: 'unposted'
        });
        expect(new Prisma.Decimal(String(order.chargeAmount)).equals('8919.64')).toBe(true);
        expect(f.card()).toMatchObject({ successCount: 1, declineCount: 0 });
      }
      await expect(
        f.rpc('completeJob', claim, { status: actual.result.status, result: actual.result.result })
      ).rejects.toThrow('租约失效');
      await f.sync.processPending();
      expect(f.storage.rows('onlineRechargeBill')).toHaveLength(scene === 'unknown' ? 0 : 1);
      expect(f.storage.rows('idBusinessV2BankRechargeOrder')).toHaveLength(
        scene === 'unknown' ? 0 : 1
      );
      expect(f.card()).toMatchObject({
        successCount: scene === 'unknown' ? 0 : 1,
        declineCount: 0
      });
      await writeFile(
        resolve(actual.directory, 'backend-acceptance.json'),
        JSON.stringify(
          {
            scene,
            cardFields,
            billingFields,
            ...(scene === 'prepared'
              ? {
                  cardPreparation: {
                    mounts: actual.metrics.cardMounts,
                    scrolls: actual.metrics.preparationScrolls,
                    emptyCardCaptures: actual.metrics.emptyCardRecordingCaptures,
                    filledCardCaptures: actual.metrics.filledCardRecordingCaptures,
                    animationCallbacks: actual.metrics.animationCallbacks,
                    paymentRequests: actual.metrics.paymentRequests
                  }
                }
              : {}),
            taskId: claim.id,
            backendEntry:
              'TasksService → WorkerService/RpcRepository → WorkerRepository → OrderSyncService/Repository → BankRechargeOnlineOrderService/Repository',
            taskStatus: f.row(claim).status,
            paymentStarted: f.row(claim).paymentStarted,
            confirmedPaid: f.row(claim).confirmedPaid,
            bills: f.storage.rows('onlineRechargeBill').map((bill) => ({
              taskId: bill.taskId,
              status: bill.status,
              amount: String(bill.amount),
              currency: bill.currency
            })),
            orders: f.storage.rows('idBusinessV2BankRechargeOrder').map((order) => ({
              sourceTaskId: order.onlineRechargeTaskId,
              plan: order.plan,
              amount: String(order.chargeAmount),
              currency: order.chargeCurrencyCode,
              status: order.status,
              financeStatus: order.financeStatus
            })),
            cardSuccessCount: f.card().successCount,
            cardDeclineCount: f.card().declineCount,
            lateDuplicateCompletionRejected: true,
            storageBoundary:
              'in-memory Prisma substitute; real command transaction manager and business services',
            workerSchedulerCovered: false,
            productionUsed: false,
            realPaymentUsed: false
          },
          null,
          2
        ) + '\n',
        { mode: 0o600 }
      );
    },
    60000
  );

  it('实际任务、内部RPC、提交保护、账单、共享卡计数和实际订单服务串联成功', async () => {
    const network = vi.fn(() => {
      throw new Error('External requests are forbidden in isolated acceptance');
    });
    vi.stubGlobal('fetch', network);
    const f = fixture(),
      claim = await f.start(),
      paid = await f.submit(claim);
    expect(f.row(claim)).toMatchObject({ paymentStarted: true, stage: 'payment_submitted' });
    const payload = f.row(claim).payload as Row;
    expect(payload.checkoutRecoveryEncrypted).not.toBe(JSON.stringify(paid.recovery));
    expect(
      JSON.parse(f.encryption.decrypt(String(payload.checkoutRecoveryEncrypted))!)
    ).toMatchObject(paid.recovery);
    await f.recordPayment(claim, paid);
    expect(await f.complete(claim, paid)).toMatchObject({ status: 'succeeded' });
    await f.sync.processPending();
    expect(f.row(claim)).toMatchObject({
      status: 'succeeded',
      confirmedPaid: true,
      plan: 'pro_20x'
    });
    expect(f.card()).toMatchObject({ successCount: 1, declineCount: 0, leaseOwner: null });
    const bills = f.storage.rows('onlineRechargeBill'),
      orders = f.storage.rows('idBusinessV2BankRechargeOrder');
    expect(bills).toHaveLength(1);
    expect(new Prisma.Decimal(String(bills[0]!.amount)).equals('8919.64')).toBe(true);
    expect(bills[0]).toMatchObject({
      taskId: claim.id,
      status: 'success',
      currency: 'PHP',
      cardId: f.cardId
    });
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      onlineRechargeTaskId: claim.id,
      onlineRechargeCardId: f.cardId,
      plan: 'pro-20x',
      chargeCurrencyCode: 'PHP',
      status: 'pending_details',
      financeStatus: 'unposted',
      paymentEvidenceId: paid.evidence.paymentReference
    });
    expect(new Prisma.Decimal(String(orders[0]!.chargeAmount)).equals('8919.6400')).toBe(true);
    expect(f.storage.rows('idBusinessV2ChatgptAccount')).toHaveLength(1);
    expect(f.storage.rows('onlineRechargeOrderSync')[0]).toMatchObject({ status: 'synced' });
    expect(f.storage.transactionOptions).toEqual(
      expect.arrayContaining([expect.objectContaining({ isolationLevel: 'Serializable' })])
    );
    expect(network).not.toHaveBeenCalled();
  });

  it('并发重复回执和终态迟到回执只生成一张账单、一个订单和一次共享卡计数', async () => {
    const f = fixture(),
      claim = await f.start(),
      paid = await f.submit(claim);
    await expect(f.submit(claim)).rejects.toThrow('禁止再次');
    await Promise.all([f.recordPayment(claim, paid), f.recordPayment(claim, paid)]);
    await f.complete(claim, paid);
    await expect(f.complete(claim, paid)).rejects.toThrow('任务租约失效');
    await f.sync.processPending();
    await f.sync.enqueue(String(claim.id), f.operator);
    await f.sync.processPending();
    expect(f.storage.rows('onlineRechargeBill')).toHaveLength(1);
    expect(f.storage.rows('idBusinessV2BankRechargeOrder')).toHaveLength(1);
    expect(
      f.storage
        .rows('onlineRechargeEvent')
        .filter((event) => String(event.dedupeKey).endsWith(':recordCardUsage'))
    ).toHaveLength(1);
    expect(f.card()).toMatchObject({ successCount: 1, declineCount: 0 });
    expect(
      f.storage
        .rows('auditLog')
        .filter(
          (event) => event.action === 'id_business_v2.online_recharge.worker.payment_submitted'
        )
    ).toHaveLength(1);
  });

  it.each(['missing', 'amount', 'currency', 'account', 'quote'] as const)(
    '付款证据%s不足或冲突，不生成成功账单、订单或卡计数',
    async (fault) => {
      const f = fixture(),
        claim = await f.start(),
        paid = await f.submit(claim);
      const evidence: Row | undefined =
        fault === 'missing'
          ? undefined
          : {
              ...paid.evidence,
              ...(fault === 'amount' ? { amount: '8919.65' } : {}),
              ...(fault === 'currency' ? { currency: 'USD' } : {}),
              ...(fault === 'account' ? { accountId: randomUUID() } : {}),
              ...(fault === 'quote' ? { quoteId: 'quote:another-original' } : {})
            };
      await expect(
        f.rpc('recordCardUsage', claim, { cardId: f.cardId, paymentEvidence: evidence })
      ).rejects.toThrow('不能记录');
      await expect(
        f.rpc('createBillingRecord', claim, {
          record: {
            status: 'success',
            amount: '8919.64',
            amountSource: 'checkout',
            currency: 'PHP',
            paymentEvidence: evidence
          }
        })
      ).rejects.toThrow('不能生成');
      expect(await f.complete(claim, paid, { paymentEvidence: evidence })).toMatchObject({
        status: 'awaiting_review'
      });
      await f.sync.processPending();
      expect(f.row(claim)).toMatchObject({ paymentStarted: true, confirmedPaid: false });
      expect(f.card()).toMatchObject({ successCount: 0, declineCount: 0 });
      expect(f.storage.rows('onlineRechargeBill')).toHaveLength(0);
      expect(f.storage.rows('idBusinessV2BankRechargeOrder')).toHaveLength(0);
      await expect(f.start()).rejects.toThrow('先核对原任务');
    }
  );

  it('已付款但套餐延迟，原单只读核对到准确Pro200后幂等补齐原账单、原卡计数及订单', async () => {
    const f = fixture(),
      claim = await f.start(),
      paid = await f.submit(claim);
    expect(
      await f.complete(claim, paid, {
        confirmation: { ...paid.confirmation, verified: false, observedCanonicalPlan: 'pro_5x' }
      })
    ).toMatchObject({ status: 'awaiting_review' });
    expect(f.row(claim)).toMatchObject({ confirmedPaid: true, stage: 'paid_pending_activation' });
    expect(f.storage.rows('onlineRechargeOrderSync')).toHaveLength(0);
    expect(f.card().successCount).toBe(0);
    const schedule = (f.row(claim).payload as Row).reconciliation as Row;
    expect(
      await f.tasksRepository.processDueRechecks(new Date(String(schedule.nextAttemptAt)))
    ).toMatchObject({ enqueued: 1 });
    const recheck = (await f.rpc('claimJob')) as Row;
    expect(recheck).toMatchObject({
      operation: 'subscription',
      plan: 'pro_20x',
      payload: { recheckTaskId: claim.id, automaticRecheck: true }
    });
    expect(await f.rpc('getCheckoutRecovery', recheck)).toMatchObject({
      checkoutRecovery: paid.recovery
    });
    await expect(
      f.rpc('beforeExternalSubmit', recheck, {
        paymentContext: paid.context,
        checkoutRecovery: paid.recovery
      })
    ).rejects.toThrow('预约当前任务');
    await f.complete(recheck, paid);
    await f.sync.processPending();
    expect(f.row(claim)).toMatchObject({
      status: 'succeeded',
      confirmedPaid: true,
      stage: 'rechecked'
    });
    expect(f.card()).toMatchObject({ successCount: 1, declineCount: 0, leaseOwner: null });
    expect(f.storage.rows('onlineRechargeBill')).toHaveLength(1);
    expect(f.storage.rows('onlineRechargeBill')[0]).toMatchObject({
      taskId: claim.id,
      status: 'success',
      currency: 'PHP'
    });
    expect(f.storage.rows('idBusinessV2BankRechargeOrder')).toHaveLength(1);
    expect(f.storage.rows('idBusinessV2BankRechargeOrder')[0]!.onlineRechargeTaskId).toBe(claim.id);
    expect(
      await f.tasksRepository.processDueRechecks(new Date(Date.now() + 3600000))
    ).toMatchObject({ enqueued: 0 });
    await expect(f.complete(recheck, paid)).rejects.toThrow('租约失效');
    await f.sync.processPending();
    expect(f.card().successCount).toBe(1);
    expect(f.storage.rows('onlineRechargeBill')).toHaveLength(1);
  });

  it('填表失败且尚未付款，只保留失败账单，拒付和成功卡计数都不增加', async () => {
    const f = fixture(),
      claim = await f.start();
    await f.rpc('createBillingRecord', claim, {
      record: {
        status: 'failed',
        amount: null,
        currency: 'PHP',
        error_code: 'CHECKOUT_FORM_TIMEOUT'
      }
    });
    expect(
      await f.rpc('failJob', claim, {
        status: 'failed',
        definitiveFailure: true,
        result: { success: false, confirmedPaid: false, errorCode: 'CHECKOUT_FORM_TIMEOUT' }
      })
    ).toMatchObject({ status: 'failed' });
    await f.sync.processPending();
    expect(f.row(claim)).toMatchObject({
      paymentStarted: false,
      confirmedPaid: false,
      status: 'failed'
    });
    expect(f.storage.rows('onlineRechargeBill')[0]).toMatchObject({
      status: 'failed',
      amount: null
    });
    expect(f.card()).toMatchObject({ successCount: 0, declineCount: 0, leaseOwner: null });
    expect(
      f.storage
        .rows('onlineRechargeEvent')
        .filter((event) => String(event.dedupeKey).endsWith(':recordCardDecline'))
    ).toHaveLength(0);
    expect(f.storage.rows('idBusinessV2BankRechargeOrder')).toHaveLength(0);
  });
});
