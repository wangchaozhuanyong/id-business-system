import { Injectable, NotFoundException } from '@nestjs/common';
import { getPagination } from '../../common/pagination';
import { parseJobStatus, parseJobType, parseRecycleEntity } from './data-governance.types';
import { IdBusinessV2DataGovernanceQueryRepository } from './persistence/id-business-v2-data-governance-query.repository';

@Injectable()
export class IdBusinessV2DataGovernanceQueryService {
  constructor(private readonly repository: IdBusinessV2DataGovernanceQueryRepository) {}

  async recycleBin(query: { page?: string; pageSize?: string; entity?: string }) {
    const pagination = getPagination(query);
    const entity = parseRecycleEntity(query.entity, true);
    const { rows, counts } = await this.repository.recycleBinRows({
      entity: entity ?? null,
      skip: pagination.skip,
      take: pagination.take
    });
    const total = entity
      ? counts[entity]
      : Object.values(counts).reduce((sum, count) => sum + count, 0);

    return {
      items: rows.map((row) => ({
        id: row.id,
        entity: row.entity,
        label: row.label,
        deletedAt: row.deleted_at.toISOString(),
        restoreReadiness: 'review_required' as const
      })),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize,
      byEntity: counts
    };
  }

  async jobs(query: { page?: string; pageSize?: string; type?: string; status?: string }) {
    const pagination = getPagination(query);
    const type = parseJobType(query.type);
    const status = parseJobStatus(query.status);
    const { items, total } = await this.repository.listJobs({
      type: type ?? null,
      status: status ?? null,
      skip: pagination.skip,
      take: pagination.take
    });
    return { items, total, page: pagination.page, pageSize: pagination.pageSize };
  }

  async job(id: string) {
    const job = await this.repository.findJob(id);
    if (!job) throw new NotFoundException('数据治理任务不存在');
    return job;
  }

  async recycleCounts() {
    return this.repository.recycleCounts();
  }
}
