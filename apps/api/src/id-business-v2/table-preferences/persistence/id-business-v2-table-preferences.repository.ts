import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { V2CommandTransaction } from '../../runtime/public-api';

type TablePreferencePersistenceClient = Pick<
  V2CommandTransaction,
  'idBusinessV2UserTablePreference'
>;

@Injectable()
export class IdBusinessV2TablePreferencesRepository {
  constructor(private readonly prisma: PrismaService) {}

  listByUser(userId: string) {
    return this.prisma.idBusinessV2UserTablePreference.findMany({
      where: { userId },
      orderBy: { tableId: 'asc' }
    });
  }

  findByUserAndTable(
    userId: string,
    tableId: string,
    client: TablePreferencePersistenceClient = this.prisma
  ) {
    return client.idBusinessV2UserTablePreference.findUnique({
      where: { userId_tableId: { userId, tableId } }
    });
  }

  upsert(
    tx: V2CommandTransaction,
    input: { userId: string; tableId: string; hiddenColumnKeys: string[] }
  ) {
    return tx.idBusinessV2UserTablePreference.upsert({
      where: { userId_tableId: { userId: input.userId, tableId: input.tableId } },
      create: input,
      update: { hiddenColumnKeys: input.hiddenColumnKeys }
    });
  }

  remove(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2UserTablePreference.delete({ where: { id } });
  }
}
