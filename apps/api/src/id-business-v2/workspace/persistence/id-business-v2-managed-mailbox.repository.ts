import { Injectable } from '@nestjs/common';
import type {
  IdBusinessV2MailQueryOutcome,
  IdBusinessV2ManagedMailboxStatus,
  Prisma
} from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { acquireMysqlTransactionLock } from '../../../common/prisma/mysql-transaction-lock';
import type { V2CommandTransaction } from '../../runtime/public-api';

type MailboxPersistenceClient = Pick<
  V2CommandTransaction,
  'idBusinessV2ManagedMailbox' | 'idBusinessV2MailQueryAttempt' | 'idBusinessV2MailboxOAuthState'
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

  findByQueryCodeHash(queryCodeHash: string, client: MailboxPersistenceClient = this.prisma) {
    return client.idBusinessV2ManagedMailbox.findUnique({ where: { queryCodeHash } });
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

  updateProviderCredential(id: string, providerCredentialEncrypted: string) {
    return this.prisma.idBusinessV2ManagedMailbox.update({
      where: { id },
      data: { providerCredentialEncrypted }
    });
  }

  createOAuthState(
    data: Prisma.IdBusinessV2MailboxOAuthStateUncheckedCreateInput,
    client: MailboxPersistenceClient = this.prisma
  ) {
    return client.idBusinessV2MailboxOAuthState.create({ data });
  }

  findOAuthStateById(id: string, client: MailboxPersistenceClient = this.prisma) {
    return client.idBusinessV2MailboxOAuthState.findUnique({ where: { id } });
  }

  findOAuthStateByHash(stateHash: string, client: MailboxPersistenceClient = this.prisma) {
    return client.idBusinessV2MailboxOAuthState.findUnique({ where: { stateHash } });
  }

  completeOAuthState(
    tx: V2CommandTransaction,
    id: string,
    input: { mailboxId: string; completedAt: Date }
  ) {
    return tx.idBusinessV2MailboxOAuthState.update({
      where: { id },
      data: {
        status: 'succeeded',
        failureCode: null,
        mailboxId: input.mailboxId,
        completedAt: input.completedAt
      }
    });
  }

  failOAuthState(id: string, failureCode: string, completedAt = new Date()) {
    return this.prisma.idBusinessV2MailboxOAuthState.updateMany({
      where: { id, status: 'pending' },
      data: { status: 'failed', failureCode, completedAt }
    });
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

  reserveQueryAttempt(input: {
    queryCodeHash: string;
    ipHash: string | null;
    since: Date;
    maxQueryCodeAttempts: number;
    maxIpAttempts: number;
  }) {
    return this.prisma.$transaction(async (client) => {
      const lockKeys = [`mail-viewer:query-code:${input.queryCodeHash}`];
      if (input.ipHash) lockKeys.push(`mail-viewer:ip:${input.ipHash}`);
      for (const key of lockKeys.sort()) {
        await acquireMysqlTransactionLock(client, key);
      }

      const counts = [
        client.idBusinessV2MailQueryAttempt.count({
          where: { queryCodeHash: input.queryCodeHash, createdAt: { gte: input.since } }
        })
      ];
      if (input.ipHash) {
        counts.push(
          client.idBusinessV2MailQueryAttempt.count({
            where: { ipHash: input.ipHash, createdAt: { gte: input.since } }
          })
        );
      }
      const [queryCodeAttempts = 0, ipAttempts = 0] = await Promise.all(counts);
      const allowed =
        queryCodeAttempts < input.maxQueryCodeAttempts && ipAttempts < input.maxIpAttempts;
      const attempt = await client.idBusinessV2MailQueryAttempt.create({
        data: {
          queryCodeHash: input.queryCodeHash,
          ipHash: input.ipHash,
          mailboxId: null,
          outcome: allowed ? 'invalid' : 'rate_limited'
        },
        select: { id: true }
      });
      return allowed
        ? { allowed: true as const, attemptId: attempt.id }
        : { allowed: false as const };
    });
  }

  updateQueryAttempt(
    id: string,
    input: { mailboxId: string | null; outcome: IdBusinessV2MailQueryOutcome }
  ) {
    return this.prisma.idBusinessV2MailQueryAttempt.update({ where: { id }, data: input });
  }
}
