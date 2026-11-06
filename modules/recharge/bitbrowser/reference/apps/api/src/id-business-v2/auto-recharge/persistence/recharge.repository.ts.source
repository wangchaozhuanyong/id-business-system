import { resolvedDeclinedPayment, resolvedDeclinedCheckout } from '../recharge-noncharge-proof';
import {
  isUnidentifiedUnpaidCheckout,
  isUnidentifiedCheckoutMarker
} from '../recharge-unidentified-checkout';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { acquireMysqlTransactionLock } from '../../../common/prisma/mysql-transaction-lock';
import { toV2JsonDocument, type V2CommandTransaction } from '../../runtime/public-api';
import type { IdBusinessV2RechargeJob, Prisma } from '@prisma/client';
import { assertEmployeeBusinessWriter } from '../../../v2-auth/system-super-admin';
import { hash, object } from '../recharge-validation';
import { isRechargeUpgrade, rechargeOperationIdentifier } from '../recharge-upgrade-protocol';
import { rechargeDocumentDigest } from '../recharge-callback-receipts';
import { isClosedCycleDocument } from '../recharge-cycle-state';
import { manualRechargeSettlement } from '../recharge-manual-settlement-proof';
import { preserveRechargeResolutionMetadata } from '../recharge-ledger-metadata';
import { hasOfficialTerminalNoncharge } from '../recharge-terminal-failure';
import { assertUnpaidCheckoutRecoverySources } from '../recharge-checkout-recovery';
import { createCycleArchive, closeCycleRecord, closeCycleJobs } from './recharge-cycle.repository';
import {
  findOriginalRechargeCheckout,
  findRetainedRechargeBrowserProfile,
  rechargeCheckoutIdentifier
} from '../recharge-job-helpers';

@Injectable()
export class RechargeRepository {
  constructor(private readonly prisma: PrismaService) {}

  list(ownerId: string) {
    return this.prisma.idBusinessV2RechargeJob.findMany({
      where: { ownerId },
      orderBy: { createdAt: 'desc' },
      take: 30
    });
  }

