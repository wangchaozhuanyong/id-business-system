import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import {
  IdBusinessV2OptionStatus,
  IdBusinessV2OptionType,
  Prisma as PrismaNamespace
} from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { CreateIdBusinessV2OptionDto } from './dto/create-id-business-v2-option.dto';
import type { UpdateIdBusinessV2OptionDto } from './dto/update-id-business-v2-option.dto';
import {
  IdBusinessV2OptionQuery,
  type ListIdBusinessV2OptionsQuery
} from './id-business-v2-option-query';
import {
  OPTION_INCLUDE,
  toOptionAuditJson,
  toOptionResponse,
  type OptionWithRelations
} from './id-business-v2-option-support';
import { ID_BUSINESS_V2_OPTION_TYPE_MAP } from './id-business-v2-options.constants';
import {
  buildOptionUniqueKey,
  normalizeNullableString,
  normalizeOptionCurrencyCode,
  normalizeOptionDecimal,
  normalizeOptionFees,
  normalizeOptionName,
  normalizeOptionSortOrder,
  parseOptionStatus,
  parseOptionType,
  rethrowOptionUniqueConstraint
} from './id-business-v2-option-input';

@Injectable()
export class IdBusinessV2OptionsService {
  private readonly query: IdBusinessV2OptionQuery;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogsService: AuditLogsService
  ) {
    this.query = new IdBusinessV2OptionQuery(prisma);
  }

  list(query: ListIdBusinessV2OptionsQuery) {
    return this.query.list(query);
  }

  listDefaultPages() {
    return this.query.listDefaultPages();
  }

  listTypes() {
    return this.query.listTypes();
  }

  listSelectors(typeValue?: string, parentIdValue?: string) {
    return this.query.listSelectors(typeValue, parentIdValue);
  }

  getBusinessTree() {
    return this.query.getBusinessTree();
  }

  async get(id: string) {
    const option = await this.findOptionOrThrow(id);
    return toOptionResponse(option);
  }

  async requireActiveOption(
    idValue: string | null | undefined,
    type: IdBusinessV2OptionType,
    label: string,
    optional = false
  ) {
    const id = normalizeNullableString(idValue);
    if (!id) {
      if (optional) return null;
      throw new BadRequestException(`${label}不能为空`);
    }

    const option = await this.prisma.idBusinessV2Option.findFirst({
      where: {
        id,
        type,
        status: 'active',
        deletedAt: null
      },
      select: {
        id: true,
        type: true,
        code: true,
        name: true,
        parentId: true
      }
    });

    if (!option) {
      throw new BadRequestException(`${label}不存在或已停用`);
    }

    return option;
  }

  async requireActiveOptions(
    idValues: string[] | null | undefined,
    type: IdBusinessV2OptionType,
    label: string
  ) {
    const ids = [
      ...new Set(
        (idValues ?? [])
          .map((value) => normalizeNullableString(value))
          .filter((value): value is string => Boolean(value))
      )
    ];
    if (!ids.length) return [];

    const options = await this.prisma.idBusinessV2Option.findMany({
      where: {
        id: { in: ids },
        type,
        status: 'active',
        deletedAt: null
      },
      select: {
        id: true,
        type: true,
        code: true,
        name: true,
        parentId: true
      }
    });

    if (options.length !== ids.length) {
      throw new BadRequestException(`${label}包含不存在或已停用的选项`);
    }

    const optionMap = new Map(options.map((option) => [option.id, option]));
    return ids.map((id) => optionMap.get(id)!);
  }

  async create(dto: CreateIdBusinessV2OptionDto, operator?: AuthenticatedUser) {
    const type = parseOptionType(dto.type, true);
    const name = normalizeOptionName(dto.name);
    const parent = await this.validateParent(type, dto.parentId);
    const businessDetails = await this.normalizeBusinessDetails(type, {
      countryOptionId: dto.countryOptionId,
      businessAmount: dto.businessAmount,
      currencyCode: dto.currencyCode
    });
    const fees = normalizeOptionFees(type, dto.fixedFee, dto.percentageFee);
    const uniqueKey = buildOptionUniqueKey(
      type,
      parent?.id ?? null,
      businessDetails.countryOption?.id ?? null,
      name
    );

    await this.assertUniqueKeyAvailable(uniqueKey);

    const option = await this.createOption({
      type,
      name,
      parentId: parent?.id ?? null,
      countryOptionId: businessDetails.countryOption?.id ?? null,
      businessAmount: businessDetails.businessAmount,
      currencyCode: businessDetails.currencyCode,
      fixedFee: fees.fixedFee,
      percentageFee: fees.percentageFee,
      sortOrder: normalizeOptionSortOrder(dto.sortOrder),
      status: parseOptionStatus(dto.status, false) ?? 'active',
      remark: normalizeNullableString(dto.remark),
      uniqueKey,
      operatorId: operator?.id
    });

    await this.auditLogsService.create({
      userId: operator?.id,
      module: 'id_business_v2_options',
      action: 'id_business_v2.option.create',
      objectType: 'id_business_v2_option',
      objectId: option.id,
      afterData: toOptionAuditJson(toOptionResponse(option)),
      remark: `创建 V2 选项：${option.name}`
    });

    this.query.clearCache();
    return toOptionResponse(option);
  }

  async update(id: string, dto: UpdateIdBusinessV2OptionDto, operator?: AuthenticatedUser) {
    const existing = await this.findOptionOrThrow(id);
    this.assertMutable(existing);

    const name = dto.name === undefined ? existing.name : normalizeOptionName(dto.name);
    const parent =
      dto.parentId === undefined
        ? existing.parent
        : await this.validateParent(existing.type, dto.parentId, existing.id);
    const parentId = parent?.id ?? null;
    const businessDetails = await this.normalizeBusinessDetails(existing.type, {
      countryOptionId:
        dto.countryOptionId === undefined ? existing.countryOptionId : dto.countryOptionId,
      businessAmount:
        dto.businessAmount === undefined ? existing.businessAmount?.toString() : dto.businessAmount,
      currencyCode: dto.currencyCode === undefined ? existing.currencyCode : dto.currencyCode
    });
    const uniqueKey = buildOptionUniqueKey(
      existing.type,
      parentId,
      businessDetails.countryOption?.id ?? null,
      name
    );

    if (uniqueKey !== existing.uniqueKey) {
      await this.assertUniqueKeyAvailable(uniqueKey, existing.id);
    }

    const status = dto.status === undefined ? existing.status : parseOptionStatus(dto.status, true);
    if (status === 'disabled') {
      await this.assertNoChildren(existing.id, '停用', true);
    }

    const fees = normalizeOptionFees(
      existing.type,
      dto.fixedFee === undefined ? existing.fixedFee.toString() : dto.fixedFee,
      dto.percentageFee === undefined ? existing.percentageFee.toString() : dto.percentageFee
    );

    const option = await this.updateOption(existing.id, {
      name,
      parentId,
      countryOptionId: businessDetails.countryOption?.id ?? null,
      businessAmount: businessDetails.businessAmount,
      currencyCode: businessDetails.currencyCode,
      fixedFee: fees.fixedFee,
      percentageFee: fees.percentageFee,
      sortOrder:
        dto.sortOrder === undefined ? existing.sortOrder : normalizeOptionSortOrder(dto.sortOrder),
      status,
      remark: dto.remark === undefined ? existing.remark : normalizeNullableString(dto.remark),
      uniqueKey,
      operatorId: operator?.id
    });

    await this.auditLogsService.create({
      userId: operator?.id,
      module: 'id_business_v2_options',
      action: 'id_business_v2.option.update',
      objectType: 'id_business_v2_option',
      objectId: option.id,
      beforeData: toOptionAuditJson(toOptionResponse(existing)),
      afterData: toOptionAuditJson(toOptionResponse(option)),
      remark: `修改 V2 选项：${existing.name}`
    });

    this.query.clearCache();
    return toOptionResponse(option);
  }

  async remove(id: string, operator?: AuthenticatedUser) {
    const existing = await this.findOptionOrThrow(id);
    this.assertMutable(existing);
    await this.assertNoChildren(existing.id, '删除', false);

    await this.prisma.idBusinessV2Option.update({
      where: { id: existing.id },
      data: {
        uniqueKey: `deleted:${existing.id}:${existing.uniqueKey}`,
        deletedAt: new Date(),
        updatedByUserId: operator?.id
      }
    });

    await this.auditLogsService.create({
      userId: operator?.id,
      module: 'id_business_v2_options',
      action: 'id_business_v2.option.delete',
      objectType: 'id_business_v2_option',
      objectId: existing.id,
      beforeData: toOptionAuditJson(toOptionResponse(existing)),
      remark: `删除 V2 选项：${existing.name}`
    });

    this.query.clearCache();
    return { deleted: true };
  }

  private async createOption(input: {
    type: IdBusinessV2OptionType;
    name: string;
    parentId: string | null;
    countryOptionId: string | null;
    businessAmount: string | null;
    currencyCode: string | null;
    fixedFee: string;
    percentageFee: string;
    sortOrder: number;
    status: IdBusinessV2OptionStatus;
    remark: string | null;
    uniqueKey: string;
    operatorId?: string;
  }) {
    try {
      return await this.prisma.idBusinessV2Option.create({
        data: {
          type: input.type,
          code: `${input.type}_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
          name: input.name,
          uniqueKey: input.uniqueKey,
          parentId: input.parentId,
          countryOptionId: input.countryOptionId,
          businessAmount: input.businessAmount,
          currencyCode: input.currencyCode,
          fixedFee: input.fixedFee,
          percentageFee: input.percentageFee,
          sortOrder: input.sortOrder,
          status: input.status,
          remark: input.remark,
          createdByUserId: input.operatorId,
          updatedByUserId: input.operatorId
        },
        include: OPTION_INCLUDE
      });
    } catch (error) {
      rethrowOptionUniqueConstraint(error);
    }
  }

  private async updateOption(
    id: string,
    input: {
      name: string;
      parentId: string | null;
      countryOptionId: string | null;
      businessAmount: string | null;
      currencyCode: string | null;
      fixedFee: string;
      percentageFee: string;
      sortOrder: number;
      status: IdBusinessV2OptionStatus;
      remark: string | null;
      uniqueKey: string;
      operatorId?: string;
    }
  ) {
    try {
      return await this.prisma.idBusinessV2Option.update({
        where: { id },
        data: {
          name: input.name,
          uniqueKey: input.uniqueKey,
          parentId: input.parentId,
          countryOptionId: input.countryOptionId,
          businessAmount: input.businessAmount,
          currencyCode: input.currencyCode,
          fixedFee: input.fixedFee,
          percentageFee: input.percentageFee,
          sortOrder: input.sortOrder,
          status: input.status,
          remark: input.remark,
          updatedByUserId: input.operatorId
        },
        include: OPTION_INCLUDE
      });
    } catch (error) {
      rethrowOptionUniqueConstraint(error);
    }
  }

  private async findOptionOrThrow(id: string) {
    const option = await this.prisma.idBusinessV2Option.findFirst({
      where: {
        id,
        deletedAt: null
      },
      include: OPTION_INCLUDE
    });

    if (!option) {
      throw new NotFoundException('V2 选项不存在或已删除');
    }

    return option;
  }

  private async validateParent(
    type: IdBusinessV2OptionType,
    parentIdValue?: string | null,
    currentId?: string
  ) {
    const definition = ID_BUSINESS_V2_OPTION_TYPE_MAP.get(type);
    const parentId = normalizeNullableString(parentIdValue);

    if (!definition?.parentType) {
      if (parentId) {
        throw new BadRequestException('当前选项类型不允许设置上级选项');
      }
      return null;
    }

    if (!parentId) {
      throw new BadRequestException(`${definition.label}必须选择上级选项`);
    }

    if (parentId === currentId) {
      throw new BadRequestException('选项不能将自己设为上级');
    }

    const parent = await this.prisma.idBusinessV2Option.findFirst({
      where: {
        id: parentId,
        type: definition.parentType,
        status: 'active',
        deletedAt: null
      },
      select: {
        id: true,
        type: true,
        name: true
      }
    });

    if (!parent) {
      const parentLabel = ID_BUSINESS_V2_OPTION_TYPE_MAP.get(definition.parentType)?.label;
      throw new BadRequestException(`请选择有效且已启用的${parentLabel ?? '上级选项'}`);
    }

    return parent;
  }

  private async assertUniqueKeyAvailable(uniqueKey: string, excludeId?: string) {
    const duplicate = await this.prisma.idBusinessV2Option.findFirst({
      where: {
        uniqueKey,
        deletedAt: null,
        id: excludeId ? { not: excludeId } : undefined
      },
      select: { id: true }
    });

    if (duplicate) {
      throw new ConflictException('同一类型和上级下已存在同名选项');
    }
  }

  private async assertNoChildren(id: string, action: string, activeOnly: boolean) {
    const [childCount, accountCount] = await this.prisma.$transaction([
      this.prisma.idBusinessV2Option.count({
        where: {
          OR: [{ parentId: id }, { countryOptionId: id }],
          status: activeOnly ? 'active' : undefined,
          deletedAt: null
        }
      }),
      this.prisma.idBusinessV2Account.count({
        where: {
          countryOptionId: id,
          recordStatus: activeOnly ? 'active' : undefined,
          deletedAt: null
        }
      })
    ]);

    if (childCount > 0) {
      throw new ConflictException(`请先停用或删除下级选项，再${action}当前选项`);
    }
    if (accountCount > 0) {
      throw new ConflictException(`该国家仍有 ID 资料使用，不能${action}`);
    }
  }

  private assertMutable(option: OptionWithRelations) {
    if (option.isSystem) {
      throw new ConflictException('系统固定选项不能修改或删除');
    }
  }

  private async normalizeBusinessDetails(
    type: IdBusinessV2OptionType,
    values: {
      countryOptionId?: string | null;
      businessAmount?: string | number | Prisma.Decimal | null;
      currencyCode?: string | null;
    }
  ) {
    const countryOptionId = normalizeNullableString(values.countryOptionId);
    const hasBusinessAmount =
      values.businessAmount !== undefined &&
      values.businessAmount !== null &&
      values.businessAmount !== '';
    const currencyCode = normalizeOptionCurrencyCode(values.currencyCode);

    if (type === 'country') {
      if (countryOptionId || hasBusinessAmount) {
        throw new BadRequestException('国家不能设置业务国家或业务金额');
      }
      if (!currencyCode) {
        throw new BadRequestException('国家必须设置默认货币');
      }
      return {
        countryOption: null,
        businessAmount: null,
        currencyCode
      };
    }

    if (type === 'service') {
      if (!countryOptionId) {
        throw new BadRequestException('开通业务必须选择上级国家');
      }
      if (currencyCode) {
        throw new BadRequestException('开通业务货币由上级国家自动确定');
      }
      const countryOption = await this.prisma.idBusinessV2Option.findFirst({
        where: {
          id: countryOptionId,
          type: 'country',
          status: 'active',
          deletedAt: null
        },
        select: {
          id: true,
          type: true,
          code: true,
          name: true,
          currencyCode: true
        }
      });
      if (!countryOption?.currencyCode) {
        throw new BadRequestException('请选择已设置默认货币且已启用的国家');
      }
      const businessAmount = normalizeOptionDecimal(
        values.businessAmount ?? undefined,
        '业务金额',
        4
      );
      if (new PrismaNamespace.Decimal(businessAmount).lessThanOrEqualTo(0)) {
        throw new BadRequestException('业务金额必须大于 0');
      }
      return {
        countryOption,
        businessAmount,
        currencyCode: null
      };
    }

    if (countryOptionId || hasBusinessAmount || currencyCode) {
      throw new BadRequestException('当前选项类型不允许设置国家、业务金额或货币');
    }
    return {
      countryOption: null,
      businessAmount: null,
      currencyCode: null
    };
  }
}
