import { Injectable } from '@nestjs/common';
import type {
  IdBusinessV2MailQueryOutcome,
  IdBusinessV2ManagedMailboxStatus,
  Prisma
} from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { V2CommandTransaction } from '../../runtime/public-api';

type MailboxPersistenceClient = Pick<
  V2CommandTransaction,
  'idBusinessV2ManagedMailbox' | 'idBusinessV2MailQueryAttempt'
>;

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

  findById(id: string, client: MailboxPersistenceClient = this.prisma) {
    return client.idBusinessV2ManagedMailbox.findUnique({ where: { id } });
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
    input: { queryCodeHash: string; queryCodeHint: string; updatedByUserId: string }
  ) {
    return tx.idBusinessV2ManagedMailbox.update({ where: { id }, data: input });
  }

  updateQueryState(
    id: string,
    input: {
      lastErrorCode?: string | null;
      lastQueriedAt?: Date;
      lastVerifiedAt?: Date;
      status?: IdBusinessV2ManagedMailboxStatus;
    }
  ) {
    return this.prisma.idBusinessV2ManagedMailbox.update({ where: { id }, data: input });
  }

  countAttempts(input: { emailHash?: string; ipHash?: string; since: Date }) {
    return this.prisma.idBusinessV2MailQueryAttempt.count({
      where: {
        createdAt: { gte: input.since },
        ...(input.emailHash ? { emailHash: input.emailHash } : {}),
        ...(input.ipHash ? { ipHash: input.ipHash } : {})
      }
    });
  }

  recordAttempt(input: {
    emailHash: string;
    ipHash: string | null;
    mailboxId: string | null;
    outcome: IdBusinessV2MailQueryOutcome;
  }) {
    return this.prisma.idBusinessV2MailQueryAttempt.create({ data: input });
  }
}