  verificationCandidates(ownerId: string, accountKeys: string[]) {
    return this.prisma.idBusinessV2RechargeJob.findMany({
      where: {
        ownerId,
        accountKey: { in: accountKeys },
        state: 'finished',
        AND: [
          { result: { path: '$.account_matched', equals: true } },
          { result: { path: '$.current_plan', equals: 'free' } }
        ]
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 200
    });
  }

  async reviewPage(ownerId: string, options: { page: number; pageSize: number; search: string }) {
    const where: Prisma.IdBusinessV2RechargeJobWhereInput = {
      ownerId,
      ...(options.search
        ? {
            OR: [
              { id: { contains: options.search } },
              { result: { path: '$.window_name', string_contains: options.search } }
            ]
          }
        : {})
    };
    const [items, total] = await Promise.all([
      this.prisma.idBusinessV2RechargeJob.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: options.pageSize,
        skip: (options.page - 1) * options.pageSize
      }),
      this.prisma.idBusinessV2RechargeJob.count({ where })
    ]);
    return { items, total };
  }

  async owned(id: string, ownerId: string) {
    const job = await this.prisma.idBusinessV2RechargeJob.findFirst({ where: { id, ownerId } });
    if (!job) throw new NotFoundException('找不到本人的执行记录');
    return job;
  }

  async byId(id: string) {
    const job = await this.prisma.idBusinessV2RechargeJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundException('找不到执行记录');
    return job;
  }

  // Serializes short bookkeeping transactions, never the lifetime of browser tasks.
  async lock(tx: V2CommandTransaction) {
    await acquireMysqlTransactionLock(tx, 'auto-recharge-single-worker');
  }

  findJob(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2RechargeJob.findUnique({ where: { id } });
  }

  finishedJobsForAccount(
    tx: V2CommandTransaction,
    ownerId: string,
    accountKey: string,
    excludeId: string
  ) {
    return tx.idBusinessV2RechargeJob.findMany({
      where: {
        ownerId,
        accountKey,
        state: 'finished',
        id: { not: excludeId }
      },
      orderBy: { createdAt: 'desc' },
      take: 30
    });
  }

  async finishedJobsForUnidentifiedCheckout(
    tx: V2CommandTransaction,
    ownerId: string,
    accountKey: string,
    excludeId: string
  ) {
    const history: IdBusinessV2RechargeJob[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    // 唯一建单来源和窗口替换链必须以完整历史核实，不能使用列表的截断结果。
    for (let page = 0; page < 30; page += 1) {
      const jobs = await tx.idBusinessV2RechargeJob.findMany({
        where: {
          ownerId,
          accountKey,
          action: 'bitbrowser',
          state: 'finished',
          id: { not: excludeId }
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 30,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
      });
      for (const job of jobs) {
        if (seen.has(job.id)) throw new ConflictException('原结算历史存在重复记录，禁止恢复原窗口');
        seen.add(job.id);
        history.push(job);
      }
      if (jobs.length < 30) return history;
      cursor = jobs.at(-1)!.id;
    }
    throw new ConflictException('原结算历史尚未完整核验，禁止恢复原窗口');
  }

  async retainedProfileForAccount(
    tx: V2CommandTransaction,
    ownerId: string,
    accountKey: string,
    excludeId: string,
    allowDeletedProfile = false,
    connectionApiKey?: string,
    connectionProfileId?: string | null
  ) {
    let cursor: string | undefined;
    // 窗口归属不受列表的30条限制。查询有界，未查完时拒绝把未知当作可新建。
    for (let page = 0; page < 30; page += 1) {
      const jobs = await tx.idBusinessV2RechargeJob.findMany({
        where: {
          ownerId,
          accountKey,
          action: 'bitbrowser',
          state: 'finished',
          id: { not: excludeId }
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 30,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
      });
      const profile = findRetainedRechargeBrowserProfile(
        jobs.filter((job) => {
          const metadata = job.result as Record<string, unknown>;
          return (
            !connectionApiKey ||
            (metadata.connection_api_key
              ? metadata.connection_api_key === connectionApiKey
              : !connectionProfileId)
          );
        }),
        ownerId,
        accountKey,
        allowDeletedProfile
      );
      if (profile) return profile;
      if (jobs.length < 30) return undefined;
      cursor = jobs.at(-1)!.id;
    }
    throw new ConflictException('原窗口历史尚未完整核验，禁止自动创建新窗口');
  }

  async originalCheckoutForAccount(
    tx: V2CommandTransaction,
    ownerId: string,
    accountKey: string,
    plan: string,
    excludeId: string,
    unpaidRecoveryIdentifier?: string,
    unidentifiedSourceJobId?: string,
    expiredCheckoutIdentifiers: string[] = [],
    unidentifiedPredecessorJobIds: string[] = []
  ) {
    let cursor: string | undefined;
    for (let page = 0; page < 30; page += 1) {
      const jobs = await tx.idBusinessV2RechargeJob.findMany({
        where: {
          ownerId,
          accountKey,
          plan,
          action: 'bitbrowser',
          ...(!unpaidRecoveryIdentifier ? { state: 'finished' as const } : {}),
          id: { not: excludeId }
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 30,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
      });
      if (unpaidRecoveryIdentifier) {
        assertUnpaidCheckoutRecoverySources(jobs, ownerId, accountKey, plan);
      } else {
        const identifier = findOriginalRechargeCheckout(
          jobs.filter((job) => {
            if (isClosedCycleDocument(job.result, accountKey)) return false;
            if (
              unidentifiedSourceJobId &&
              expiredCheckoutIdentifiers.length &&
              unidentifiedPredecessorJobIds.includes(job.id) &&
              isUnidentifiedUnpaidCheckout(job.result)
            )
              return false;
            if (
              !expiredCheckoutIdentifiers.length ||
              (job.id === unidentifiedSourceJobId && isUnidentifiedUnpaidCheckout(job.result))
            )
              return true;
            const result =
              job.result && typeof job.result === 'object' && !Array.isArray(job.result)
                ? object(job.result)
                : {};
            return !expiredCheckoutIdentifiers.includes(String(rechargeCheckoutIdentifier(result)));
          }),
          ownerId,
          accountKey,
          plan,
          unidentifiedSourceJobId
        );
        if (identifier) return identifier;
      }
      if (jobs.length < 30) return unpaidRecoveryIdentifier;
      cursor = jobs.at(-1)!.id;
    }
    throw new ConflictException('原订单历史尚未完整核验，禁止自动创建新订单');
  }

  restoreCheckoutIdentifier(
    records: { fileKey: string; revision: number; document: unknown }[],
    accountKey: string,
    plan: string,
    expected: (string | undefined)[],
    allowUnidentified = false
  ) {
    const fileKey = `${accountKey}${plan === 'plus' ? '' : `-${plan}`}.json`;
    const current = records.filter(
      (item) =>
        !item.fileKey.startsWith('history/') && !isClosedCycleDocument(item.document, accountKey)
    );
    const record = current.find((item) => item.fileKey === fileKey);
    const identifiers = expected.filter((value): value is string => value !== undefined);
    for (const item of current.filter((value) => value.fileKey.startsWith('payments/'))) {
      if (resolvedDeclinedPayment(item.document)) continue;
      if (!item.document || typeof item.document !== 'object' || Array.isArray(item.document))
        throw new ConflictException('原付款记录未核实，禁止创建新订单');
      const payment = item.document as Record<string, unknown>;
      if ((payment.target_plan ?? 'plus') !== plan) continue;
      const identifier = rechargeCheckoutIdentifier(payment);
      if (identifier) identifiers.push(identifier);
    }
    if (!record) {
      if (identifiers.length) throw new ConflictException('原订单持久化记录缺失，禁止创建新订单');
      return undefined;
    }
    if (
      !Number.isSafeInteger(record.revision) ||
      record.revision < 0 ||
      !record.document ||
      typeof record.document !== 'object' ||
      Array.isArray(record.document)
    )
      throw new ConflictException('原订单记录未核实，禁止创建新订单');
    const document = record.document as Record<string, unknown>;
    if (
      allowUnidentified &&
      identifiers.length === 0 &&
      (isUnidentifiedUnpaidCheckout(document) || isUnidentifiedCheckoutMarker(document))
    )
      return undefined;
    const identifier = rechargeCheckoutIdentifier(document);
    if (!identifier || (document.target_plan ?? 'plus') !== plan)
      throw new ConflictException('原订单记录未核实，禁止创建新订单');
    if (identifiers.some((value) => value !== identifier))
      throw new ConflictException('原订单编号不一致，禁止创建新订单');
    return identifier;
  }

  async findRunningJob(
    tx: V2CommandTransaction,
    ownerId: string,
    connectionApiKey?: string,
    excludeId?: string
  ) {
    const where = {
      ownerId,
      state: { not: 'finished' },
      leaseUntil: { gt: new Date() },
      ...(excludeId ? { id: { not: excludeId } } : {})
    };
    if (!connectionApiKey) return tx.idBusinessV2RechargeJob.findFirst({ where });
    const jobs = await tx.idBusinessV2RechargeJob.findMany({ where, take: 101 });
    if (jobs.length > 100) throw new ConflictException('执行中的连接过多，请先核对已有任务');
    // Legacy tasks without a binding remain conservative; a known different
    // computer/connection no longer occupies this connection's execution slot.
    return (
      jobs.find(
        (job) =>
          job.action !== 'bitbrowser' ||
          !object(job.result).connection_api_key ||
          object(job.result).connection_api_key === connectionApiKey
      ) ?? null
    );
  }

  async createJob(
    tx: V2CommandTransaction,
    data: Prisma.IdBusinessV2RechargeJobUncheckedCreateInput
  ) {
    await assertEmployeeBusinessWriter(tx, data.ownerId);
    await this.assertExecutionResources(tx, data.id!, data);
    return tx.idBusinessV2RechargeJob.create({ data });
  }

  async updateJob(
    tx: V2CommandTransaction,
    id: string,
    data: Prisma.IdBusinessV2RechargeJobUncheckedUpdateInput,
    options?: { factsOnly: true }
  ) {
    if (
      !options?.factsOnly &&
      data.state !== 'finished' &&
      (typeof data.accountKey === 'string' || data.result)
    ) {
      const current = await this.findJob(tx, id);
      if (current && current.action === 'bitbrowser') {
        await this.assertExecutionResources(tx, id, {
          ...current,
          ...data,
          ownerId: current.ownerId,
          accountKey: typeof data.accountKey === 'string' ? data.accountKey : current.accountKey,
          chatgptAccountId: current.chatgptAccountId,
          result: data.result ?? current.result
        } as Prisma.IdBusinessV2RechargeJobUncheckedCreateInput);
      }
    }
    return tx.idBusinessV2RechargeJob.update({ where: { id }, data });
  }

  private async assertExecutionResources(
    tx: V2CommandTransaction,
    id: string,
    data: Prisma.IdBusinessV2RechargeJobUncheckedCreateInput
  ) {
    if (data.action !== 'bitbrowser' || data.state === 'finished') return;
    const result = data.result as Record<string, unknown> | undefined;
    const apiKey =
      typeof result?.connection_api_key === 'string' ? result.connection_api_key : undefined;
    if (await this.findRunningJob(tx, data.ownerId, apiKey, id))
      throw new ConflictException('当前比特连接已有任务执行中，请先处理原任务');
    const checks: Prisma.IdBusinessV2RechargeJobWhereInput[] = apiKey
      ? [{ result: { path: '$.connection_api_key', equals: apiKey } }]
      : [{ ownerId: data.ownerId }];
    if (data.accountKey) checks.push({ accountKey: data.accountKey });
    if (data.chatgptAccountId) checks.push({ chatgptAccountId: data.chatgptAccountId });
    if (typeof result?.addressId === 'string' && result.addressId)
      checks.push({
        ownerId: data.ownerId,
        result: { path: '$.addressId', equals: result.addressId }
      });
    if (typeof result?.connection_connector_key === 'string')
      checks.push({
        result: { path: '$.connection_connector_key', equals: result.connection_connector_key }
      });
    if (
      typeof result?.connection_api_key === 'string' &&
      typeof result.browser_profile_id === 'string'
    )
      checks.push({
        AND: [
          { result: { path: '$.connection_api_key', equals: result.connection_api_key } },
          { result: { path: '$.browser_profile_id', equals: result.browser_profile_id } }
        ]
      });
    const conflict = await tx.idBusinessV2RechargeJob.findFirst({
      where: {
        id: { not: id },
        state: { not: 'finished' },
        leaseUntil: { gt: new Date() },
        OR: checks
      }
    });
    if (conflict)
      throw new ConflictException(
        conflict.ownerId === data.ownerId
          ? '本人已有任务执行中，请先处理原任务'
          : '该账号、比特窗口或本机助手已有任务执行中，请使用独立资源'
      );
  }

  records(tx: V2CommandTransaction, accountKey: string) {
    return tx.idBusinessV2RechargeRecord.findMany({ where: { accountKey } });
  }

  paymentRecords(ownerId: string, accountKeys: string[], includeCheckouts = false) {
    return this.prisma.idBusinessV2RechargeRecord.findMany({
      where: {
        ownerId,
        accountKey: { in: accountKeys },
        ...(includeCheckouts
          ? { NOT: { fileKey: { startsWith: 'history/' } } }
          : { fileKey: { startsWith: 'payments/' } })
      }
    });
  }

  async inspectStoppedCheckout(
    tx: V2CommandTransaction,
    accountKey: string,
    plan: string,
    ownerId: string
  ) {
    const fileKey = `${accountKey}${plan === 'plus' ? '' : `-${plan}`}.json`;
    const record = await tx.idBusinessV2RechargeRecord.findUnique({
      where: { accountKey_fileKey: { accountKey, fileKey } }
    });
    if (!record) return false;
    if (record.ownerId !== ownerId) throw new ConflictException('原订单归属不一致');
    if (!record.document || typeof record.document !== 'object' || Array.isArray(record.document))
      return false;
    const before = record.document as Record<string, unknown>;
    if (
      typeof before.checkout_identifier !== 'string' ||
      !/^(?:cs|oaics)_[A-Za-z0-9_]{1,200}$/.test(before.checkout_identifier) ||
      (before.target_plan ?? 'plus') !== plan ||
      before.checkout_outcome !== 'created' ||
      before.payment_status !== 'not_attempted' ||
      before.payment_attempted !== false ||
      before.confirmation_requests_sent !== 0
    )
      return false;
    const payments = (await this.records(tx, accountKey)).filter(
      (item) =>
        item.fileKey.startsWith('payments/') &&
        (item.document as Record<string, unknown>).checkout_identifier ===
          before.checkout_identifier
    );
    if (
      payments.some((item) => {
        const payment = item.document as Record<string, unknown>;
        return (
          item.ownerId !== ownerId ||
          payment.payment_attempted !== false ||
          payment.confirmation_requests_sent !== 0 ||
          payment.payment_evidence ||
          payment.payment_status !== 'not_attempted'
        );
      })
    )
      return false;
    // 这里只记录可恢复性。任务停止不证明官网订单取消，原编号和付款事实不能改写。
    return true;
  }

  async closeOfficialDeclinedRecords(
    tx: V2CommandTransaction,
    job: IdBusinessV2RechargeJob,
    proof: Record<string, unknown>
  ) {
    if (!job.accountKey) throw new ConflictException('原付款账号缺失');
    const result = object(job.result),
      records = await this.records(tx, job.accountKey);
    const upgrade = result.operation === 'subscription_upgrade';
    const identifier = rechargeOperationIdentifier(result);
    if (
      typeof identifier !== 'string' ||
      (upgrade && !isRechargeUpgrade(result)) ||
      proof.checkoutIdentifier !== identifier
    )
      throw new ConflictException('原付款操作绑定未核实');
    const checkout = upgrade
      ? []
      : records.filter(
          (item) =>
            item.fileKey === `${job.accountKey}${job.plan === 'plus' ? '' : `-${job.plan}`}.json`
        );
    const payments = records.filter((item) => item.fileKey === `payments/${hash(identifier)}.json`);
    if ((!upgrade && checkout.length !== 1) || payments.length !== 1)
      throw new ConflictException('找不到唯一原单与付款记录，保留待核对状态');
    for (const item of [...checkout, ...payments]) {
      const document = object(item.document),
        payment = item.fileKey.startsWith('payments/');
      if (
        item.ownerId !== job.ownerId ||
        item.accountKey !== job.accountKey ||
        rechargeOperationIdentifier(document) !== identifier ||
        (upgrade &&
          (!isRechargeUpgrade(document) ||
            document.current_plan_before !== result.current_plan_before ||
            (document.upgrade_payment_intent_identifier !== undefined &&
              document.upgrade_payment_intent_identifier !== proof.paymentIntentIdentifier))) ||
        (document.payment_intent_identifier !== undefined &&
          document.payment_intent_identifier !== proof.paymentIntentIdentifier) ||
        (document.target_plan ?? 'plus') !== job.plan ||
        document.payment_evidence ||
        document.payment_status === 'paid' ||
        document.operator_resolution ||
        (payment &&
          (document.payment_attempted !== true ||
            document.payment_requests_sent !== 1 ||
            document.confirmation_requests_sent !== 1 ||
            document.quote_digest !== result.quote_digest ||
            rechargeDocumentDigest(document.quote) !== rechargeDocumentDigest(result.quote))) ||
        (!payment &&
          (document.payment_attempted === true ||
            Number(document.confirmation_requests_sent ?? 0) !== 0))
      )
        throw new ConflictException('原单付款事实存在冲突，禁止自动结束保护');
      const beforeProof = document._official_terminal_failure_v1;
      if (beforeProof && !isDeepStrictEqual(beforeProof, proof))
        throw new ConflictException('原单失败核验记录已存在');
      const changed = await tx.idBusinessV2RechargeRecord.updateMany({
        where: {
          accountKey: item.accountKey,
          fileKey: item.fileKey,
          ownerId: job.ownerId,
          revision: item.revision
        },
        data: {
          revision: { increment: 1 },
          document: toV2JsonDocument({
            ...document,
            ...(payment ? { payment_status: 'declined' } : {}),
            _official_terminal_failure_v1: proof
          })
        }
      });
      if (changed.count !== 1) throw new ConflictException('原单版本已变化，请重新核对');
    }
  }

  async resolveUnknownPaymentRecords(
    tx: V2CommandTransaction,
    input: {
      accountKey: string;
      checkoutIdentifier: string;
      plan: string;
      ownerId: string;
      resolutionJobId: string;
      sourceJobId: string;
      verificationJobId: string;
      resolvedAt: string;
      kind?: 'confirmed_declined_no_charge' | 'confirmed_verification_failed_no_charge';
      resolutionBasis?: 'captured_official_failure' | 'operator_observed_official_failure';
    }
  ) {
    const verificationFailure = input.kind === 'confirmed_verification_failed_no_charge';
    if (
      verificationFailure
        ? !['captured_official_failure', 'operator_observed_official_failure'].includes(
            String(input.resolutionBasis)
          )
        : input.resolutionBasis !== undefined
    )
      throw new ConflictException('历史付款处理依据无效');
    const records = await this.records(tx, input.accountKey);
    const checkoutFileKey = `${input.accountKey}${
      input.plan === 'plus' ? '' : `-${input.plan}`
    }.json`;
    const checkout = records.find((item) => item.fileKey === checkoutFileKey);
    const payments = records.filter(
      (item) =>
        item.fileKey.startsWith('payments/') &&
        (item.document as Record<string, unknown>).checkout_identifier === input.checkoutIdentifier
    );
    if (!checkout || payments.length !== 1) {
      throw new ConflictException('找不到唯一的历史付款记录');
    }
    if ([checkout, payments[0]!].some((item) => item.ownerId !== input.ownerId)) {
      throw new ConflictException('历史付款记录归属不一致');
    }
    const checkoutDocument = checkout.document as Record<string, unknown>;
    const paymentDocument = payments[0]!.document as Record<string, unknown>;
    if (
      checkoutDocument.checkout_identifier !== input.checkoutIdentifier ||
      String(checkoutDocument.target_plan ?? 'plus') !== input.plan ||
      paymentDocument.account_key !== input.accountKey ||
      String(paymentDocument.target_plan ?? 'plus') !== input.plan ||
      paymentDocument.payment_attempted !== true ||
      Number(paymentDocument.confirmation_requests_sent) !== 1 ||
      paymentDocument.payment_status !==
        (input.kind === 'confirmed_declined_no_charge' ? 'declined' : 'unknown') ||
      paymentDocument.payment_evidence ||
      checkoutDocument.payment_evidence
    ) {
      throw new ConflictException('历史付款证据不符合处理条件');
    }
    if (
      input.kind &&
      (checkoutDocument.payment_status !== 'not_attempted' ||
        checkoutDocument.payment_attempted === true ||
        Number(checkoutDocument.confirmation_requests_sent ?? 0) !== 0 ||
        paymentDocument.operation === 'subscription_upgrade')
    )
      throw new ConflictException('原结算状态不支持安全结束，请保留原单继续核实');
    if (
      verificationFailure &&
      (payments[0]!.fileKey !== `payments/${hash(input.checkoutIdentifier)}.json` ||
        paymentDocument.payment_requests_sent !== 1 ||
        (checkoutDocument.payment_requests_sent !== undefined &&
          checkoutDocument.payment_requests_sent !== 0) ||
        checkoutDocument.operation === 'subscription_upgrade' ||
        checkoutDocument.status === 'subscription_activated' ||
        paymentDocument.status === 'subscription_activated' ||
        paymentDocument.payment_outcome === 'subscription_activated')
    )
      throw new ConflictException('原单付款请求不唯一或存在开通事实，不能结束保护');
    if (input.kind && paymentDocument.confirmation_requests_sent !== 1)
      throw new ConflictException('拒付原单的付款次数未核实');
    const resolution = {
      operator_resolution: input.kind ?? 'confirmed_no_bank_request',
      ...(verificationFailure ? { resolution_basis: input.resolutionBasis } : {}),
      resolved_at: input.resolvedAt,
      resolution_job_id: input.resolutionJobId,
      source_job_id: input.sourceJobId,
      verification_job_id: input.verificationJobId
    };
    const resolutionMatches = (document: Record<string, unknown>) =>
      Object.entries(resolution).every(([key, value]) => document[key] === value);
    const hasDifferentResolution = (document: Record<string, unknown>) =>
      Object.keys(resolution).some((key) => document[key] !== undefined) &&
      !resolutionMatches(document);
    if (hasDifferentResolution(checkoutDocument) || hasDifferentResolution(paymentDocument)) {
      throw new ConflictException('历史付款记录已经由其他任务处理');
    }
    let updated = 0;
    for (const item of [checkout, payments[0]!]) {
      const before = item.document as Record<string, unknown>;
      if (resolutionMatches(before)) continue;
      await tx.idBusinessV2RechargeRecord.update({
        where: {
          accountKey_fileKey: { accountKey: input.accountKey, fileKey: item.fileKey }
        },
        data: {
          revision: { increment: 1 },
          document: toV2JsonDocument({ ...before, ...resolution })
        }
      });
      updated += 1;
    }
    return { updated };
  }

  async active(tx: V2CommandTransaction, id: string) {
    const job = await tx.idBusinessV2RechargeJob.findUnique({ where: { id } });
    if (!job || job.leaseUntil.getTime() < Date.now() || job.state === 'finished') {
      throw new ConflictException('执行窗口已结束，请重新核验原订单');
    }
    return job;
  }

  async saveRecord(
    tx: V2CommandTransaction,
    input: {
      accountKey: string;
      fileKey: string;
      revision: number;
      document: object;
      ownerId: string;
      allowCheckoutReplacement?: boolean;
      allowResolvedDeclineReplacement?: boolean;
      allowExpiredCheckoutReplacement?: boolean;
      allowCycleReplacement?: boolean;
      cycleOrigin?: object;
    }
  ) {
    const key = { accountKey: input.accountKey, fileKey: input.fileKey };
    const previous = await tx.idBusinessV2RechargeRecord.findUnique({
      where: { accountKey_fileKey: key }
    });
    const before = previous?.document as Record<string, unknown> | undefined;
    const replacingCycle =
      input.allowCycleReplacement === true &&
      !input.fileKey.startsWith('payments/') &&
      (!previous || isClosedCycleDocument(before, input.accountKey));
    const replacement = input.document as Record<string, unknown>;
    const replacingResolvedDecline =
      input.allowResolvedDeclineReplacement === true &&
      resolvedDeclinedCheckout(before) &&
      !input.fileKey.startsWith('payments/') &&
      replacement.status === 'checkout_attempted' &&
      replacement.stage === 'checkout_create' &&
      replacement.checkout_outcome === 'unknown' &&
      replacement.payment_status === 'not_attempted' &&
      typeof replacement.retry_of === 'string' &&
      /^[a-f0-9]{64}$/.test(replacement.retry_of);
    const replacingVerifiedFailure =
      before !== undefined &&
      replacingResolvedDecline &&
      (before?.operator_resolution === 'confirmed_verification_failed_no_charge' ||
        hasOfficialTerminalNoncharge(before) ||
        manualRechargeSettlement(before)?.outcome === 'failure');
    if (
      replacingVerifiedFailure &&
      (replacement.retry_of !== rechargeDocumentDigest(before) ||
        String(replacement.target_plan ?? 'plus') !== String(before.target_plan ?? 'plus') ||
        input.fileKey !==
          `${input.accountKey}${before.target_plan === undefined || before.target_plan === 'plus' ? '' : `-${String(before.target_plan)}`}.json` ||
        replacement.account_key !== input.accountKey ||
        replacement.payment_attempted === true ||
        replacement.payment_evidence ||
        (replacement.payment_requests_sent !== undefined &&
          replacement.payment_requests_sent !== 0) ||
        (replacement.confirmation_requests_sent !== undefined &&
          replacement.confirmation_requests_sent !== 0))
    )
      throw new ConflictException('已核实原单仅能按同账号、同套餐和原单摘要开始新结算');
    const next: Record<string, unknown> = {
      ...(input.document as Record<string, unknown>),
      ...preserveRechargeResolutionMetadata(
        before,
        input.document as Record<string, unknown>,
        replacingCycle || replacingResolvedDecline
      ),
      ...(!replacingCycle && before?.cycle_resolution
        ? { cycle_resolution: before.cycle_resolution }
        : {}),
      ...(!replacingCycle && before?.cycle_origin ? { cycle_origin: before.cycle_origin } : {}),
      ...(input.cycleOrigin ? { cycle_origin: input.cycleOrigin } : {})
    };
    if (
      previous &&
      previous.ownerId === input.ownerId &&
      previous.revision === input.revision + 1 &&
      previous.document &&
      rechargeDocumentDigest(previous.document) === rechargeDocumentDigest(next)
    )
      return { revision: previous.revision, replayed: true as const };
    if (
      (previous?.revision ?? 0) !== input.revision ||
      (previous && previous.ownerId !== input.ownerId)
    ) {
      throw new ConflictException('原订单版本冲突，禁止重复提交');
    }
    if (before && isClosedCycleDocument(before, input.accountKey) && !replacingCycle)
      throw new ConflictException('旧付款周期已归档，不能改写原结算');
    const document = toV2JsonDocument(next);
    if (next.operation === 'subscription_upgrade') {
      if (
        !isRechargeUpgrade(next) ||
        input.fileKey !== `payments/${hash(String(next.upgrade_identifier))}.json`
      )
        throw new ConflictException('升级原单绑定无效');
      if (
        before &&
        [
          'operation',
          'upgrade_identifier',
          'target_plan',
          'current_plan_before',
          'upgrade_invoice_identifier',
          'upgrade_payment_intent_identifier'
        ].some((key) => before[key] !== undefined && before[key] !== next[key])
      )
        throw new ConflictException('升级原单编号不可更换');
      if (
        before?.payment_evidence &&
        JSON.stringify(before.payment_evidence) !== JSON.stringify(next.payment_evidence)
      )
        throw new ConflictException('已核实的升级付款证据不可更换');
    } else if (before?.operation === 'subscription_upgrade' && !replacingCycle)
      throw new ConflictException('升级原单类型不可更换');
    const replacingUnpaidCheckout =
      replacingResolvedDecline ||
      input.allowExpiredCheckoutReplacement === true ||
      (input.allowCheckoutReplacement === true &&
        input.fileKey.endsWith('.json') &&
        !input.fileKey.startsWith('payments/') &&
        before?.payment_status === 'not_attempted' &&
        before.payment_attempted !== true &&
        !before.confirmation_requests_sent &&
        next.status === 'checkout_attempted' &&
        next.stage === 'checkout_create' &&
        next.checkout_outcome === 'unknown' &&
        next.payment_status === 'not_attempted' &&
        typeof next.retry_of === 'string' &&
        /^[a-f0-9]{64}$/.test(next.retry_of));
    if (
      before?.checkout_identifier &&
      before.checkout_identifier !== next.checkout_identifier &&
      !replacingUnpaidCheckout &&
      !replacingCycle
    ) {
      throw new ConflictException('原订单编号不可更换');
    }
    if (input.fileKey.startsWith('payments/')) {
      if (
        hasOfficialTerminalNoncharge(before) &&
        (next.payment_status !== 'declined' || next.payment_evidence)
      )
        throw new ConflictException('官网已核实拒付终态，付款记录不可回退或覆盖');
      if (
        next.account_key !== input.accountKey ||
        next.payment_attempted !== true ||
        ![0, 1].includes(next.confirmation_requests_sent as number) ||
        (next.payment_requests_sent !== undefined &&
          ![0, 1].includes(next.payment_requests_sent as number))
      ) {
        throw new ConflictException('付款标记无效');
      }
      if (
        before &&
        (before.quote_digest !== next.quote_digest ||
          rechargeDocumentDigest(before.quote) !== rechargeDocumentDigest(next.quote) ||
          Number(before.confirmation_requests_sent) > Number(next.confirmation_requests_sent) ||
          (before.payment_requests_sent === 1 && next.payment_requests_sent === 0) ||
          (before.payment_status === 'paid' && next.payment_status !== 'paid') ||
          (before.payment_evidence &&
            rechargeDocumentDigest(before.payment_evidence) !==
              rechargeDocumentDigest(next.payment_evidence)))
      ) {
        throw new ConflictException('原付款标记不能回退或变更报价');
      }
    }
    const revision = input.revision + 1;
    if (replacingVerifiedFailure && previous) {
      const digest = rechargeDocumentDigest(previous.document);
      const archiveKey = { accountKey: input.accountKey, fileKey: `history/${digest}.json` };
      const archived = await tx.idBusinessV2RechargeRecord.findUnique({
        where: { accountKey_fileKey: archiveKey }
      });
      if (
        archived &&
        (archived.ownerId !== input.ownerId ||
          archived.accountKey !== input.accountKey ||
          rechargeDocumentDigest(archived.document) !== digest ||
          !isDeepStrictEqual(archived.document, previous.document))
      )
        throw new ConflictException('已核实原单的历史归档发生冲突，不能覆盖原结算');
      if (!archived)
        await this.createCycleArchive(
          tx,
          { accountKey: input.accountKey, ownerId: input.ownerId },
          archiveKey.fileKey,
          previous.document
        );
    }
    await tx.idBusinessV2RechargeRecord.upsert({
      where: { accountKey_fileKey: key },
      create: { ...key, ownerId: input.ownerId, document, revision },
      update: { document, revision }
    });
    return {
      revision,
      ...(replacingVerifiedFailure || input.allowExpiredCheckoutReplacement === true
        ? { checkoutMarkerDigest: rechargeDocumentDigest(document) }
        : {}),
      ...(replacingVerifiedFailure
        ? { replacedVerificationCheckout: String(before.checkout_identifier) }
        : {})
    };
  }

  createCycleArchive(...args: Parameters<typeof createCycleArchive>) {
    return createCycleArchive(...args);
  }
  closeCycleRecord(...args: Parameters<typeof closeCycleRecord>) {
    return closeCycleRecord(...args);
  }
  closeCycleJobs(...args: Parameters<typeof closeCycleJobs>) {
    return closeCycleJobs(...args);
  }
}
