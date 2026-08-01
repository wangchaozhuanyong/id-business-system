import { Module } from '@nestjs/common';
import { IdBusinessV2RuntimeModule } from '../runtime/public-api';
import { IdBusinessV2OptionQuery } from './id-business-v2-option-query';
import { IdBusinessV2OptionsController } from './id-business-v2-options.controller';
import { IdBusinessV2OptionsService } from './id-business-v2-options.service';
import { IdBusinessV2OptionRepository } from './persistence/id-business-v2-option.repository';

@Module({
  imports: [IdBusinessV2RuntimeModule],
  controllers: [IdBusinessV2OptionsController],
  providers: [IdBusinessV2OptionsService, IdBusinessV2OptionQuery, IdBusinessV2OptionRepository],
  exports: [IdBusinessV2OptionsService]
})
export class IdBusinessV2OptionsModule {}
