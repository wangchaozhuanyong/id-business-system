import { Module } from '@nestjs/common';
import { IdBusinessV2RuntimeModule } from '../runtime/public-api';
import { IdBusinessV2WorkspaceModule } from '../workspace/public-api';
import { RechargeModule } from '../auto-recharge/public-api';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { RegistrationRepository } from './persistence/registration.repository';
import { RegistrationController } from './registration.controller';
import { RegistrationCallbackController } from './registration-callback.controller';
import { RegistrationNamesService } from './registration-names.service';
import { RegistrationJobsService } from './registration-jobs.service';
import { RegistrationEventsService } from './registration-events.service';
import { RegistrationMailboxesService } from './registration-mailboxes.service';

@Module({
  imports: [IdBusinessV2RuntimeModule, IdBusinessV2WorkspaceModule, RechargeModule],
  controllers: [RegistrationController, RegistrationCallbackController],
  providers: [
    RegistrationRepository,
    RegistrationNamesService,
    RegistrationJobsService,
    RegistrationEventsService,
    RegistrationMailboxesService,
    FieldEncryptionService
  ]
})
export class RegistrationModule {}
