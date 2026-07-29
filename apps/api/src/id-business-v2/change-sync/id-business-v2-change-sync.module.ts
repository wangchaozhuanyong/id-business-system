import { Module } from '@nestjs/common';
import { IdBusinessV2ChangeSyncController } from './id-business-v2-change-sync.controller';
import { IdBusinessV2ChangeSyncService } from './id-business-v2-change-sync.service';

@Module({
  controllers: [IdBusinessV2ChangeSyncController],
  providers: [IdBusinessV2ChangeSyncService]
})
export class IdBusinessV2ChangeSyncModule {}
