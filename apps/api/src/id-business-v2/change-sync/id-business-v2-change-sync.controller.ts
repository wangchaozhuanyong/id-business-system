import { Controller, Get } from '@nestjs/common';
import { IdBusinessV2ChangeSyncService } from './id-business-v2-change-sync.service';

@Controller('id-business-v2/change-versions')
export class IdBusinessV2ChangeSyncController {
  constructor(private readonly changeSyncService: IdBusinessV2ChangeSyncService) {}

  @Get()
  getVersions() {
    return this.changeSyncService.getVersions();
  }
}
