import { Injectable } from '@nestjs/common';
import type {
  IdBusinessV2SensitiveDisplayContext,
  IdBusinessV2SensitiveDisplayMode,
  Prisma,
  SensitiveAccessApprovalStatus
} from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  verifySensitiveAccessApproval,
  type SensitiveAccessApprovalCheckInput
} from '../../../common/sensitive-access-approval';
import type { V2CommandTransaction } from '../../runtime/public-api';

const APPROVAL_INCLUDE = {
  requester: {
    select: { id: true, username: true, displayName: true }
  },
  approver: {
    select: { id: true, username: true, displayName: true }
  }
} satisfies Prisma.SensitiveAccessApprovalInclude;

export type SensitiveApprovalRecord = Prisma.SensitiveAccessApprovalGetPayload<{
  include: typeof APPROVAL_INCLUDE;
}>;

export interface SensitiveApprovalFilter {
  requesterId?: string;
  module?: string;
  fieldName?: string;
  objectType?: string;
  objectId?: string;
  status?: SensitiveAccessApprovalStatus;
}

export interface SensitivePermissionGrant {
  roleId: string;
  sensitiveApprovalRequired: boolean;
  permission: { code: string };
}

export interface SensitiveDisplayPolicyRecord {
  fieldKey: string;
  context: IdBusinessV2SensitiveDisplayContext;
  mode: IdBusinessV2SensitiveDisplayMode;
  role: {
    id: string;
    rolePermissions: Array<{
      permission: { code: string };
    }>;
  };
}

interface CreateSensitiveApprovalInput {
  requesterId: string;
  module: string;
  fieldName: string;
  objectType: string;
  objectId: string;
  reason: string;
}

@Injectable()
export class IdBusinessV2SensitiveAccessRepository {
  constructor(private readonly prisma: PrismaService) {}

  listSensitivePermissionGrants(
    userId: string,
    permissionCodes: string[],
    tx?: V2CommandTransaction
  ): Promise<SensitivePermissionGrant[]> {
    const client = tx ?? this.prisma;
    return client.rolePermission.findMany({
      where: {
        role: { userRoles: { some: { userId } } },
        permission: { code: { in: permissionCodes } }
      },
      select: {
        roleId: true,
        sensitiveApprovalRequired: true,
        permission: { select: { code: true } }
      }
    });
  }

  listSensitiveDisplayPolicies(
    userId: string,
    fieldKeys: string[],
    contexts: IdBusinessV2SensitiveDisplayContext[],
    tx?: V2CommandTransaction
  ): Promise<SensitiveDisplayPolicyRecord[]> {
    const client = tx ?? this.prisma;
    return client.idBusinessV2SensitiveDisplayPolicy.findMany({
      where: {
        role: { userRoles: { some: { userId } } },
        fieldKey: { in: fieldKeys },
        context: { in: contexts }
      },
      select: {
        fieldKey: true,
        context: true,
        mode: true,
        role: {
          select: {
            id: true,
            rolePermissions: {
              select: {
                permission: { select: { code: true } }
              }
            }
          }
        }
      }
    });
  }

  verifyApproval(tx: V2CommandTransaction, input: SensitiveAccessApprovalCheckInput) {
    return verifySensitiveAccessApproval(tx, input);
  }

  findApprovalReason(tx: V2CommandTransaction, id: string) {
    return tx.sensitiveAccessApproval.findUnique({
      where: { id },
      select: { id: true, reason: true }
    });
  }

  findPending(tx: V2CommandTransaction, filter: SensitiveApprovalFilter) {
    return tx.sensitiveAccessApproval.findFirst({
      where: { ...filter, status: 'pending' },
      include: APPROVAL_INCLUDE,
      orderBy: { createdAt: 'desc' }
    });
  }

  createPending(tx: V2CommandTransaction, input: CreateSensitiveApprovalInput) {
    return tx.sensitiveAccessApproval.create({
      data: { ...input, status: 'pending' },
      include: APPROVAL_INCLUDE
    });
  }

  async list(filter: SensitiveApprovalFilter, skip: number, take: number) {
    const [items, total] = await Promise.all([
      this.prisma.sensitiveAccessApproval.findMany({
        where: filter,
        include: APPROVAL_INCLUDE,
        skip,
        take,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
      }),
      this.prisma.sensitiveAccessApproval.count({ where: filter })
    ]);
    return { items, total };
  }

  async listPendingSummary() {
    const filter = { status: 'pending' } satisfies SensitiveApprovalFilter;
    const [items, pendingCount] = await Promise.all([
      this.prisma.sensitiveAccessApproval.findMany({
        where: filter,
        include: APPROVAL_INCLUDE,
        take: 8,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
      }),
      this.prisma.sensitiveAccessApproval.count({ where: filter })
    ]);
    return { items, pendingCount };
  }

  findById(tx: V2CommandTransaction, id: string) {
    return tx.sensitiveAccessApproval.findUnique({
      where: { id },
      include: APPROVAL_INCLUDE
    });
  }

  decidePending(
    tx: V2CommandTransaction,
    input: {
      id: string;
      status: 'approved' | 'rejected';
      approverId: string;
      decisionNote: string | null;
      approvedAt: Date | null;
      expiresAt: Date | null;
    }
  ) {
    return tx.sensitiveAccessApproval.updateMany({
      where: { id: input.id, status: 'pending' },
      data: {
        status: input.status,
        approverId: input.approverId,
        decisionNote: input.decisionNote,
        approvedAt: input.approvedAt,
        expiresAt: input.expiresAt
      }
    });
  }

  async resolveTargetLabel(objectType: string, objectId: string, tx?: V2CommandTransaction) {
    const client = tx ?? this.prisma;
    if (objectType === 'id_business_v2_account') {
      const account = await client.idBusinessV2Account.findFirst({
        where: { id: objectId, deletedAt: null },
        select: { appleIdMasked: true }
      });
      return account?.appleIdMasked ?? null;
    }
    if (objectType === 'id_business_v2_customer') {
      const customer = await client.idBusinessV2Customer.findFirst({
        where: { id: objectId, deletedAt: null },
        select: { name: true }
      });
      return customer?.name ?? null;
    }
    const giftCard = await client.idBusinessV2GiftCard.findUnique({
      where: { id: objectId },
      select: { codeMasked: true }
    });
    return giftCard?.codeMasked ?? null;
  }
}
