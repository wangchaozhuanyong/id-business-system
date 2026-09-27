import { Injectable } from '@nestjs/common';
import type { IdBusinessV2ManagedMailboxStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { V2CommandTransaction } from '../../runtime/public-api';

type MailboxPersistenceClient = Pick<
  V2CommandTransaction,
  'idBusinessV2ManagedMailbox' | 'idBusinessV2ManagedMailboxSetting'
>;

export interface MailboxQuerySnapshot {
  providerCredentialEncrypted: string;
  queryCodeHash: string;
  queryCodeExpiresAt: Date;
}

@Injectable()
export class IdBusinessV2ManagedMailboxRepository {
  constructor(private readonly prisma: PrismaService) {}

  list(
    input: { skip: number; take: number; where: Prisma.IdBusinessV2ManagedMailboxWhereInput },
    client: MailboxPersistenceClient = this.prisma
  ) {
    return client.idBusinessV2ManagedMailbox.findMany({
      where: input.where,
      skip: input.skip,
      take: input.take,
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }]
    });
  }

  count(
    where: Prisma.IdBusinessV2ManagedMailboxWhereInput,
    client: MailboxPersistenceClient = this.prisma
  ) {
    return client.idBusinessV2ManagedMailbox.count({ where });
  }

  findByEmail(email: string, client: MailboxPersistenceClient = this.prisma) {
    return client.idBusinessV2ManagedMailbox.findUnique({ where: { email } });
  }

  findByQueryCodeHash(queryCodeHash: string, client: MailboxPersistenceClient = this.prisma) {
    return client.idBusinessV2ManagedMailbox.findUnique({ where: { queryCodeHash } });
  }

  findById(id: string, client: MailboxPersistenceClient = this.prisma) {
    return client.idBusinessV2ManagedMailbox.findUnique({ where: { id } });
  }

  getQueryCodeSettings(scope: string, client: MailboxPersistenceClient = this.prisma) {
    return client.idBusinessV2ManagedMailboxSetting.findUnique({
      where: { scope },
      select: { id: true, queryCodeValidityDays: true, updatedAt: true }
    });
  }

  upsertQueryCodeSettings(
    tx: V2CommandTransaction,
    input: { queryCodeValidityDays: number; scope: string; updatedByUserId: string }
  ) {
    return tx.idBusinessV2ManagedMailboxSetting.upsert({
      where: { scope: input.scope },
      create: input,
      update: {
        queryCodeValidityDays: input.queryCodeValidityDays,
        updatedByUserId: input.updatedByUserId
      }
    });
  }

  updateAllQueryCodeExpirations(
    tx: V2CommandTransaction,
    queryCodeExpiresAt: Date,
    updatedByUserId: string
  ) {
    return tx.idBusinessV2ManagedMailbox.updateMany({
      data: { queryCodeExpiresAt, updatedByUserId }
    });
  }

  create(tx: V2CommandTransaction, data: Prisma.IdBusinessV2ManagedMailboxUncheckedCreateInput) {
    return tx.idBusinessV2ManagedMailbox.create({ data });
  }

  updateStatus(
    tx: V2CommandTransaction,
    id: string,
    status: IdBusinessV2ManagedMailboxStatus,
    updatedByUserId: string
  ) {
    return tx.idBusinessV2ManagedMailbox.update({
      where: { id },
      data: { status, updatedByUserId }
    });
  }

  updateCredential(
    tx: V2CommandTransaction,
    id: string,
    input: {
      providerCredentialEncrypted: string;
      updatedByUserId: string;
      verifiedAt: Date;
    }
  ) {
    return tx.idBusinessV2ManagedMailbox.update({
      where: { id },
      data: {
        providerCredentialEncrypted: input.providerCredentialEncrypted,
        updatedByUserId: input.updatedByUserId,
        status: 'active',
        lastVerifiedAt: input.verifiedAt,
        lastErrorCode: null
      }
    });
  }

  updateQueryCode(
    tx: V2CommandTransaction,
    id: string,
    input: {
      queryCodeExpiresAt: Date;
      queryCodeEncrypted: string;
      queryCodeHash: string;
      queryCodeHint: string;
      updatedByUserId: string;
    }
  ) {
    return tx.idBusinessV2ManagedMailbox.update({ where: { id }, data: input });
  }

  updateProviderCredentialIfCurrent(
    id: string,
    snapshot: MailboxQuerySnapshot,
    providerCredentialEncrypted: string
  ) {
    return this.updateQueryStateIfCurrent(id, snapshot, { providerCredentialEncrypted });
  }

  async updateQueryStateIfCurrent(
    id: string,
    snapshot: MailboxQuerySnapshot,
    input: {
      lastErrorCode?: string | null;
      lastQueriedAt?: Date;
      lastVerifiedAt?: Date;
      status?: IdBusinessV2ManagedMailboxStatus;
      providerCredentialEncrypted?: string;
    }
  ) {
    const result = await this.prisma.idBusinessV2ManagedMailbox.updateMany({
      where: {
        id,
        status: 'active',
        providerCredentialEncrypted: snapshot.providerCredentialEncrypted,
        queryCodeHash: snapshot.queryCodeHash,
        queryCodeExpiresAt: { equals: snapshot.queryCodeExpiresAt, gt: new Date() }
      },
      data: input
    });
    return result.count === 1;
  }
}
