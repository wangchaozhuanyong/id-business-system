import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { buildOptionUniqueKey } from '../../options/public-api';
import type { V2CommandTransaction } from '../../runtime/public-api';
import type {
  AuditRestoreEntity,
  AuditRestorePatch,
  AuditRestoreState
} from '../audit-field-restore.types';

type AuditRestoreClient = Pick<
  V2CommandTransaction,
  'auditLog' | 'idBusinessV2Customer' | 'idBusinessV2Account' | 'idBusinessV2Option'
>;

@Injectable()
export class IdBusinessV2AuditRestoreRepository {
  constructor(private readonly prisma: PrismaService) {}

  findSource(id: string, client: AuditRestoreClient = this.prisma) {
    return client.auditLog.findUnique({
      where: { id },
      select: {
        id: true,
        action: true,
        objectType: true,
        objectId: true,
        beforeData: true,
        afterData: true
      }
    });
  }

  findCurrent(
    entity: AuditRestoreEntity,
    id: string,
    client: AuditRestoreClient = this.prisma
  ): Promise<AuditRestoreState | null> {
    const common = { id: true, remark: true, updatedAt: true, deletedAt: true } as const;
    if (entity === 'customer')
      return client.idBusinessV2Customer.findUnique({
        where: { id },
        select: { ...common, name: true }
      });
    if (entity === 'account')
      return client.idBusinessV2Account.findUnique({
        where: { id },
        select: {
          ...common,
          appleIdMasked: true,
          lossReportedAt: true
        }
      });
    return client.idBusinessV2Option.findUnique({
      where: { id },
      select: {
        ...common,
        name: true,
        sortOrder: true,
        type: true,
        isSystem: true,
        parentId: true,
        countryOptionId: true
      }
    });
  }

  findOptionNameConflict(
    current: AuditRestoreState,
    name: string,
    client: AuditRestoreClient = this.prisma
  ) {
    const uniqueKey = buildOptionUniqueKey(
      current.type!,
      current.parentId ?? null,
      current.countryOptionId ?? null,
      name
    );
    return client.idBusinessV2Option.findFirst({
      where: { uniqueKey, id: { not: current.id } },
      select: { id: true }
    });
  }

  async restore(
    tx: V2CommandTransaction,
    entity: AuditRestoreEntity,
    current: AuditRestoreState,
    patch: AuditRestorePatch,
    operatorId: string,
    updatedAt: Date
  ) {
    const where = { id: current.id, updatedAt: current.updatedAt, deletedAt: null };
    const common = {
      updatedByUserId: operatorId,
      updatedAt,
      ...(patch.remark !== undefined ? { remark: patch.remark as string | null } : {})
    };
    let result: { count: number };
    if (entity === 'customer') {
      result = await tx.idBusinessV2Customer.updateMany({
        where,
        data: {
          ...common,
          ...(patch.name !== undefined ? { name: patch.name as string } : {})
        }
      });
    } else if (entity === 'account') {
      result = await tx.idBusinessV2Account.updateMany({
        where: { ...where, lossReportedAt: null },
        data: common
      });
    } else {
      const name = typeof patch.name === 'string' ? patch.name : current.name!;
      const uniqueKey = buildOptionUniqueKey(
        current.type!,
        current.parentId ?? null,
        current.countryOptionId ?? null,
        name
      );
      const conflict = await tx.idBusinessV2Option.findFirst({
        where: { uniqueKey, id: { not: current.id } },
        select: { id: true }
      });
      if (conflict) throw new ConflictException('原名称已被其他业务选项使用，请到选项页面核对。');
      result = await tx.idBusinessV2Option.updateMany({
        where: { ...where, isSystem: false },
        data: {
          ...common,
          ...(patch.name !== undefined ? { name, uniqueKey } : {}),
          ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder as number } : {})
        }
      });
    }
    if (result.count !== 1) throw new ConflictException('资料已发生变化，请重新核对后再恢复。');
    return { ...current, ...patch, updatedAt } as AuditRestoreState;
  }
}
