import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { V2CommandTransaction } from '../../runtime/public-api';
import {
  assertEmployeeBusinessWriter,
  getEmployeeBusinessOwnerIds
} from '../../../v2-auth/system-super-admin';

type TotpAccountPersistenceClient = Pick<
  V2CommandTransaction,
  'idBusinessV2TotpAccount' | 'securitySetting'
>;

@Injectable()
export class IdBusinessV2TotpAccountRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listByUser(userId: string, client: TotpAccountPersistenceClient = this.prisma) {
    return client.idBusinessV2TotpAccount.findMany({
      where: { userId: { in: await getEmployeeBusinessOwnerIds(client, userId) } },
      include: { user: { select: { username: true } } },
      orderBy: [{ updatedAt: 'desc' }, { name: 'asc' }, { id: 'asc' }]
    });
  }

  countByUser(userId: string, client: TotpAccountPersistenceClient = this.prisma) {
    return client.idBusinessV2TotpAccount.count({ where: { userId } });
  }

  async findByIdAndUser(
    id: string,
    userId: string,
    client: TotpAccountPersistenceClient = this.prisma
  ) {
    return client.idBusinessV2TotpAccount.findFirst({
      where: { id, userId: { in: await getEmployeeBusinessOwnerIds(client, userId) } }
    });
  }

  findByUserAndName(userId: string, name: string, client: TotpAccountPersistenceClient) {
    return client.idBusinessV2TotpAccount.findUnique({
      where: { userId_name: { userId, name } }
    });
  }

  findByUserAndSecretHash(
    userId: string,
    secretHash: string,
    client: TotpAccountPersistenceClient
  ) {
    return client.idBusinessV2TotpAccount.findUnique({
      where: { userId_secretHash: { userId, secretHash } }
    });
  }

  create(tx: V2CommandTransaction, input: Prisma.IdBusinessV2TotpAccountUncheckedCreateInput) {
    return tx.idBusinessV2TotpAccount.create({ data: input });
  }

  assertWriter(tx: V2CommandTransaction, userId: string) {
    return assertEmployeeBusinessWriter(tx, userId);
  }

  update(
    tx: V2CommandTransaction,
    id: string,
    input: Prisma.IdBusinessV2TotpAccountUncheckedUpdateInput
  ) {
    return tx.idBusinessV2TotpAccount.update({ where: { id }, data: input });
  }

  remove(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2TotpAccount.delete({ where: { id } });
  }
}
