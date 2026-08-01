import { Module } from '@nestjs/common';
import { IdBusinessV2ActivationStatusService } from './id-business-v2-activation-status.service';
import { IdBusinessV2ActivationsController } from './id-business-v2-activations.controller';
import { IdBusinessV2ActivationsService } from './id-business-v2-activations.service';
import { IdBusinessV2ActivationRepository } from './persistence/id-business-v2-activation.repository';

@Module({
  controllers: [IdBusinessV2ActivationsController],
  providers: [
    IdBusinessV2ActivationRepository,
    IdBusinessV2ActivationStatusService,
    IdBusinessV2ActivationsService
  ],
  exports: [IdBusinessV2ActivationStatusService, IdBusinessV2ActivationsService]
})
export class IdBusinessV2ActivationsModule {}
