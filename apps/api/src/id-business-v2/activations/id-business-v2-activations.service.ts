import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { IdBusinessV2ActivationStatus } from '@prisma/client';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { getPagination, type PaginationQuery } from '../../common/pagination';
import { buildIdBusinessV2DateRange } from '../runtime/public-api';
import { IdBusinessV2SensitiveAccessService } from '../sensitive-access/public-api';
import type { ActivationRecord, ActivationSortField } from './activation.types';
import {
  ID_BUSINESS_V2_DUE_STATUS_CODES,
  IdBusinessV2ActivationStatusService,
  type IdBusinessV2ActivationDueStatus
} from './id-business-v2-activation-status.service';
import { IdBusinessV2ActivationRepository } from './persistence/id-business-v2-activation.repository';

export interface ListIdBusinessV2ActivationsQuery extends PaginationQuery {
  keyword?: string;
  customerId?: string;
  serviceOptionId?: string;
  accountId?: string;
  status?: string;
  dueStatus?: string;
  openedFrom?: string;
  openedTo?: string;
  dueFrom?: string;
  dueTo?: string;
  sortBy?: string;
  sortOrder?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVATION_STATUSES = new Set<IdBusinessV2ActivationStatus>([
  'active',
  'expired',
  'cancelled',
  'abnormal'
]);
const DUE_STATUSES = new Set<IdBusinessV2ActivationDueStatus>(ID_BUSINESS_V2_DUE_STATUS_CODES);

const SORT_FIELDS: Record<string, ActivationSortField> = {
  openedAt: 'openedAt',
  dueAt: 'dueAt',
  status: 'status',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

@Injectable()
export class IdBusinessV2ActivationsService {
  constructor(
    private readonly repository: IdBusinessV2ActivationRepository,
    private readonly activationStatusService: IdBusinessV2ActivationStatusService,
    private readonly fieldEncryptionService: FieldEncryptionService,
    private readonly sensitiveAccessService: IdBusinessV2SensitiveAccessService
  ) {}

  async list(query: ListIdBusinessV2ActivationsQuery, operator?: AuthenticatedUser) {
    const pagination = getPagination(query);
    const keyword = this.normalizeKeyword(query.keyword);
    const now = new Date();
    const status = this.parseStoredStatus(query.status);
    const dueStatus = this.parseDueStatus(query.dueStatus);
    const result = await this.repository.list({
      keyword,
      customerId: this.normalizeOptionalUuid(query.customerId, '客户'),
      serviceOptionId: this.normalizeOptionalUuid(query.serviceOptionId, '业务'),
      accountId: this.normalizeOptionalUuid(query.accountId, '苹果 ID'),
      status,
      dueFilter: dueStatus ? this.activationStatusService.getFilterWindow(dueStatus, now) : null,
      openedAt: this.parseDateRange(query.openedFrom, query.openedTo, '开通日期'),
      dueAt: this.parseDateRange(query.dueFrom, query.dueTo, '到期日期'),
      sortField: this.buildSortField(query),
      sortDirection: query.sortOrder === 'asc' ? 'asc' : 'desc',
      skip: pagination.skip,
      take: pagination.take,
      evaluatedAt: now
    });

    return {
      items: await this.presentActivations(result.items, now, operator),
      total: result.total,
      page: pagination.page,
      pageSize: pagination.pageSize,
      evaluatedAt: now,
      revalidateAt: this.activationStatusService.getNextRevalidateAt(result.nextTimedDueAt, now)
    };
  }

  async get(idValue: string, operator?: AuthenticatedUser) {
    const id = this.normalizeRequiredUuid(idValue, '开通记录');
    const activation = await this.repository.findById(id);
    if (!activation) {
      throw new NotFoundException('开通记录不存在');
    }
    const now = new Date();
    return (await this.presentActivations([activation], now, operator))[0];
  }

  private async presentActivations(
    activations: ActivationRecord[],
    evaluatedAt: Date,
    operator?: AuthenticatedUser
  ) {
    if (!operator) return activations.map((item) => this.toResponse(item, evaluatedAt));
    const modes = await this.sensitiveAccessService.resolveDisplayModes(
      operator,
      ['account.apple_id', 'order.website_account'],
      'business_records'
    );
    return activations.map((item) =>
      this.toResponse(item, evaluatedAt, {
        appleId:
          modes['account.apple_id'] === 'hidden'
            ? null
            : modes['account.apple_id'] === 'full'
              ? this.fieldEncryptionService.decrypt(item.account.appleIdEncrypted)
              : item.account.appleIdMasked,
        websiteAccount:
          modes['order.website_account'] === 'hidden'
            ? null
            : modes['order.website_account'] === 'full'
              ? this.fieldEncryptionService.decrypt(item.order.websiteAccountEncrypted)
              : item.order.websiteAccountMasked
      })
    );
  }

  private buildSortField(query: ListIdBusinessV2ActivationsQuery): ActivationSortField {
    return SORT_FIELDS[query.sortBy ?? 'openedAt'] ?? 'openedAt';
  }

  private parseDateRange(
    fromValue: unknown,
    toValue: unknown,
    label: string
  ): { gte?: Date; lt?: Date } | undefined {
    return buildIdBusinessV2DateRange(fromValue, toValue, {
      from: `${label}开始`,
      to: `${label}结束`,
      invalidRange: `${label}开始不能晚于结束`
    });
  }

  private parseStoredStatus(value: unknown) {
    const normalized = this.normalizeNullableString(value);
    if (!normalized) return null;
    if (ACTIVATION_STATUSES.has(normalized as IdBusinessV2ActivationStatus)) {
      return normalized as IdBusinessV2ActivationStatus;
    }
    throw new BadRequestException('开通记录状态无效');
  }

  private parseDueStatus(value: unknown) {
    const normalized = this.normalizeNullableString(value);
    if (!normalized) return null;
    if (DUE_STATUSES.has(normalized as IdBusinessV2ActivationDueStatus)) {
      return normalized as IdBusinessV2ActivationDueStatus;
    }
    throw new BadRequestException('到期状态无效');
  }

  private normalizeKeyword(value: unknown) {
    const normalized = this.normalizeNullableString(value);
    if (normalized && normalized.length > 160) {
      throw new BadRequestException('搜索关键词不能超过 160 个字符');
    }
    return normalized;
  }

  private normalizeOptionalUuid(value: unknown, label: string) {
    const normalized = this.normalizeNullableString(value);
    return normalized ? this.normalizeRequiredUuid(normalized, label) : null;
  }

  private normalizeRequiredUuid(value: unknown, label: string) {
    const normalized = this.normalizeNullableString(value);
    if (!normalized || !UUID_PATTERN.test(normalized)) {
      throw new BadRequestException(`${label}格式无效`);
    }
    return normalized;
  }

  private normalizeNullableString(value: unknown) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new BadRequestException('参数格式无效');
    }
    return String(value).trim() || null;
  }

