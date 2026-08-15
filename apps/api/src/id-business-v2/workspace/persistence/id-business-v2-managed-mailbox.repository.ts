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

  reserveQueryAttempt(input: {
    emailHash: string;
    ipHash: string | null;
    since: Date;
    maxEmailAttempts: number;
    maxIpAttempts: number;
  }) {
    return this.prisma.$transaction(async (client) => {
      const lockKeys = [`mail-viewer:email:${input.emailHash}`];
      if (input.ipHash) lockKeys.push(`mail-viewer:ip:${input.ipHash}`);
      for (const key of lockKeys.sort()) {
        await client.$queryRaw`
          SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))
        `;
      }

      const counts = [
        client.idBusinessV2MailQueryAttempt.count({
          where: { emailHash: input.emailHash, createdAt: { gte: input.since } }
        })
      ];
      if (input.ipHash) {
        counts.push(
          client.idBusinessV2MailQueryAttempt.count({
            where: { ipHash: input.ipHash, createdAt: { gte: input.since } }
          })
        );
      }
      const [emailAttempts = 0, ipAttempts = 0] = await Promise.all(counts);
      const allowed = emailAttempts < input.maxEmailAttempts && ipAttempts < input.maxIpAttempts;
      const attempt = await client.idBusinessV2MailQueryAttempt.create({
        data: {
          emailHash: input.emailHash,
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
