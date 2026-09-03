import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { V2CommandTransaction } from '../../runtime/public-api';

type RelayPersistenceClient = Pick<
  V2CommandTransaction,
  'idBusinessV2RelayConnection' | 'idBusinessV2RelayJob'
>;

export type IdBusinessV2RelayJobUpdate = Prisma.IdBusinessV2RelayJobUncheckedUpdateInput;
export type IdBusinessV2RelayJsonInput = Prisma.InputJsonValue;

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

  listJobsByUser(userId: string, client: RelayPersistenceClient = this.prisma) {
    return client.idBusinessV2RelayJob.findMany({
      where: { userId },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: 50
    });
  }

  findJobByIdAndUser(id: string, userId: string, client: RelayPersistenceClient = this.prisma) {
    return client.idBusinessV2RelayJob.findFirst({ where: { id, userId } });
  }

  createJob(tx: V2CommandTransaction, input: Prisma.IdBusinessV2RelayJobUncheckedCreateInput) {
    return tx.idBusinessV2RelayJob.create({ data: input });
  }

  updateJob(
    id: string,
    input: IdBusinessV2RelayJobUpdate,
    client: RelayPersistenceClient = this.prisma
  ) {
    return client.idBusinessV2RelayJob.update({ where: { id }, data: input });
  }

  async acquireJobLease(id: string, userId: string, leaseId: string, now: Date, expiresAt: Date) {
    const result = await this.prisma.idBusinessV2RelayJob.updateMany({
      where: {
        id,
        userId,
        OR: [{ runLeaseId: null }, { runLeaseExpiresAt: { lt: now } }]
      },
      data: { runLeaseId: leaseId, runLeaseExpiresAt: expiresAt }
    });
    return result.count === 1;
  }

  releaseJobLease(id: string, leaseId: string) {
    return this.prisma.idBusinessV2RelayJob.updateMany({
      where: { id, runLeaseId: leaseId },
      data: { runLeaseId: null, runLeaseExpiresAt: null }
    });
  }
}
