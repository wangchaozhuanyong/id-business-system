import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../../audit-logs/audit-logs.module';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { IdBusinessV2BalancesModule } from '../balances/public-api';
import { IdBusinessV2OptionsModule } from '../options/public-api';
import { IdBusinessV2AccountsController } from './id-business-v2-accounts.controller';
import { IdBusinessV2AccountsService } from './id-business-v2-accounts.service';

@Module({
  imports: [AuditLogsModule, IdBusinessV2BalancesModule, IdBusinessV2OptionsModule],
  controllers: [IdBusinessV2AccountsController],
  providers: [FieldEncryptionService, IdBusinessV2AccountsService],
  exports: [IdBusinessV2AccountsService]
})
export class IdBusinessV2AccountsModule {}
