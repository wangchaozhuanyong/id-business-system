import { Injectable } from '@nestjs/common';
import type { IdBusinessV2RecordStatus, Prisma } from '@prisma/client';
import { getPagination, type PaginationQuery } from '../../../common/pagination';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  verifySensitiveAccessApproval,
  type SensitiveAccessApprovalCheckInput
} from '../../../common/sensitive-access-approval';
import {
  buildV2StringArrayContainsFilter,
  type V2CommandTransaction
} from '../../runtime/public-api';

export const CUSTOMER_INCLUDE = {
  sourceOption: {
    select: {
      id: true,
      code: true,
      name: true
    }
  },
  tags: {
    include: {
      option: {
        select: {
          id: true,
          code: true,
          name: true
        }
      }
    },
    orderBy: {
      option: {
        sortOrder: 'asc'
      }
    }
  },
  services: {
    where: {
      source: 'activation'
    },
    include: {
      option: {
        select: {
          id: true,
          code: true,
          name: true,
          parent: {
            select: {
              id: true,
              name: true
            }
          }
        }
      }
    },
    orderBy: [{ lastOpenedAt: 'desc' }, { option: { sortOrder: 'asc' } }]
  },
  createdBy: {
    select: {
      id: true,
      username: true,
      displayName: true
    }
  }
} satisfies Prisma.IdBusinessV2CustomerInclude;

export type CustomerWithRelations = Prisma.IdBusinessV2CustomerGetPayload<{
  include: typeof CUSTOMER_INCLUDE;
}>;

export interface CustomerListPersistenceInput extends PaginationQuery {
  keyword: string | null;
  contactKeyword: string | null;
  contactHash: string | null;
  phoneSearchTokens: string[];
  wechatSearchTokens: string[];
  qqSearchTokens: string[];
  whatsappSearchTokens: string[];
  sourceOptionId: string | null;
  tagOptionId?: string;
  serviceOptionId?: string;
  recordStatus: IdBusinessV2RecordStatus | null;
  sortBy?: string;
  sortOrder?: string;
}

export interface CreateCustomerPersistenceInput {
  name: string;
  phoneEncrypted: string | null;
  phoneHash: string | null;
  phoneMasked: string | null;
  phoneTail: string | null;
  phoneSearchTokens: string[];
  wechat: string | null;
  wechatEncrypted: string | null;
  wechatHash: string | null;
  wechatMasked: string | null;
  wechatSearchTokens: string[];
  qq: string | null;
  qqEncrypted: string | null;
  qqHash: string | null;
  qqMasked: string | null;
  qqSearchTokens: string[];
  whatsappEncrypted: string | null;
  whatsappHash: string | null;
  whatsappMasked: string | null;
  whatsappTail: string | null;
  whatsappSearchTokens: string[];
  sourceOptionId: string | null;
  recordStatus: IdBusinessV2RecordStatus;
  remark: string | null;
  tagOptionIds: string[];
  operatorId?: string;
}

export interface UpdateCustomerPersistenceInput {
  name?: string;
  phoneEncrypted?: string | null;
  phoneHash?: string | null;
  phoneMasked?: string | null;
  phoneTail?: string | null;
  phoneSearchTokens?: string[];
  wechat?: string | null;
  wechatEncrypted?: string | null;
  wechatHash?: string | null;
  wechatMasked?: string | null;
  wechatSearchTokens?: string[];
  qq?: string | null;
  qqEncrypted?: string | null;
  qqHash?: string | null;
  qqMasked?: string | null;
  qqSearchTokens?: string[];
  whatsappEncrypted?: string | null;
  whatsappHash?: string | null;
  whatsappMasked?: string | null;
  whatsappTail?: string | null;
  whatsappSearchTokens?: string[];
  sourceOptionId?: string | null;
  recordStatus?: IdBusinessV2RecordStatus;
  remark?: string | null;
  tagOptionIds?: string[];
  operatorId?: string;
}

export interface CustomerDeleteImpact {
  orderCount: number;
  activeOrderCount: number;
  activationCount: number;
  activeActivationCount: number;
}

const CUSTOMER_SORT_FIELDS: Record<
  string,
  keyof Prisma.IdBusinessV2CustomerOrderByWithRelationInput
