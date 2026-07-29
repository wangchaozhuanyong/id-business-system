import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../../audit-logs/audit-logs.module';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { IdBusinessV2BalancesModule } from '../balances/public-api';
import { IdBusinessV2OptionsModule } from '../options/public-api';
import { IdBusinessV2AccountsController } from './id-business-v2-accounts.controller';
import { IdBusinessV2AccountsService } from './id-business-v2-accounts.service';
import {
  IdBusinessV2AccountLossCommandsController,
  IdBusinessV2AccountLossesController
} from './id-business-v2-account-losses.controller';
import { IdBusinessV2AccountLossesService } from './id-business-v2-account-losses.service';

@Module({
  imports: [AuditLogsModule, IdBusinessV2BalancesModule, IdBusinessV2OptionsModule],
  controllers: [
    IdBusinessV2AccountsController,
    IdBusinessV2AccountLossCommandsController,
    IdBusinessV2AccountLossesController
  ],
  providers: [
    FieldEncryptionService,
    IdBusinessV2AccountsService,
    IdBusinessV2AccountLossesService
  ],
  exports: [IdBusinessV2AccountsService, IdBusinessV2AccountLossesService]
})
export class IdBusinessV2AccountsModule {}
