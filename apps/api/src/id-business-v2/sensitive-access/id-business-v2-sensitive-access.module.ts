import { Module } from '@nestjs/common';
import { IdBusinessV2RuntimeModule } from '../runtime/public-api';
import { IdBusinessV2SensitiveAccessController } from './id-business-v2-sensitive-access.controller';
import { IdBusinessV2SensitiveAccessService } from './id-business-v2-sensitive-access.service';
import { IdBusinessV2SensitiveAccessRepository } from './persistence/id-business-v2-sensitive-access.repository';

@Module({
  imports: [IdBusinessV2RuntimeModule],
  controllers: [IdBusinessV2SensitiveAccessController],
  providers: [IdBusinessV2SensitiveAccessService, IdBusinessV2SensitiveAccessRepository],
  exports: [IdBusinessV2SensitiveAccessService]
})
export class IdBusinessV2SensitiveAccessModule {}