  private toResponse(
    activation: ActivationRecord,
    evaluatedAt: Date,
    presentation?: { appleId: string | null; websiteAccount: string | null }
  ) {
    const status = this.activationStatusService.resolveDisplay(
      activation.status,
      activation.dueAt,
      activation.serviceOption.id,
      activation.renewedBy?.serviceOptionId ?? null,
      evaluatedAt
    );
    return {
      id: activation.id,
      orderId: activation.orderId,
      order: {
        id: activation.order.id,
        orderNo: activation.order.orderNo,
        status: activation.order.status,
        receivedAmount: activation.order.receivedAmount.toString(),
        profitAmount: activation.order.profitAmount?.toString() ?? null
      },
      customer: activation.customer,
      service: activation.serviceOption,
      account: {
        id: activation.account.id,
        appleIdMasked: activation.account.appleIdMasked,
        displayAppleId: presentation ? presentation.appleId : activation.account.appleIdMasked,
        country: activation.account.countryOption
      },
      maskedWebsiteAccount: activation.order.websiteAccountMasked,
      displayWebsiteAccount: presentation
        ? presentation.websiteAccount
        : activation.order.websiteAccountMasked,
      openedAt: activation.openedAt,
      dueAt: activation.dueAt,
      storedStatus: activation.status,
      status,
      remark: activation.remark,
      statusChangedAt: activation.statusChangedAt,
      createdBy: activation.createdBy,
      createdAt: activation.createdAt,
      updatedAt: activation.updatedAt
    };
  }
}
