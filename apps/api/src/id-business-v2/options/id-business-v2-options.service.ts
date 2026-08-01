import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { V2_DECIMAL_PLACES } from '@apple-business/shared';
import type { CreateIdBusinessV2OptionDto } from './dto/create-id-business-v2-option.dto';
import type { UpdateIdBusinessV2OptionDto } from './dto/update-id-business-v2-option.dto';
import {
  IdBusinessV2OptionQuery,
  type ListIdBusinessV2OptionsQuery
} from './id-business-v2-option-query';
import {
  Amount4,
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  type V2CommandTransaction
} from '../runtime/public-api';
import {
  toOptionAuditJson,
  toOptionResponse,
  type OptionWithRelations
} from './id-business-v2-option-support';
import {
  ID_BUSINESS_V2_OPTION_TYPE_MAP,
  type IdBusinessV2OptionType
} from './id-business-v2-options.constants';
import {
  buildOptionUniqueKey,
  normalizeNullableString,
  normalizeOptionCurrencyCode,
  normalizeOptionDecimal,
  normalizeOptionFees,
  normalizeOptionName,
  normalizeOptionSortOrder,
  parseOptionStatus,
  parseOptionType
} from './id-business-v2-option-input';
import {
  IdBusinessV2OptionRepository,
  type PersistOptionInput
} from './persistence/id-business-v2-option.repository';

interface OptionCommandMetadata {
  requestId?: string;
}

