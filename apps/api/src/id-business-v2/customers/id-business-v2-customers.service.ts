import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import type { IdBusinessV2RecordStatus, Prisma } from '@prisma/client';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { getPagination, type PaginationQuery } from '../../common/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import { verifySensitiveAccessApproval } from '../../common/sensitive-access-approval';
import { IdBusinessV2OptionsService } from '../options/public-api';
import type { CreateIdBusinessV2CustomerDto } from './dto/create-id-business-v2-customer.dto';
import type { RevealIdBusinessV2CustomerPhoneDto } from './dto/reveal-id-business-v2-customer-phone.dto';
import type { UpdateIdBusinessV2CustomerDto } from './dto/update-id-business-v2-customer.dto';

interface ListIdBusinessV2CustomersQuery extends PaginationQuery {
  keyword?: string;
  sourceOptionId?: string;
  tagOptionId?: string;
  serviceOptionId?: string;
  recordStatus?: string;
  sortBy?: string;
  sortOrder?: string;
}

interface AuditRequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

const CUSTOMER_INCLUDE = {
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
    orderBy: {
      option: {
        sortOrder: 'asc'
      }
    }
  }
} satisfies Prisma.IdBusinessV2CustomerInclude;

type CustomerWithRelations = Prisma.IdBusinessV2CustomerGetPayload<{
  include: typeof CUSTOMER_INCLUDE;
}>;

const CUSTOMER_SORT_FIELDS: Record<
  string,
  keyof Prisma.IdBusinessV2CustomerOrderByWithRelationInput
