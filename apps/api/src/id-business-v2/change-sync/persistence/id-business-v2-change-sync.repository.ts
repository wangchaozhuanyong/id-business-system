import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';

@Injectable()
export class IdBusinessV2ChangeSyncRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listScopeVersions() {
    const rows = await this.prisma.idBusinessV2ScopeVersion.findMany({
      orderBy: { scope: 'asc' },
      select: { scope: true, version: true }
    });
    return rows.map((row) => ({ scope: row.scope, version: row.version.toString() }));
  }
}
