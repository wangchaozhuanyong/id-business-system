import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../../audit-logs/audit-logs.module';
import { IdBusinessV2OptionsController } from './id-business-v2-options.controller';
import { IdBusinessV2OptionsService } from './id-business-v2-options.service';

@Module({
  imports: [AuditLogsModule],
  controllers: [IdBusinessV2OptionsController],
  providers: [IdBusinessV2OptionsService],
  exports: [IdBusinessV2OptionsService]
})
export class IdBusinessV2OptionsModule {}
