import { Injectable } from '@nestjs/common';
import { getPagination, type PaginationQuery } from '../../common/pagination';
import {
  normalizeAccountLossKeyword,
  normalizeAccountLossSaleState,
  normalizeAccountLossStatus,
  normalizeOptionalAccountLossUuid
} from './id-business-v2-account-loss-input';
import { buildIdBusinessV2DateRange } from '../runtime/public-api';
import { toAccountLossRecordResponse } from './id-business-v2-account-loss-response';
import { IdBusinessV2AccountLossRepository } from './id-business-v2-account-loss.repository';

export interface ListIdBusinessV2AccountLossesQuery extends PaginationQuery {
  keyword?: string;
  countryOptionId?: string;
  saleState?: string;
  status?: string;
  reportedFrom?: string;
  reportedTo?: string;
  sortBy?: string;
  sortOrder?: string;
}

const SORT_FIELDS = {
  reportedAt: 'reportedAt',
  lossBalance: 'lossBalance',
  lossCostAmount: 'lossCostAmount'
} as const;

@Injectable()
export class IdBusinessV2AccountLossQueryService {
  constructor(private readonly repository: IdBusinessV2AccountLossRepository) {}

  async list(query: ListIdBusinessV2AccountLossesQuery) {
    const pagination = getPagination(query);
    const keyword = normalizeAccountLossKeyword(query.keyword);
    const countryOptionId = normalizeOptionalAccountLossUuid(query.countryOptionId, '国家');
    const saleState = normalizeAccountLossSaleState(query.saleState);
    const status = normalizeAccountLossStatus(query.status);
    const reportedAt = this.buildReportedAtFilter(query.reportedFrom, query.reportedTo);
    const sortBy =
      query.sortBy && Object.prototype.hasOwnProperty.call(SORT_FIELDS, query.sortBy)
        ? SORT_FIELDS[query.sortBy as keyof typeof SORT_FIELDS]
        : null;
    const sortOrder =
      query.sortOrder === 'asc' || query.sortOrder === 'desc' ? query.sortOrder : null;
    const { items, total } = await this.repository.list({
      keyword,
      countryOptionId,
      saleState,
      status,
      reportedFrom: reportedAt?.gte ?? null,
      reportedToExclusive: reportedAt?.lt ?? null,
      sortBy,
      sortOrder,
      skip: pagination.skip,
      take: pagination.take
    });

    return {
      items: items.map((item, index) => ({
        rowNumber: pagination.skip + index + 1,
        ...toAccountLossRecordResponse(item)
      })),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize
    };
  }

  private buildReportedAtFilter(fromValue?: string, toValue?: string) {
    return buildIdBusinessV2DateRange(fromValue, toValue, {
      from: '开始日期',
      to: '结束日期',
      invalidRange: '开始日期不能晚于结束日期'
    });
  }
}
