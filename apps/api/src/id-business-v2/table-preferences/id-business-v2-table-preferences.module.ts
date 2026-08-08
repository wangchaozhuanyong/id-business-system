import { Module } from '@nestjs/common';
import { IdBusinessV2RuntimeModule } from '../runtime/public-api';
import { IdBusinessV2TablePreferencesController } from './id-business-v2-table-preferences.controller';
import { IdBusinessV2TablePreferencesService } from './id-business-v2-table-preferences.service';
import { IdBusinessV2TablePreferencesRepository } from './persistence/id-business-v2-table-preferences.repository';

@Module({
  imports: [IdBusinessV2RuntimeModule],
  controllers: [IdBusinessV2TablePreferencesController],
  providers: [IdBusinessV2TablePreferencesService, IdBusinessV2TablePreferencesRepository]
})
export class IdBusinessV2TablePreferencesModule {}
