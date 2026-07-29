import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../../audit-logs/audit-logs.module';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { IdBusinessV2OptionsModule } from '../options/public-api';
import { IdBusinessV2CustomersController } from './id-business-v2-customers.controller';
import { IdBusinessV2CustomersService } from './id-business-v2-customers.service';

@Module({
  imports: [AuditLogsModule, IdBusinessV2OptionsModule],
  controllers: [IdBusinessV2CustomersController],
  providers: [FieldEncryptionService, IdBusinessV2CustomersService],
  exports: [IdBusinessV2CustomersService]
})
export class IdBusinessV2CustomersModule {}
