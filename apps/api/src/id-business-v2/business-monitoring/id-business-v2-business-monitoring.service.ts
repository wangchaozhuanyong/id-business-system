import { BadRequestException, Injectable } from '@nestjs/common';
import { getPagination, type PaginationQuery } from '../../common/pagination';
import {
  IdBusinessV2BusinessMonitoringRepository,
  type BusinessMonitoringSummaryRow
} from './persistence/id-business-v2-business-monitoring.repository';
const SEVERITIES = new Set(['critical', 'warning', 'info']);
const CATEGORIES = new Set(['order', 'balance', 'renewal', 'exchange_rate', 'finance']);

export interface BusinessMonitoringQuery extends PaginationQuery {
  severity?: string;
  category?: string;
}

const RULES = [
  {
    key: 'order_failed',
    category: 'order',
    severity: 'critical',
    title: '失败订单',
    description: '订单当前状态为失败，需要复核原因并修正源订单。'
  },
  {
    key: 'order_stalled',
    category: 'order',
    severity: 'warning',
    title: '长时间未完成订单',
    description: '草稿、待处理、等待外部或处理中订单超过 24 小时未更新。'
  },
  {
    key: 'renewal_overdue',
    category: 'renewal',
    severity: 'critical',
    title: '已逾期开通记录',
    description: '有效开通记录已超过到期时间。'
  },
  {
    key: 'renewal_due_soon',
    category: 'renewal',
    severity: 'warning',
    title: '即将到期',
    description: '有效开通记录已进入续费预警窗口。'
  },
  {
    key: 'activation_abnormal',
    category: 'renewal',
    severity: 'critical',
    title: '异常开通记录',
    description: '开通记录当前状态为异常。'
  },
  {
    key: 'account_negative_balance',
    category: 'balance',
    severity: 'warning',
    title: 'ID 余额为负',
    description: '未售且未报损 ID 的当前余额小于 0。'
  },
  {
    key: 'supplier_fund_negative',
    category: 'balance',
    severity: 'critical',
    title: '加卡供应商资金为负',
    description: '已启用加卡供应商的人民币余额小于 0。'
  },
  {
    key: 'exchange_rate_failed',
    category: 'exchange_rate',
    severity: 'warning',
    title: '汇率采集失败',
    description: '最近 24 小时内的汇率采集运行失败。'
  },
  {
    key: 'finance_history_incomplete',
    category: 'finance',
    severity: 'warning',
    title: '财务历史基线未完成',
    description: '历史回填、期初余额或遗漏开支尚未完整确认。'
  }
] as const;

@Injectable()
export class IdBusinessV2BusinessMonitoringService {
  constructor(private readonly repository: IdBusinessV2BusinessMonitoringRepository) {}

  async list(query: BusinessMonitoringQuery, now = new Date()) {
    const pagination = getPagination(query);
    const severity = this.parseFilter(query.severity, SEVERITIES, '风险级别');
    const category = this.parseFilter(query.category, CATEGORIES, '异常分类');
    const warningDays = await this.repository.getRenewalWarningDays();
    const { items, filteredCountRows, summaryRows } = await this.repository.loadPage({
      now,
      warningDays,
      severity,
      category,
      skip: pagination.skip,
      take: pagination.take
    });

    return {
      rules: RULES,
      summary: this.buildSummary(summaryRows),
      result: {
        items: items.map((item) => ({
          ...item,
          detectedAt: item.detectedAt.toISOString(),
          status: 'open' as const,
          resolutionMode: 'source_state' as const
        })),
        total: Number(filteredCountRows[0]?.count ?? 0n),
        page: pagination.page,
        pageSize: pagination.pageSize
      },
      generatedAt: now.toISOString(),
      timezone: 'Asia/Kuala_Lumpur'
    };
  }

  private buildSummary(rows: BusinessMonitoringSummaryRow[]) {
    const summary = {
      total: 0,
      critical: 0,
      warning: 0,
      info: 0,
      byCategory: { order: 0, balance: 0, renewal: 0, exchange_rate: 0, finance: 0 }
    };
    for (const row of rows) {
      const count = Number(row.count);
      summary.total += count;
      if (row.severity === 'critical') summary.critical += count;
      if (row.severity === 'warning') summary.warning += count;
      if (row.severity === 'info') summary.info += count;
      if (row.category in summary.byCategory) {
        summary.byCategory[row.category as keyof typeof summary.byCategory] += count;
      }
    }
    return summary;
  }

  private parseFilter(value: unknown, allowed: Set<string>, label: string) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const normalized = value.trim();
    if (!allowed.has(normalized)) throw new BadRequestException(`${label}无效`);
    return normalized;
  }
}