@Injectable()
export class IdBusinessV2OptionsService {
  constructor(
    private readonly repository: IdBusinessV2OptionRepository,
    private readonly query: IdBusinessV2OptionQuery,
    private readonly transactionManager: V2CommandTransactionManager,
    private readonly transactionalAudit: V2TransactionalAuditService
  ) {}

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
    return toOptionResponse(await this.findOptionOrThrow(id));
  }

  async requireActiveOption(
    idValue: string | null | undefined,
    type: IdBusinessV2OptionType,
    label: string,
    optional = false,
    tx?: V2CommandTransaction
  ) {
    const id = normalizeNullableString(idValue);
    if (!id) {
      if (optional) return null;
      throw new BadRequestException(`${label}不能为空`);
    }

    const option = await this.repository.findActiveOption(id, type, tx);
    if (!option) throw new BadRequestException(`${label}不存在或已停用`);
    return option;
  }

  async requireActiveOptions(
    idValues: string[] | null | undefined,
    type: IdBusinessV2OptionType,
    label: string,
    tx?: V2CommandTransaction
  ) {
    const ids = [
      ...new Set(
        (idValues ?? [])
          .map((value) => normalizeNullableString(value))
          .filter((value): value is string => Boolean(value))
      )
    ];
    if (!ids.length) return [];

    const options = await this.repository.findActiveOptions(ids, type, tx);
    if (options.length !== ids.length) {
      throw new BadRequestException(`${label}包含不存在或已停用的选项`);
    }

    const optionMap = new Map(options.map((option) => [option.id, option]));
    return ids.map((id) => optionMap.get(id)!);
  }

  create(
    dto: CreateIdBusinessV2OptionDto,
    operator?: AuthenticatedUser,
    metadata: OptionCommandMetadata = {}
  ) {
    return this.transactionManager.execute(
      async (tx) => {
        const type = parseOptionType(dto.type, true);
        const name = normalizeOptionName(dto.name);
        const parent = await this.validateParent(tx, type, dto.parentId);
        const businessDetails = await this.normalizeBusinessDetails(tx, type, {
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
        await this.assertUniqueKeyAvailable(tx, uniqueKey);

        const option = await this.repository.create(tx, {
          type,
          code: `${type}_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
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

        await this.transactionalAudit.append(tx, {
          userId: operator?.id,
          module: 'id_business_v2_options',
          action: 'id_business_v2.option.create',
          objectType: 'id_business_v2_option',
          objectId: option.id,
          afterData: toOptionAuditJson(toOptionResponse(option)),
          remark: `创建 V2 选项：${option.name}`
        });
        return toOptionResponse(option);
      },
      {
        requestId: metadata.requestId ?? randomUUID(),
        operator,
        uniqueConflictMessage: '同一类型和上级下已存在同名选项'
      }
    );
  }

  update(
    id: string,
    dto: UpdateIdBusinessV2OptionDto,
    operator?: AuthenticatedUser,
    metadata: OptionCommandMetadata = {}
  ) {
    return this.transactionManager.execute(
      async (tx) => {
        const existing = await this.findOptionOrThrowInTransaction(tx, id);
        this.assertMutable(existing);

        const name = dto.name === undefined ? existing.name : normalizeOptionName(dto.name);
        const parent =
          dto.parentId === undefined
            ? existing.parent
            : await this.validateParent(tx, existing.type, dto.parentId, existing.id);
        const parentId = parent?.id ?? null;
        const businessDetails = await this.normalizeBusinessDetails(tx, existing.type, {
          countryOptionId:
            dto.countryOptionId === undefined ? existing.countryOptionId : dto.countryOptionId,
          businessAmount:
            dto.businessAmount === undefined ? existing.businessAmount : dto.businessAmount,
          currencyCode: dto.currencyCode === undefined ? existing.currencyCode : dto.currencyCode
        });
        const uniqueKey = buildOptionUniqueKey(
          existing.type,
          parentId,
          businessDetails.countryOption?.id ?? null,
          name
        );
        if (uniqueKey !== existing.uniqueKey) {
          await this.assertUniqueKeyAvailable(tx, uniqueKey, existing.id);
        }

        const status =
          dto.status === undefined ? existing.status : parseOptionStatus(dto.status, true);
        if (status === 'disabled') {
          await this.assertNoChildren(tx, existing.id, '停用', true);
        }
        const fees = normalizeOptionFees(
          existing.type,
          dto.fixedFee === undefined ? existing.fixedFee.toString() : dto.fixedFee,
          dto.percentageFee === undefined ? existing.percentageFee.toString() : dto.percentageFee
        );

        const input: PersistOptionInput = {
          name,
          parentId,
          countryOptionId: businessDetails.countryOption?.id ?? null,
          businessAmount: businessDetails.businessAmount,
          currencyCode: businessDetails.currencyCode,
          fixedFee: fees.fixedFee,
          percentageFee: fees.percentageFee,
          sortOrder:
            dto.sortOrder === undefined
              ? existing.sortOrder
              : normalizeOptionSortOrder(dto.sortOrder),
          status,
          remark: dto.remark === undefined ? existing.remark : normalizeNullableString(dto.remark),
          uniqueKey,
          operatorId: operator?.id
        };
        const option = await this.repository.update(tx, existing.id, input);
        await this.transactionalAudit.append(tx, {
          userId: operator?.id,
          module: 'id_business_v2_options',
          action: 'id_business_v2.option.update',
          objectType: 'id_business_v2_option',
          objectId: option.id,
          beforeData: toOptionAuditJson(toOptionResponse(existing)),
          afterData: toOptionAuditJson(toOptionResponse(option)),
          remark: `修改 V2 选项：${existing.name}`
        });
        return toOptionResponse(option);
      },
      {
        requestId: metadata.requestId ?? randomUUID(),
        operator,
        uniqueConflictMessage: '同一类型和上级下已存在同名选项'
      }
    );
  }

  remove(id: string, operator?: AuthenticatedUser, metadata: OptionCommandMetadata = {}) {
    return this.transactionManager.execute(
      async (tx, context) => {
        const existing = await this.findOptionOrThrowInTransaction(tx, id);
        this.assertMutable(existing);
        await this.assertNoChildren(tx, existing.id, '删除', false);
        await this.repository.softDelete(tx, {
          id: existing.id,
          uniqueKey: existing.uniqueKey,
          deletedAt: context.businessTime,
          operatorId: operator?.id
        });
        await this.transactionalAudit.append(tx, {
          userId: operator?.id,
          module: 'id_business_v2_options',
          action: 'id_business_v2.option.delete',
          objectType: 'id_business_v2_option',
          objectId: existing.id,
          beforeData: toOptionAuditJson(toOptionResponse(existing)),
          remark: `删除 V2 选项：${existing.name}`
        });
        return { deleted: true };
      },
      { requestId: metadata.requestId ?? randomUUID(), operator }
    );
  }

  private async findOptionOrThrow(id: string) {
    const option = await this.repository.findById(id);
    if (!option) throw new NotFoundException('V2 选项不存在或已删除');
    return option;
  }

  private async findOptionOrThrowInTransaction(tx: V2CommandTransaction, id: string) {
    const option = await this.repository.findByIdInTransaction(tx, id);
    if (!option) throw new NotFoundException('V2 选项不存在或已删除');
    return option;
  }

  private async validateParent(
    tx: V2CommandTransaction,
    type: IdBusinessV2OptionType,
    parentIdValue?: string | null,
    currentId?: string
  ) {
    const definition = ID_BUSINESS_V2_OPTION_TYPE_MAP.get(type);
    const parentId = normalizeNullableString(parentIdValue);
    if (!definition?.parentType) {
      if (parentId) throw new BadRequestException('当前选项类型不允许设置上级选项');
      return null;
    }
    if (!parentId) throw new BadRequestException(`${definition.label}必须选择上级选项`);
    if (parentId === currentId) throw new BadRequestException('选项不能将自己设为上级');

    const parent = await this.repository.findActiveParent(tx, parentId, definition.parentType);
    if (!parent) {
      const parentLabel = ID_BUSINESS_V2_OPTION_TYPE_MAP.get(definition.parentType)?.label;
      throw new BadRequestException(`请选择有效且已启用的${parentLabel ?? '上级选项'}`);
    }
    return parent;
  }

  private async assertUniqueKeyAvailable(
    tx: V2CommandTransaction,
    uniqueKey: string,
    excludeId?: string
  ) {
    if (await this.repository.findDuplicate(tx, uniqueKey, excludeId)) {
      throw new ConflictException('同一类型和上级下已存在同名选项');
    }
  }

  private async assertNoChildren(
    tx: V2CommandTransaction,
    id: string,
    action: string,
    activeOnly: boolean
  ) {
    const { childCount, accountCount } = await this.repository.countDependencies(
      tx,
      id,
      activeOnly
    );
    if (childCount > 0) {
      throw new ConflictException(`请先停用或删除下级选项，再${action}当前选项`);
    }
    if (accountCount > 0) {
      throw new ConflictException(`该国家仍有 ID 资料使用，不能${action}`);
    }
  }

  private assertMutable(option: OptionWithRelations) {
    if (option.isSystem) throw new ConflictException('系统固定选项不能修改或删除');
  }

  private async normalizeBusinessDetails(
    tx: V2CommandTransaction,
    type: IdBusinessV2OptionType,
    values: {
      countryOptionId?: string | null;
      businessAmount?: string | number | { toString(): string } | null;
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
      if (!currencyCode) throw new BadRequestException('国家必须设置默认货币');
      return { countryOption: null, businessAmount: null, currencyCode };
    }

    if (type === 'service') {
      if (!countryOptionId) throw new BadRequestException('开通业务必须选择上级国家');
      if (currencyCode) throw new BadRequestException('开通业务货币由上级国家自动确定');
      const countryOption = await this.repository.findActiveCountry(tx, countryOptionId);
      if (!countryOption?.currencyCode) {
        throw new BadRequestException('请选择已设置默认货币且已启用的国家');
      }
      const businessAmount = normalizeOptionDecimal(
        values.businessAmount ?? undefined,
        '业务金额',
        V2_DECIMAL_PLACES
      );
      if (Amount4.from(businessAmount).lte(0)) {
        throw new BadRequestException('业务金额必须大于 0');
      }
      return { countryOption, businessAmount, currencyCode: null };
    }

    if (countryOptionId || hasBusinessAmount || currencyCode) {
      throw new BadRequestException('当前选项类型不允许设置国家、业务金额或货币');
    }
    return { countryOption: null, businessAmount: null, currencyCode: null };
  }
}
