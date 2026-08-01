import { Module } from '@nestjs/common';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { IdBusinessV2BalancesModule } from '../balances/public-api';
import { IdBusinessV2FinanceModule } from '../finance/public-api';
import { IdBusinessV2OptionsModule } from '../options/public-api';
import { IdBusinessV2RuntimeModule } from '../runtime/public-api';
import { IdBusinessV2AccountsController } from './id-business-v2-accounts.controller';
import { IdBusinessV2AccountsService } from './id-business-v2-accounts.service';
import { IdBusinessV2AccountBalanceAdjustmentService } from './id-business-v2-account-balance-adjustment.service';
import {
  IdBusinessV2AccountLossCommandsController,
  IdBusinessV2AccountLossesController
} from './id-business-v2-account-losses.controller';
import { IdBusinessV2AccountLossCommandHandler } from './id-business-v2-account-loss.command-handler';
import { IdBusinessV2AccountLossPostingCoordinator } from './id-business-v2-account-loss-posting.coordinator';
import { IdBusinessV2AccountLossQueryService } from './id-business-v2-account-loss-query.service';
import { IdBusinessV2AccountLossRepository } from './id-business-v2-account-loss.repository';
import { IdBusinessV2AccountLossesService } from './id-business-v2-account-losses.service';
import { IdBusinessV2AccountsRepository } from './persistence/id-business-v2-accounts.repository';

@Module({
  imports: [
    IdBusinessV2BalancesModule,
    IdBusinessV2FinanceModule,
    IdBusinessV2OptionsModule,
    IdBusinessV2RuntimeModule
  ],
  controllers: [
    IdBusinessV2AccountsController,
    IdBusinessV2AccountLossCommandsController,
    IdBusinessV2AccountLossesController
  ],
  providers: [
    FieldEncryptionService,
    IdBusinessV2AccountBalanceAdjustmentService,
    IdBusinessV2AccountsService,
    IdBusinessV2AccountLossCommandHandler,
    IdBusinessV2AccountLossPostingCoordinator,
    IdBusinessV2AccountLossQueryService,
    IdBusinessV2AccountLossRepository,
    IdBusinessV2AccountLossesService,
    IdBusinessV2AccountsRepository
  ],
  exports: [IdBusinessV2AccountsService, IdBusinessV2AccountLossesService]
})
export class IdBusinessV2AccountsModule {}
