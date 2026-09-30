import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { V2CommandTransaction } from '../../runtime/public-api';

type QuickActionClient = Pick<V2CommandTransaction, 'idBusinessV2QuickAction'>;

@Injectable()
export class IdBusinessV2QuickActionRepository {
  constructor(private readonly prisma: PrismaService) {}

  listByUser(userId: string, client: QuickActionClient = this.prisma) {
    return client.idBusinessV2QuickAction.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }]
    });
  }

  countByUser(userId: string, client: QuickActionClient = this.prisma) {
    return client.idBusinessV2QuickAction.count({ where: { userId, deletedAt: null } });
  }

  findByIdAndUser(id: string, userId: string, client: QuickActionClient = this.prisma) {
    return client.idBusinessV2QuickAction.findFirst({
      where: { id, userId, deletedAt: null }
    });
  }

  create(tx: V2CommandTransaction, input: { userId: string; title: string; content: string }) {
    return tx.idBusinessV2QuickAction.create({ data: input });
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
