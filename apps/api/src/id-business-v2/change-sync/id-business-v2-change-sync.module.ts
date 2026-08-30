import { Module } from '@nestjs/common';
import { IdBusinessV2ChangeSyncController } from './id-business-v2-change-sync.controller';
import { IdBusinessV2RealtimeController } from './id-business-v2-realtime.controller';
import { IdBusinessV2ChangeSyncService } from './id-business-v2-change-sync.service';
import { IdBusinessV2ChangeSyncRepository } from './persistence/id-business-v2-change-sync.repository';

@Module({
  controllers: [IdBusinessV2ChangeSyncController, IdBusinessV2RealtimeController],
  providers: [IdBusinessV2ChangeSyncRepository, IdBusinessV2ChangeSyncService]
})
export class IdBusinessV2ChangeSyncModule {}
