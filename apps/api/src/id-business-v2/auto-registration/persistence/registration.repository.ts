import { ConflictException, Injectable } from '@nestjs/common';
import type { Prisma, IdBusinessV2RegistrationJob } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { acquireMysqlTransactionLock } from '../../../common/prisma/mysql-transaction-lock';
import type { V2CommandTransaction } from '../../runtime/public-api';

@Injectable()
export class RegistrationRepository {
  constructor(private readonly prisma: PrismaService) {}
  lock(tx: V2CommandTransaction) {
    return acquireMysqlTransactionLock(tx, 'auto-registration:single-task');
  }
  names(where: Prisma.IdBusinessV2RegistrationNameWhereInput, skip: number, take: number) {
    return this.prisma.idBusinessV2RegistrationName.findMany({
      where,
      skip,
      take,
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }]
    });
  }
  countNames(where: Prisma.IdBusinessV2RegistrationNameWhereInput) {
    return this.prisma.idBusinessV2RegistrationName.count({ where });
  }
  name(tx: V2CommandTransaction, nameId?: string) {
    return tx.idBusinessV2RegistrationName.findFirst({
      where: { ...(nameId ? { id: nameId } : {}), active: true },
      orderBy: [{ usageCount: 'asc' }, { id: 'asc' }]
    });
  }
  findName(tx: V2CommandTransaction, nameId: string) {
    return tx.idBusinessV2RegistrationName.findUnique({ where: { id: nameId } });
  }
  pendingEmail(tx: V2CommandTransaction, emailHash: string) {
    return tx.idBusinessV2RegistrationJob.findFirst({
      where: { emailHash, state: { not: 'cancelled' } }
    });
  }
  writeName(
    tx: V2CommandTransaction,
    nameId: string | null,
    data: Prisma.IdBusinessV2RegistrationNameCreateInput
  ) {
    return nameId
      ? tx.idBusinessV2RegistrationName.update({ where: { id: nameId }, data })
      : tx.idBusinessV2RegistrationName.create({ data });
  }
  importNames(tx: V2CommandTransaction, names: string[]) {
    return tx.idBusinessV2RegistrationName.createMany({
      data: names.map((displayName) => ({ displayName })),
      skipDuplicates: true
    });
  }
  jobs(where: Prisma.IdBusinessV2RegistrationJobWhereInput, skip: number, take: number) {
    return this.prisma.idBusinessV2RegistrationJob.findMany({
      where,
      skip,
      take,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }]
    });
  }
  countJobs(where: Prisma.IdBusinessV2RegistrationJobWhereInput) {
    return this.prisma.idBusinessV2RegistrationJob.count({ where });
  }
  find(id: string) {
    return this.prisma.idBusinessV2RegistrationJob.findUnique({ where: { id } });
  }
  findInTransaction(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2RegistrationJob.findUnique({ where: { id } });
  }
  active(tx: V2CommandTransaction, excludeId?: string) {
    return tx.idBusinessV2RegistrationJob.findFirst({
      where: {
        ...(excludeId ? { id: { not: excludeId } } : {}),
        state: { in: ['queued', 'running', 'awaiting_email', 'awaiting_user'] },
        OR: [{ leaseUntil: null }, { leaseUntil: { gt: new Date() } }]
      }
    });
  }
  account(tx: V2CommandTransaction, emailHash: string) {
    return tx.idBusinessV2ChatgptAccount.findUnique({ where: { emailHash } });
  }
  accountsByEmailHashes(emailHashes: string[]) {
    return this.prisma.idBusinessV2ChatgptAccount.findMany({
      where: { emailHash: { in: emailHashes } },
      select: { id: true, emailHash: true }
    });
  }
  activeEmail(tx: V2CommandTransaction, emailHash: string) {
    return tx.idBusinessV2RegistrationJob.findFirst({
      where: {
        emailHash,
        state: { in: ['queued', 'running', 'awaiting_email', 'awaiting_user', 'partial'] },
        OR: [{ leaseUntil: null }, { leaseUntil: { gt: new Date() } }]
      }
    });
  }
  createManualAccount(
    tx: V2CommandTransaction,
    data: Prisma.IdBusinessV2ChatgptAccountUncheckedCreateInput
  ) {
    return tx.idBusinessV2ChatgptAccount.create({ data });
  }
  create(tx: V2CommandTransaction, data: Prisma.IdBusinessV2RegistrationJobUncheckedCreateInput) {
    return tx.idBusinessV2RegistrationJob.create({ data });
  }
  update(
    tx: V2CommandTransaction,
    id: string,
    data: Prisma.IdBusinessV2RegistrationJobUncheckedUpdateInput
  ) {
    return tx.idBusinessV2RegistrationJob.update({ where: { id }, data });
  }
  useName(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2RegistrationName.update({
      where: { id },
      data: { usageCount: { increment: 1 } }
    });
  }
  async saveAccount(tx: V2CommandTransaction, job: IdBusinessV2RegistrationJob, event: string) {
    if (!job.accountId) {
      if (await this.account(tx, job.emailHash))
        throw new ConflictException('该邮箱已有账号资料，请人工核对');
      return tx.idBusinessV2ChatgptAccount.create({
        data: {
          emailHash: job.emailHash,
          emailEncrypted: job.emailEncrypted,
          emailMasked: job.emailMasked,
          registrationCountryCode: job.registrationCountryCode,
          createdByUserId: job.ownerId,
          updatedByUserId: job.ownerId,
          passwordEncrypted: job.passwordVerified ? job.passwordEncrypted : null,
          totpSecretEncrypted: job.mfaVerified ? job.pendingTotpEncrypted : null,
          offerStatus: job.offerStatus,
          offerSource: 'automatic',
          offerObservedAt: new Date()
        }
      });
    }
    const existing = await this.account(tx, job.emailHash);
    if (!existing || existing.id !== job.accountId)
      throw new ConflictException('关联账号资料已变化，请人工核对');
    if (!['password_verified', 'mfa_verified'].includes(event)) return existing;
    return tx.idBusinessV2ChatgptAccount.update({
      where: { id: existing.id },
      data: {
        ...(event === 'password_verified' && !existing.passwordEncrypted
          ? { passwordEncrypted: job.passwordEncrypted }
          : {}),
        ...(event === 'mfa_verified' && !existing.totpSecretEncrypted
          ? { totpSecretEncrypted: job.pendingTotpEncrypted }
          : {}),
        updatedByUserId: job.ownerId
      }
    });
  }
  async saveOffer(tx: V2CommandTransaction, job: IdBusinessV2RegistrationJob) {
    if (!job.accountId || job.offerStatus === 'unknown') return;
    await tx.idBusinessV2ChatgptAccount.updateMany({
      where: { id: job.accountId, OR: [{ offerSource: null }, { offerSource: { not: 'manual' } }] },
      data: { offerStatus: job.offerStatus, offerSource: 'automatic', offerObservedAt: new Date() }
    });
  }
}
