import { Injectable } from '@nestjs/common';
import {
  V2_DATA_SCOPES,
  isV2DataScope,
  type V2ChangeVersionsResult,
  type V2DataScope
} from '@apple-business/shared';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class IdBusinessV2ChangeSyncService {
  constructor(private readonly prisma: PrismaService) {}

  async getVersions(): Promise<V2ChangeVersionsResult> {
    const records = await this.prisma.idBusinessV2ScopeVersion.findMany({
      orderBy: {
        scope: 'asc'
      }
    });
    const versions = Object.fromEntries(V2_DATA_SCOPES.map((scope) => [scope, '0'])) as Record<
      V2DataScope,
      string
    >;

    for (const record of records) {
      if (isV2DataScope(record.scope)) {
        versions[record.scope] = record.version.toString();
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      versions
    };
  }
}