> = {
  name: 'name',
  wechat: 'wechatMasked',
  recordStatus: 'recordStatus',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

@Injectable()
export class IdBusinessV2CustomerRepository {
  constructor(private readonly prisma: PrismaService) {}

  async list(input: CustomerListPersistenceInput) {
    const pagination = getPagination(input);
    const where: Prisma.IdBusinessV2CustomerWhereInput = {
      deletedAt: null,
      sourceOptionId: input.sourceOptionId ?? undefined,
      recordStatus: input.recordStatus ?? undefined,
      tags: input.tagOptionId ? { some: { optionId: input.tagOptionId } } : undefined,
      services: input.serviceOptionId
        ? { some: { optionId: input.serviceOptionId, source: 'activation' } }
        : undefined,
      OR: input.keyword
        ? [
            { name: { contains: input.keyword } },
            { wechat: { contains: input.keyword } },
            { wechatHash: input.contactHash ?? undefined },
            {
              wechatSearchTokens: buildV2StringArrayContainsFilter(input.wechatSearchTokens)
            },
            { qq: { contains: input.keyword } },
            { qqHash: input.contactHash ?? undefined },
            {
              qqSearchTokens: buildV2StringArrayContainsFilter(input.qqSearchTokens)
            },
            {
              phoneTail: {
                contains: input.contactKeyword?.slice(-8) ?? input.keyword
              }
            },
            { phoneHash: input.contactHash ?? undefined },
            {
              phoneSearchTokens: buildV2StringArrayContainsFilter(input.phoneSearchTokens)
            },
            {
              whatsappTail: {
                contains: input.contactKeyword?.slice(-8) ?? input.keyword
              }
            },
            { whatsappHash: input.contactHash ?? undefined },
            {
              whatsappSearchTokens: buildV2StringArrayContainsFilter(input.whatsappSearchTokens)
            }
          ]
        : undefined
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.idBusinessV2Customer.findMany({
        where,
        include: CUSTOMER_INCLUDE,
        skip: pagination.skip,
        take: pagination.take,
        orderBy: this.buildOrderBy(input.sortBy, input.sortOrder)
      }),
      this.prisma.idBusinessV2Customer.count({ where })
    ]);
    return { items, total, page: pagination.page, pageSize: pagination.pageSize };
  }

  findById(id: string) {
    return this.prisma.idBusinessV2Customer.findFirst({
      where: { id, deletedAt: null },
      include: CUSTOMER_INCLUDE
    });
  }

  findByIdInTransaction(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2Customer.findFirst({
      where: { id, deletedAt: null },
      include: CUSTOMER_INCLUDE
    });
  }

  async getDeleteImpact(id: string, tx?: V2CommandTransaction): Promise<CustomerDeleteImpact> {
    const client = tx ?? this.prisma;
    const [orderCount, activeOrderCount, activationCount, activeActivationCount] =
      await Promise.all([
        client.idBusinessV2Order.count({ where: { customerId: id, deletedAt: null } }),
        client.idBusinessV2Order.count({
          where: {
            customerId: id,
            deletedAt: null,
            status: { in: ['draft', 'pending', 'waiting_external', 'processing'] }
          }
        }),
        client.idBusinessV2Activation.count({ where: { customerId: id } }),
        client.idBusinessV2Activation.count({ where: { customerId: id, status: 'active' } })
      ]);
    return { orderCount, activeOrderCount, activationCount, activeActivationCount };
  }

  create(tx: V2CommandTransaction, input: CreateCustomerPersistenceInput) {
    return tx.idBusinessV2Customer.create({
      data: {
        name: input.name,
        phoneEncrypted: input.phoneEncrypted,
        phoneHash: input.phoneHash,
        phoneMasked: input.phoneMasked,
        phoneTail: input.phoneTail,
        phoneSearchTokens: input.phoneSearchTokens,
        wechat: input.wechat,
        wechatEncrypted: input.wechatEncrypted,
        wechatHash: input.wechatHash,
        wechatMasked: input.wechatMasked,
        wechatSearchTokens: input.wechatSearchTokens,
        qq: input.qq,
        qqEncrypted: input.qqEncrypted,
        qqHash: input.qqHash,
        qqMasked: input.qqMasked,
        qqSearchTokens: input.qqSearchTokens,
        whatsappEncrypted: input.whatsappEncrypted,
        whatsappHash: input.whatsappHash,
        whatsappMasked: input.whatsappMasked,
        whatsappTail: input.whatsappTail,
        whatsappSearchTokens: input.whatsappSearchTokens,
        sourceOptionId: input.sourceOptionId,
        recordStatus: input.recordStatus,
        remark: input.remark,
        createdByUserId: input.operatorId,
        updatedByUserId: input.operatorId,
        tags: input.tagOptionIds.length
          ? { create: input.tagOptionIds.map((optionId) => ({ optionId })) }
          : undefined
      },
      include: CUSTOMER_INCLUDE
    });
  }

  update(tx: V2CommandTransaction, id: string, input: UpdateCustomerPersistenceInput) {
    return tx.idBusinessV2Customer.update({
      where: { id },
      data: {
        name: input.name,
        phoneEncrypted: input.phoneEncrypted,
        phoneHash: input.phoneHash,
        phoneMasked: input.phoneMasked,
        phoneTail: input.phoneTail,
        phoneSearchTokens: input.phoneSearchTokens,
        wechat: input.wechat,
        wechatEncrypted: input.wechatEncrypted,
        wechatHash: input.wechatHash,
        wechatMasked: input.wechatMasked,
        wechatSearchTokens: input.wechatSearchTokens,
        qq: input.qq,
        qqEncrypted: input.qqEncrypted,
        qqHash: input.qqHash,
        qqMasked: input.qqMasked,
        qqSearchTokens: input.qqSearchTokens,
        whatsappEncrypted: input.whatsappEncrypted,
        whatsappHash: input.whatsappHash,
        whatsappMasked: input.whatsappMasked,
        whatsappTail: input.whatsappTail,
        whatsappSearchTokens: input.whatsappSearchTokens,
        sourceOptionId: input.sourceOptionId,
        recordStatus: input.recordStatus,
        remark: input.remark,
        updatedByUserId: input.operatorId,
        tags:
          input.tagOptionIds === undefined
            ? undefined
            : {
                deleteMany: {},
                create: input.tagOptionIds.map((optionId) => ({ optionId }))
              }
      },
      include: CUSTOMER_INCLUDE
    });
  }

  softDelete(
    tx: V2CommandTransaction,
    input: { id: string; deletedAt: Date; operatorId?: string }
  ) {
    return tx.idBusinessV2Customer.update({
      where: { id: input.id },
      data: { deletedAt: input.deletedAt, updatedByUserId: input.operatorId }
    });
  }

  verifySensitiveAccessApproval(
    tx: V2CommandTransaction,
    input: SensitiveAccessApprovalCheckInput
  ) {
    return verifySensitiveAccessApproval(tx, input);
  }

  appendSensitiveAccess(
    tx: V2CommandTransaction,
    input: {
      userId?: string;
      fieldName: 'phone' | 'wechat' | 'qq' | 'whatsapp';
      objectId: string;
      accessReason: string;
      approved: boolean;
      ip?: string;
      userAgent?: string;
    }
  ) {
    return tx.sensitiveAccessLog.create({
      data: {
        userId: input.userId,
        module: 'id_business_v2_customer',
        fieldName: input.fieldName,
        objectType: 'id_business_v2_customer',
        objectId: input.objectId,
        accessReason: input.accessReason,
        approved: input.approved,
        ip: input.ip,
        userAgent: input.userAgent
      }
    });
  }

  private buildOrderBy(sortBy?: string, sortOrder?: string) {
    const field = sortBy ? CUSTOMER_SORT_FIELDS[sortBy] : undefined;
    if (!field) {
      return [
        { updatedAt: 'desc' },
        { id: 'desc' }
      ] satisfies Prisma.IdBusinessV2CustomerOrderByWithRelationInput[];
    }
    const direction = sortOrder === 'desc' ? 'desc' : 'asc';
    return [
      { [field]: direction },
      { updatedAt: 'desc' },
      { id: 'desc' }
    ] as Prisma.IdBusinessV2CustomerOrderByWithRelationInput[];
  }
}
