import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { V2CommandTransaction } from '../../runtime/public-api';

type QuickActionClient = Pick<V2CommandTransaction, 'idBusinessV2QuickAction'>;

@Injectable()
export class IdBusinessV2QuickActionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listByUser(userId: string, client: QuickActionClient = this.prisma) {
    const rows = await client.idBusinessV2QuickAction.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { updatedAt: 'desc' }, { id: 'asc' }]
    });
    // MySQL sorts NULL first; any legacy unranked rows follow the saved custom order.
    return [
      ...rows.filter((row) => row.sortOrder !== null),
      ...rows.filter((row) => row.sortOrder === null)
    ];
  }

  countByUser(userId: string, client: QuickActionClient = this.prisma) {
    return client.idBusinessV2QuickAction.count({ where: { userId, deletedAt: null } });
  }

  findByIdAndUser(id: string, userId: string, client: QuickActionClient = this.prisma) {
    return client.idBusinessV2QuickAction.findFirst({
      where: { id, userId, deletedAt: null }
    });
  }

  async nextSortOrder(userId: string, tx: V2CommandTransaction) {
    const result = await tx.idBusinessV2QuickAction.aggregate({
      where: { userId, deletedAt: null },
      _max: { sortOrder: true }
    });
    return result._max.sortOrder === null ? null : result._max.sortOrder + 1;
  }

  create(
    tx: V2CommandTransaction,
    input: { userId: string; title: string; content: string; sortOrder: number | null }
  ) {
    return tx.idBusinessV2QuickAction.create({ data: input });
  }

  async updateOrder(
    tx: V2CommandTransaction,
    userId: string,
    rows: { id: string; updatedAt: Date }[]
  ) {
    for (const [sortOrder, row] of rows.entries()) {
      const result = await tx.idBusinessV2QuickAction.updateMany({
        where: { id: row.id, userId, deletedAt: null },
        data: { sortOrder, updatedAt: row.updatedAt }
      });
      if (result.count !== 1) throw new ConflictException('快捷回复已变化，请刷新后重新排序');
    }
    return this.listByUser(userId, tx);
  }

  update(tx: V2CommandTransaction, id: string, input: { title: string; content: string }) {
    return tx.idBusinessV2QuickAction.update({ where: { id }, data: input });
  }

  softDelete(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2QuickAction.update({
      where: { id },
      data: { deletedAt: new Date() }
    });
  }
}
