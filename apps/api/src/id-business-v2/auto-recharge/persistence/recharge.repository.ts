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

  async lock(tx: V2CommandTransaction) {
    await acquireMysqlTransactionLock(tx, 'auto-recharge-single-worker');
  }

  findJob(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2RechargeJob.findUnique({ where: { id } });
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
    if (before?.checkout_identifier && before.checkout_identifier !== next.checkout_identifier) {
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
