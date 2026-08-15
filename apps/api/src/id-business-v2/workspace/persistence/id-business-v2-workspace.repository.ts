import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { V2CommandTransaction } from '../../runtime/public-api';

type WorkspacePersistenceClient = Pick<V2CommandTransaction, 'idBusinessV2WorkspaceShortcut'>;

@Injectable()
export class IdBusinessV2WorkspaceRepository {
  constructor(private readonly prisma: PrismaService) {}

  listByUser(userId: string, client: WorkspacePersistenceClient = this.prisma) {
    return client.idBusinessV2WorkspaceShortcut.findMany({
      where: { userId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }]
    });
  }

  countByUser(userId: string, client: WorkspacePersistenceClient = this.prisma) {
    return client.idBusinessV2WorkspaceShortcut.count({ where: { userId } });
  }

  findByIdAndUser(id: string, userId: string, client: WorkspacePersistenceClient = this.prisma) {
    return client.idBusinessV2WorkspaceShortcut.findFirst({ where: { id, userId } });
  }

  findByUserAndUrl(userId: string, url: string, client: WorkspacePersistenceClient = this.prisma) {
    return client.idBusinessV2WorkspaceShortcut.findUnique({
      where: { userId_url: { userId, url } }
    });
  }

  nextSortOrder(userId: string, tx: V2CommandTransaction) {
    return tx.idBusinessV2WorkspaceShortcut
      .aggregate({ where: { userId }, _max: { sortOrder: true } })
      .then((result) => (result._max.sortOrder ?? -1) + 1);
  }

  create(
    tx: V2CommandTransaction,
    input: { userId: string; name: string; url: string; sortOrder: number }
  ) {
    return tx.idBusinessV2WorkspaceShortcut.create({ data: input });
  }

  update(tx: V2CommandTransaction, id: string, input: { name: string; url: string }) {
    return tx.idBusinessV2WorkspaceShortcut.update({ where: { id }, data: input });
  }

  remove(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2WorkspaceShortcut.delete({ where: { id } });
  }

  async updateOrder(tx: V2CommandTransaction, userId: string, shortcutIds: string[]) {
    await Promise.all(
      shortcutIds.map((id, sortOrder) =>
        tx.idBusinessV2WorkspaceShortcut.updateMany({
          where: { id, userId },
          data: { sortOrder }
        })
      )
    );
    return this.listByUser(userId, tx);
  }
}
