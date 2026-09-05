import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException
} from '@nestjs/common';
import type { V2WebsiteAnalyticsDays, V2WebsiteAnalyticsReport } from '@apple-business/shared';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { IdBusinessV2WebsiteAnalyticsClient } from './providers/id-business-v2-website-analytics.client';
import { parseWebsiteAnalyticsReport } from './id-business-v2-website-analytics-report';

@Injectable()
export class IdBusinessV2WebsiteAnalyticsService {
  private readonly cache = new Map<
    V2WebsiteAnalyticsDays,
    { expiresAt: number; data: V2WebsiteAnalyticsReport }
  >();
  private readonly pending = new Map<V2WebsiteAnalyticsDays, Promise<V2WebsiteAnalyticsReport>>();

  constructor(private readonly client: IdBusinessV2WebsiteAnalyticsClient) {}

  async report(input: unknown, operator?: AuthenticatedUser): Promise<V2WebsiteAnalyticsReport> {
    if (!operator?.id || !operator.roles.includes('admin'))
      throw new ForbiddenException('仅管理员可查看网站访问统计');
    if (input !== undefined && input !== '7' && input !== '30') {
      throw new BadRequestException('统计范围只支持近 7 天或近 30 天');
    }
    const days: V2WebsiteAnalyticsDays = input === '30' ? 30 : 7;
    if (!this.client.isConfigured()) {
      return {
        status: 'not_configured',
        days,
        fetchedAt: new Date().toISOString(),
        timeZone: null,
        utcOffset: null,
        thresholded: false,
        summary: null,
        daily: []
      };
    }
    const cached = this.cache.get(days);
    if (cached && cached.expiresAt > Date.now()) return cached.data;
    const pending = this.pending.get(days);
    if (pending) return pending;
    const request = this.load(days);
    this.pending.set(days, request);
    try {
      return await request;
    } finally {
      this.pending.delete(days);
    }
  }

  private async load(days: V2WebsiteAnalyticsDays) {
    try {
      const response = await this.client.reports(days);
      const data = parseWebsiteAnalyticsReport(response.reports, days, new Date());
      this.cache.set(days, { data, expiresAt: Date.now() + 60_000 });
      return data;
    } catch {
      // Upstream errors can contain credentials and account information. Never expose them.
      throw new ServiceUnavailableException(
        '访问统计读取失败，请检查专用只读授权、统计服务和网络后重试'
      );
    }
  }
}
