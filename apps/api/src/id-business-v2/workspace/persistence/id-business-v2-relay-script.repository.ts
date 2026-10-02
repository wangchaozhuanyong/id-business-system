import { ConflictException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { V2CommandTransaction } from '../../runtime/public-api';
import {
  assertEmployeeBusinessWriter,
  getEmployeeBusinessOwnerIds
} from '../../../v2-auth/system-super-admin';

type RelayPersistenceClient = Pick<
  V2CommandTransaction,
  'idBusinessV2RelayConnection' | 'idBusinessV2RelayJob' | 'securitySetting'
>;

export type IdBusinessV2RelayJobUpdate = Prisma.IdBusinessV2RelayJobUncheckedUpdateManyInput;
export type IdBusinessV2RelayJsonInput = Prisma.InputJsonValue;

const JOB_LEASE_MS = 3 * 60 * 1000;
const JOB_LEASE_RENEW_MS = 30 * 1000;

@Injectable()
export class IdBusinessV2RelayScriptRepository {
  constructor(private readonly prisma: PrismaService) {}

  findConnectionByUser(userId: string, client: RelayPersistenceClient = this.prisma) {
    return client.idBusinessV2RelayConnection.findUnique({ where: { userId } });
  }

  findConnectionByStateHash(stateHash: string, client: RelayPersistenceClient = this.prisma) {
    return client.idBusinessV2RelayConnection.findUnique({
      where: { googleOAuthStateHash: stateHash }
    });
  }

  upsertConnection(
    userId: string,
    input: Omit<Prisma.IdBusinessV2RelayConnectionUncheckedCreateInput, 'userId'>,
    client: RelayPersistenceClient = this.prisma
  ) {
    return client.idBusinessV2RelayConnection.upsert({
      where: { userId },
      create: { ...input, userId },
      update: input
    });
  }

  updateConnection(
    id: string,
    input: Prisma.IdBusinessV2RelayConnectionUncheckedUpdateInput,
    client: RelayPersistenceClient = this.prisma
  ) {
    return client.idBusinessV2RelayConnection.update({ where: { id }, data: input });
  }

  async listJobsByUser(userId: string, client: RelayPersistenceClient = this.prisma) {
    return client.idBusinessV2RelayJob.findMany({
      where: { userId: { in: await getEmployeeBusinessOwnerIds(client, userId) } },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: 50
    });
  }

  async findJobByIdAndUser(
    id: string,
    userId: string,
    client: RelayPersistenceClient = this.prisma
  ) {
    return client.idBusinessV2RelayJob.findFirst({
      where: { id, userId: { in: await getEmployeeBusinessOwnerIds(client, userId) } }
    });
  }

  async createJob(
    tx: V2CommandTransaction,
    input: Prisma.IdBusinessV2RelayJobUncheckedCreateInput
  ) {
    await assertEmployeeBusinessWriter(tx, input.userId);
    return tx.idBusinessV2RelayJob.create({ data: input });
  }

  async updateLeasedJob(
    id: string,
    leaseId: string,
    input: IdBusinessV2RelayJobUpdate,
    client: RelayPersistenceClient
  ) {
    const updated = await client.idBusinessV2RelayJob.updateMany({
      where: { id, runLeaseId: leaseId, runLeaseExpiresAt: { gt: new Date() } },
      data: input
    });
    if (updated.count !== 1)
      throw new ConflictException('任务执行保护已失效，请重新查看进度，不能写入旧执行结果。');
    return client.idBusinessV2RelayJob.findUniqueOrThrow({ where: { id } });
  }

  async assertJobLease(id: string, leaseId: string) {
    const job = await this.prisma.idBusinessV2RelayJob.findFirst({
      where: { id, runLeaseId: leaseId, runLeaseExpiresAt: { gt: new Date() } },
      select: { id: true }
    });
    if (!job) throw new ConflictException('任务执行保护已失效，请重新查看进度。');
  }

  async withJobLease<T>(id: string, userId: string, execute: (leaseId: string) => Promise<T>) {
    const leaseId = randomUUID();
    const now = new Date();
    if (!(await this.acquireJobLease(id, userId, leaseId, now, new Date(+now + JOB_LEASE_MS))))
      throw new ConflictException('该部署任务正在执行，请勿重复提交');
    let renewing: Promise<void> | undefined;
    let renewalFailed = false;
    const timer = setInterval(() => {
      if (renewing || renewalFailed) return;
      const tick = new Date();
      renewing = this.renewJobLease(id, leaseId, tick, new Date(+tick + JOB_LEASE_MS))
        .then((renewed) => {
          if (!renewed) renewalFailed = true;
        })
        .catch(() => {
          renewalFailed = true;
        })
        .finally(() => {
          renewing = undefined;
        });
    }, JOB_LEASE_RENEW_MS);
    timer.unref();
    try {
      const result = await execute(leaseId);
      if (renewing) await renewing;
      if (renewalFailed)
        throw new ConflictException('任务执行保护续期失败，请重新查看进度后再操作。');
      return result;
    } finally {
      clearInterval(timer);
      if (renewing) await renewing;
      await this.releaseJobLease(id, leaseId);
    }
  }

  async renewJobLease(id: string, leaseId: string, now: Date, expiresAt: Date) {
    const updated = await this.prisma.idBusinessV2RelayJob.updateMany({
      where: { id, runLeaseId: leaseId, runLeaseExpiresAt: { gt: now } },
      data: { runLeaseExpiresAt: expiresAt }
    });
    return updated.count === 1;
  }

  async acquireJobLease(id: string, userId: string, leaseId: string, now: Date, expiresAt: Date) {
    return this.prisma.$transaction(async (tx) => {
      await assertEmployeeBusinessWriter(tx, userId);
      const result = await tx.idBusinessV2RelayJob.updateMany({
        where: {
          id,
          userId: { in: await getEmployeeBusinessOwnerIds(tx, userId) },
          OR: [{ runLeaseId: null }, { runLeaseExpiresAt: { lt: now } }]
        },
        data: { runLeaseId: leaseId, runLeaseExpiresAt: expiresAt }
      });
      return result.count === 1;
    });
  }

  releaseJobLease(id: string, leaseId: string) {
    return this.prisma.idBusinessV2RelayJob.updateMany({
      where: { id, runLeaseId: leaseId },
      data: { runLeaseId: null, runLeaseExpiresAt: null }
    });
  }
}