> = {
  name: 'name',
  wechat: 'wechat',
  recordStatus: 'recordStatus',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

@Injectable()
export class IdBusinessV2CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogsService: AuditLogsService,
    private readonly fieldEncryptionService: FieldEncryptionService,
    private readonly optionsService: IdBusinessV2OptionsService
  ) {}

  async list(query: ListIdBusinessV2CustomersQuery) {
    const pagination = getPagination(query);
    const keyword = this.normalizeNullableString(query.keyword);
    const phoneKeyword = keyword ? this.normalizePhone(keyword) : null;
    const where: Prisma.IdBusinessV2CustomerWhereInput = {
      deletedAt: null,
      sourceOptionId: this.normalizeNullableString(query.sourceOptionId) ?? undefined,
      recordStatus: this.parseRecordStatus(query.recordStatus, false) ?? undefined,
      tags: query.tagOptionId
        ? {
            some: {
              optionId: query.tagOptionId
            }
          }
        : undefined,
      services: query.serviceOptionId
        ? {
            some: {
              optionId: query.serviceOptionId
            }
          }
        : undefined,
      OR: keyword
        ? [
            { name: { contains: keyword, mode: 'insensitive' } },
            { wechat: { contains: keyword, mode: 'insensitive' } },
            { phoneTail: { contains: phoneKeyword?.slice(-8) ?? keyword, mode: 'insensitive' } },
            { phoneHash: this.fieldEncryptionService.hash(phoneKeyword) ?? undefined }
          ]
        : undefined
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.idBusinessV2Customer.findMany({
        where,
        include: CUSTOMER_INCLUDE,
        skip: pagination.skip,
        take: pagination.take,
        orderBy: this.buildOrderBy(query)
      }),
      this.prisma.idBusinessV2Customer.count({ where })
    ]);

    return {
      items: items.map((customer) => this.toResponse(customer)),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize
    };
  }

  async get(id: string) {
    const customer = await this.findCustomerOrThrow(id);
    return this.toResponse(customer);
  }

  async create(dto: CreateIdBusinessV2CustomerDto, operator?: AuthenticatedUser) {
    const name = this.normalizeRequiredString(dto.name, '客户名称');
    const phone = this.normalizePhone(dto.phone);
    const sourceOption = await this.optionsService.requireActiveOption(
      dto.sourceOptionId,
      'customer_source',
      '客户来源',
      true
    );
    const tags = await this.optionsService.requireActiveOptions(
      dto.tagOptionIds,
      'customer_tag',
      '客户标签'
    );
    const services = await this.optionsService.requireActiveOptions(
      dto.serviceOptionIds,
      'service',
      '常开业务'
    );

    const customer = await this.prisma.idBusinessV2Customer.create({
      data: {
        name,
        phoneEncrypted: this.fieldEncryptionService.encrypt(phone),
        phoneHash: this.fieldEncryptionService.hash(phone),
        phoneMasked: this.maskPhone(phone),
        phoneTail: phone ? phone.slice(-8) : null,
        wechat: this.normalizeNullableString(dto.wechat),
        sourceOptionId: sourceOption?.id ?? null,
        recordStatus: this.parseRecordStatus(dto.recordStatus, false) ?? 'active',
        remark: this.normalizeNullableString(dto.remark),
        createdByUserId: operator?.id,
        updatedByUserId: operator?.id,
        tags: tags.length
          ? {
              create: tags.map((tag) => ({
                optionId: tag.id
              }))
            }
          : undefined,
        services: services.length
          ? {
              create: services.map((service) => ({
                optionId: service.id
              }))
            }
          : undefined
      },
      include: CUSTOMER_INCLUDE
    });

    const response = this.toResponse(customer);
    await this.auditLogsService.create({
      userId: operator?.id,
      module: 'id_business_v2_customers',
      action: 'id_business_v2.customer.create',
      objectType: 'id_business_v2_customer',
      objectId: customer.id,
      afterData: this.toAuditJson(response),
      remark: `创建 V2 客户：${customer.name}`
    });

    return response;
  }

  async update(id: string, dto: UpdateIdBusinessV2CustomerDto, operator?: AuthenticatedUser) {
    const existing = await this.findCustomerOrThrow(id);
    const phone = dto.phone === undefined ? undefined : this.normalizePhone(dto.phone);
    const sourceOption =
      dto.sourceOptionId === undefined
        ? undefined
        : await this.optionsService.requireActiveOption(
            dto.sourceOptionId,
            'customer_source',
            '客户来源',
            true
          );
    const tags =
      dto.tagOptionIds === undefined
        ? undefined
        : await this.optionsService.requireActiveOptions(
            dto.tagOptionIds,
            'customer_tag',
            '客户标签'
          );
    const services =
      dto.serviceOptionIds === undefined
        ? undefined
        : await this.optionsService.requireActiveOptions(
            dto.serviceOptionIds,
            'service',
            '常开业务'
          );

    const customer = await this.prisma.idBusinessV2Customer.update({
      where: { id: existing.id },
      data: {
        name:
          dto.name === undefined ? undefined : this.normalizeRequiredString(dto.name, '客户名称'),
        phoneEncrypted:
          phone === undefined ? undefined : this.fieldEncryptionService.encrypt(phone),
        phoneHash: phone === undefined ? undefined : this.fieldEncryptionService.hash(phone),
        phoneMasked: phone === undefined ? undefined : this.maskPhone(phone),
        phoneTail: phone === undefined ? undefined : (phone?.slice(-8) ?? null),
        wechat: dto.wechat === undefined ? undefined : this.normalizeNullableString(dto.wechat),
        sourceOptionId: sourceOption === undefined ? undefined : (sourceOption?.id ?? null),
        recordStatus:
          dto.recordStatus === undefined
            ? undefined
            : (this.parseRecordStatus(dto.recordStatus, true) ?? undefined),
        remark: dto.remark === undefined ? undefined : this.normalizeNullableString(dto.remark),
        updatedByUserId: operator?.id,
        tags:
          tags === undefined
            ? undefined
            : {
                deleteMany: {},
                create: tags.map((tag) => ({
                  optionId: tag.id
                }))
              },
        services:
          services === undefined
            ? undefined
            : {
                deleteMany: {},
                create: services.map((service) => ({
                  optionId: service.id
                }))
              }
      },
      include: CUSTOMER_INCLUDE
    });

    const response = this.toResponse(customer);
    await this.auditLogsService.create({
      userId: operator?.id,
      module: 'id_business_v2_customers',
      action: 'id_business_v2.customer.update',
      objectType: 'id_business_v2_customer',
      objectId: customer.id,
      beforeData: this.toAuditJson(this.toResponse(existing)),
      afterData: this.toAuditJson(response),
      remark: `修改 V2 客户：${existing.name}`
    });

    return response;
  }

  async remove(id: string, operator?: AuthenticatedUser) {
    const existing = await this.findCustomerOrThrow(id);
    await this.prisma.idBusinessV2Customer.update({
      where: { id: existing.id },
      data: {
        deletedAt: new Date(),
        updatedByUserId: operator?.id
      }
    });

    await this.auditLogsService.create({
      userId: operator?.id,
      module: 'id_business_v2_customers',
      action: 'id_business_v2.customer.delete',
      objectType: 'id_business_v2_customer',
      objectId: existing.id,
      beforeData: this.toAuditJson(this.toResponse(existing)),
      remark: `删除 V2 客户：${existing.name}`
    });

    return { deleted: true };
  }

  async revealPhone(
    id: string,
    dto: RevealIdBusinessV2CustomerPhoneDto,
    operator?: AuthenticatedUser,
    requestMeta?: AuditRequestMeta
  ) {
    this.assertPhonePermission(operator);
    const reason = this.normalizeRevealReason(dto.reason);
    const customer = await this.findCustomerOrThrow(id);
    const phone = this.fieldEncryptionService.decrypt(customer.phoneEncrypted);
    if (!phone) {
      throw new NotFoundException('该客户没有手机号');
    }

    const approved = await verifySensitiveAccessApproval(this.prisma, {
      approvalId: dto.approvalId,
      requesterId: operator?.id,
      module: 'id_business_v2_customer',
      fieldName: 'phone',
      objectType: 'id_business_v2_customer',
      objectId: customer.id
    });

    await this.prisma.sensitiveAccessLog.create({
      data: {
        userId: operator?.id,
        module: 'id_business_v2_customer',
        fieldName: 'phone',
        objectType: 'id_business_v2_customer',
        objectId: customer.id,
        accessReason: reason,
        approved,
        ip: requestMeta?.ip ?? undefined,
        userAgent: requestMeta?.userAgent ?? undefined
      }
    });

    await this.auditLogsService.create({
      userId: operator?.id,
      module: 'id_business_v2_customers',
      action: 'id_business_v2.customer.phone.reveal',
      objectType: 'id_business_v2_customer',
      objectId: customer.id,
      afterData: this.toAuditJson({
        field: 'phone',
        reason,
        approved,
        phoneTail: customer.phoneTail
      }),
      ip: requestMeta?.ip ?? undefined,
      userAgent: requestMeta?.userAgent ?? undefined,
      remark: `查看 V2 客户手机号：${customer.name}`
    });

    return {
      customerId: customer.id,
      phone,
      revealedAt: new Date().toISOString()
    };
  }

  private async findCustomerOrThrow(id: string): Promise<CustomerWithRelations> {
    const customer = await this.prisma.idBusinessV2Customer.findFirst({
      where: {
        id,
        deletedAt: null
      },
      include: CUSTOMER_INCLUDE
    });
    if (!customer) {
      throw new NotFoundException('客户不存在');
    }
    return customer;
  }

  private buildOrderBy(query: ListIdBusinessV2CustomersQuery) {
    const field = query.sortBy ? CUSTOMER_SORT_FIELDS[query.sortBy] : undefined;
    if (!field) {
      return [
        { updatedAt: 'desc' },
        { id: 'desc' }
      ] satisfies Prisma.IdBusinessV2CustomerOrderByWithRelationInput[];
    }
    const direction = query.sortOrder === 'desc' ? 'desc' : 'asc';
    return [
      { [field]: direction },
      { updatedAt: 'desc' },
      { id: 'desc' }
    ] as Prisma.IdBusinessV2CustomerOrderByWithRelationInput[];
  }

  private parseRecordStatus(value: unknown, required: boolean): IdBusinessV2RecordStatus | null {
    if (value === undefined || value === null || value === '') {
      if (required) throw new BadRequestException('资料状态不能为空');
      return null;
    }
    if (value !== 'active' && value !== 'disabled') {
      throw new BadRequestException('资料状态无效');
    }
    return value;
  }

  private normalizeRequiredString(value: unknown, label: string) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException(`${label}不能为空`);
    }
    const normalized = value.trim();
    if (normalized.length > 120) {
      throw new BadRequestException(`${label}过长`);
    }
    return normalized;
  }

  private normalizeNullableString(value: unknown) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') {
      throw new BadRequestException('字段格式无效');
    }
    return value.trim() || null;
  }

  private normalizePhone(value: unknown) {
    const phone = this.normalizeNullableString(value);
    if (!phone) return null;
    const normalized = phone.replace(/[\s()-]/g, '');
    if (normalized.length > 40) {
      throw new BadRequestException('手机号过长');
    }
    return normalized;
  }

  private normalizeRevealReason(value: unknown) {
    const reason = this.normalizeNullableString(value);
    if (!reason) throw new BadRequestException('查看原因不能为空');
    if (reason.length > 200) throw new BadRequestException('查看原因过长');
    return reason;
  }

  private assertPhonePermission(operator?: AuthenticatedUser) {
    if (
      operator &&
      (operator.roles.includes('admin') || operator.permissions.includes('customer.view_phone'))
    ) {
      return;
    }
    throw new ForbiddenException('无权查看完整手机号');
  }

  private maskPhone(value: string | null) {
    if (!value) return null;
    if (value.length <= 4) return '****';
    return `${value.slice(0, 3)}****${value.slice(-4)}`;
  }

  private toResponse(customer: CustomerWithRelations) {
    return {
      id: customer.id,
      name: customer.name,
      maskedPhone: customer.phoneMasked,
      phoneTail: customer.phoneTail,
      hasPhone: Boolean(customer.phoneEncrypted),
      wechat: customer.wechat,
      sourceOptionId: customer.sourceOptionId,
      source: customer.sourceOption,
      tagOptionIds: customer.tags.map((item) => item.optionId),
      tags: customer.tags.map((item) => item.option),
      serviceOptionIds: customer.services.map((item) => item.optionId),
      services: customer.services.map((item) => item.option),
      recordStatus: customer.recordStatus,
      remark: customer.remark,
      createdAt: customer.createdAt,
      updatedAt: customer.updatedAt
    };
  }

  private toAuditJson(value: unknown) {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
