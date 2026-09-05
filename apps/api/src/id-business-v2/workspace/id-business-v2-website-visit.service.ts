import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { V2WebsiteVisitReport } from '@apple-business/shared';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import { IdBusinessV2WebsiteVisitRepository } from './persistence/id-business-v2-website-visit.repository';
import {
  maskWebsiteVisitIp,
  normalizeWebsiteVisitIp,
  parseWebsiteVisitSearch,
  WEBSITE_VISIT_DAY_MS,
  websiteVisitId,
  websiteVisitRange,
  type WebsiteVisitEvent
} from './id-business-v2-website-visit-input';

@Injectable()
export class IdBusinessV2WebsiteVisitService {
  constructor(
    private readonly repository: IdBusinessV2WebsiteVisitRepository,
    private readonly encryption: FieldEncryptionService,
    private readonly transaction: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService,
    private readonly config: ConfigService
  ) {}

  async ingest(event: WebsiteVisitEvent) {
    const ip = normalizeWebsiteVisitIp(event.ip);
    const ipEncrypted = this.encryption.encrypt(ip);
    const ipHash = this.encryption.hash('flashcast-visit:' + ip);
    if (!ipEncrypted || !ipHash) throw new ServiceUnavailableException('访问记录加密失败');
    const id = websiteVisitId(event.eventId);
    return this.transaction.execute(
      async (tx) => {
        const created = await this.repository.insert(tx, {
          id,
          host: event.host,
          path: event.path,
          occurredAt: new Date(event.occurredAt),
          ipEncrypted,
          ipHash
        });
        if (created)
          await this.audit.append(tx, {
            module: 'id_business_v2',
            action: 'id_business_v2.website_visit.collect',
            objectType: 'id_business_v2_website_visit',
            objectId: id,
            remark: '已采集装修网站页面访问'
          });
        return { accepted: true as const };
      },
      {
        changedScopes: ['workspace'],
        requestId: id,
        retryMode: 'stableIdempotency',
        idempotencyKey: id,
        replay: async (tx) => {
          if (!(await this.repository.find(id, tx)))
            throw new ServiceUnavailableException('访问记录保存失败');
          return { accepted: true as const };
        }
      }
    );
  }

  async search(value: unknown, operator?: AuthenticatedUser): Promise<V2WebsiteVisitReport> {
    this.requireAdmin(operator);
    const query = parseWebsiteVisitSearch(value);
    const now = new Date();
    const range = websiteVisitRange(query.days, now);
    const empty: V2WebsiteVisitReport = {
      status: 'not_configured',
      days: query.days,
      fetchedAt: now.toISOString(),
      lastReceivedAt: null,
      summary: null,
      daily: range.dates.map((date) => ({ date, metrics: null })),
      items: [],
      total: 0,
      page: 1,
      pageSize: query.pageSize
    };
    if ((this.config.get<string>('WEBSITE_VISIT_INGEST_SECRET')?.trim().length ?? 0) < 32)
      return empty;
    try {
      const result = await this.repository.report({
        ...query,
        ...range,
        ipHash: query.ip
          ? (this.encryption.hash('flashcast-visit:' + query.ip) ?? undefined)
          : undefined
      });
      const daily = new Map(result.daily.map((row) => [row.date, row.metrics]));
      return {
        ...empty,
        status: result.summary.pageViews ? 'ready' : 'empty',
        summary: result.summary.pageViews ? result.summary : null,
        daily: range.dates.map((date) => ({ date, metrics: daily.get(date) ?? null })),
        total: result.summary.pageViews,
        page: result.page,
        lastReceivedAt: result.lastReceivedAt?.toISOString() ?? null,
        items: result.items.map((row) => ({
          id: row.id,
          path: row.path,
          occurredAt: row.occurredAt.toISOString(),
          ipMasked: maskWebsiteVisitIp(this.decryptIp(row.ipEncrypted))
        }))
      };
    } catch {
      throw new ServiceUnavailableException('访问记录读取失败，请稍后重试');
    }
  }

  async reveal(value: unknown, operator?: AuthenticatedUser) {
    this.requireAdmin(operator);
    const id = websiteVisitId(value);
    return this.transaction.execute(
      async (tx) => {
        const row = await this.repository.find(id, tx);
        if (!row || row.occurredAt.getTime() < Date.now() - 30 * WEBSITE_VISIT_DAY_MS)
          throw new NotFoundException('访问记录不存在或已过保留期限');
        const ip = this.decryptIp(row.ipEncrypted);
        await this.audit.append(tx, {
          userId: operator!.id,
          module: 'id_business_v2',
          action: 'id_business_v2.website_visit.reveal',
          objectType: 'id_business_v2_website_visit',
          objectId: id,
          remark: '管理员查看完整访客 IP'
        });
        return { ip };
      },
      {
        changedScopes: ['workspace'],
        requestId: 'website-visit-reveal',
        operator,
        retryMode: 'none'
      }
    );
  }

  async removeExpired() {
    const before = new Date(Date.now() - 30 * WEBSITE_VISIT_DAY_MS);
    const rows = await this.repository.expiredIds(before);
    if (!rows.length) return 0;
    return this.transaction.execute(
      async (tx) => {
        const result = await this.repository.removeExpired(
          tx,
          rows.map((row) => row.id),
          before
        );
        if (result.count)
          await this.audit.append(tx, {
            module: 'id_business_v2',
            action: 'id_business_v2.website_visit.retention',
            objectType: 'id_business_v2_website_visit',
            afterData: { removed: result.count },
            remark: '清理超过 30 天的在线访问记录'
          });
        return result.count;
      },
      { changedScopes: ['workspace'], requestId: 'website-visit-retention', retryMode: 'none' }
    );
  }

  private requireAdmin(operator?: AuthenticatedUser) {
    if (!operator?.id || !operator.roles.includes('admin'))
      throw new ForbiddenException('仅管理员可查看访客 IP');
  }

  private decryptIp(value: string) {
    try {
      return normalizeWebsiteVisitIp(this.encryption.decrypt(value));
    } catch {
      throw new ServiceUnavailableException('访问记录暂时无法解密');
    }
  }
}
