import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { acquireMysqlTransactionLock } from '../../../common/prisma/mysql-transaction-lock';
import { toV2JsonDocument, type V2CommandTransaction } from '../../runtime/public-api';
import type { Prisma } from '@prisma/client';

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

  findRunningJob(tx: V2CommandTransaction) {
    return tx.idBusinessV2RechargeJob.findFirst({
      where: { state: { not: 'finished' }, leaseUntil: { gt: new Date() } }
    });
  }

  createJob(tx: V2CommandTransaction, data: Prisma.IdBusinessV2RechargeJobUncheckedCreateInput) {
    return tx.idBusinessV2RechargeJob.create({ data });
  }

  updateJob(
    tx: V2CommandTransaction,
    id: string,
    data: Prisma.IdBusinessV2RechargeJobUncheckedUpdateInput
  ) {
    return tx.idBusinessV2RechargeJob.update({ where: { id }, data });
  }

  records(tx: V2CommandTransaction, accountKey: string) {
    return tx.idBusinessV2RechargeRecord.findMany({ where: { accountKey } });
  }

  async retireCancelledCheckout(
    tx: V2CommandTransaction,
    accountKey: string,
    plan: string,
    ownerId: string
  ) {
    const fileKey = `${accountKey}${plan === 'plus' ? '' : `-${plan}`}.json`;
    const record = await tx.idBusinessV2RechargeRecord.findUnique({
      where: { accountKey_fileKey: { accountKey, fileKey } }
    });
    if (!record) return 0;
    if (record.ownerId !== ownerId) throw new ConflictException('原订单归属不一致');
    const before = record.document as Record<string, unknown>;
    if (
      before.payment_status !== 'not_attempted' ||
      before.payment_attempted === true ||
      Number(before.confirmation_requests_sent ?? 0) !== 0
    )
      return 0;
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
          payment.confirmation_requests_sent !== 0 ||
          payment.payment_evidence ||
          !['unknown', 'cancelled'].includes(String(payment.payment_status))
        );
      })
    )
      return 0;
    // 连接器已停止，且持久记录证明未发送确认；保留审计和原编号，只停用执行记录。
    for (const item of [...payments, record]) {
      await tx.idBusinessV2RechargeRecord.update({
        where: { accountKey_fileKey: { accountKey, fileKey: item.fileKey } },
        data: {
          revision: { increment: 1 },
          document: toV2JsonDocument({
            ...(item.document as Record<string, unknown>),
            status: 'cancelled',
            reason: 'operation_cancelled',
            cancelled_before_confirmation: true,
            ...(item.fileKey.startsWith('payments/')
              ? { payment_status: 'cancelled' }
              : {
                  checkout_outcome: 'cancelled',
                  payment_status: 'not_attempted',
                  payment_attempted: false,
                  confirmation_requests_sent: 0
                })
          })
        }
      });
    }
    return payments.length + 1;
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
    }
  ) {
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
      paymentDocument.payment_status !== 'unknown' ||
      paymentDocument.payment_evidence ||
      checkoutDocument.payment_evidence
    ) {
      throw new ConflictException('历史付款证据不符合处理条件');
    }
    const resolution = {
      operator_resolution: 'confirmed_no_bank_request',
      resolved_at: input.resolvedAt,
      resolution_job_id: input.resolutionJobId,
      source_job_id: input.sourceJobId,
      verification_job_id: input.verificationJobId
    };
    const resolutionMatches = (document: Record<string, unknown>) =>
      Object.entries(resolution).every(([key, value]) => document[key] === value);
    const hasDifferentResolution = (document: Record<string, unknown>) =>
      document.operator_resolution !== undefined && !resolutionMatches(document);
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
    }
  ) {
    const key = { accountKey: input.accountKey, fileKey: input.fileKey };
    const previous = await tx.idBusinessV2RechargeRecord.findUnique({
      where: { accountKey_fileKey: key }
    });
    if (
      (previous?.revision ?? 0) !== input.revision ||
      (previous && previous.ownerId !== input.ownerId)
    ) {
      throw new ConflictException('原订单版本冲突，禁止重复提交');
    }
    const document = toV2JsonDocument(input.document);
    const next = input.document as Record<string, unknown>;
    const before = previous?.document as Record<string, unknown> | undefined;
    const replacingUnpaidCheckout =
      input.allowCheckoutReplacement === true &&
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
      /^[a-f0-9]{64}$/.test(next.retry_of);
    if (
      before?.checkout_identifier &&
      before.checkout_identifier !== next.checkout_identifier &&
      !replacingUnpaidCheckout
    ) {
      throw new ConflictException('原订单编号不可更换');
    }
    if (input.fileKey.startsWith('payments/')) {
      if (
        next.account_key !== input.accountKey ||
        next.payment_attempted !== true ||
        ![0, 1].includes(Number(next.confirmation_requests_sent))
      ) {
        throw new ConflictException('付款标记无效');
      }
      if (
        before &&
        (before.quote_digest !== next.quote_digest ||
          Number(before.confirmation_requests_sent) > Number(next.confirmation_requests_sent) ||
          (before.payment_status === 'paid' && next.payment_status !== 'paid'))
      ) {
        throw new ConflictException('原付款标记不能回退或变更报价');
      }
    }
    const revision = input.revision + 1;
    await tx.idBusinessV2RechargeRecord.upsert({
      where: { accountKey_fileKey: key },
      create: { ...key, ownerId: input.ownerId, document, revision },
      update: { document, revision }
    });
    return { revision };
  }
}
