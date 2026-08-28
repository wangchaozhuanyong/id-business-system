import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { V2CommandTransaction } from '../../runtime/public-api';

type TotpAccountPersistenceClient = Pick<V2CommandTransaction, 'idBusinessV2TotpAccount'>;

@Injectable()
export class IdBusinessV2TotpAccountRepository {
  constructor(private readonly prisma: PrismaService) {}

  listByUser(userId: string, client: TotpAccountPersistenceClient = this.prisma) {
    return client.idBusinessV2TotpAccount.findMany({
      where: { userId },
      orderBy: [{ updatedAt: 'desc' }, { name: 'asc' }, { id: 'asc' }]
    });
  }

  countByUser(userId: string, client: TotpAccountPersistenceClient = this.prisma) {
    return client.idBusinessV2TotpAccount.count({ where: { userId } });
  }

  findByIdAndUser(id: string, userId: string, client: TotpAccountPersistenceClient = this.prisma) {
    return client.idBusinessV2TotpAccount.findFirst({ where: { id, userId } });
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
