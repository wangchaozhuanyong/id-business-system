import { Module } from '@nestjs/common';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { IdBusinessV2OptionsModule } from '../options/public-api';
import { IdBusinessV2RuntimeModule } from '../runtime/public-api';
import { IdBusinessV2CustomersController } from './id-business-v2-customers.controller';
import { IdBusinessV2CustomersService } from './id-business-v2-customers.service';
import { IdBusinessV2CustomerRepository } from './persistence/id-business-v2-customer.repository';

@Module({
  imports: [IdBusinessV2OptionsModule, IdBusinessV2RuntimeModule],
  controllers: [IdBusinessV2CustomersController],
  providers: [FieldEncryptionService, IdBusinessV2CustomersService, IdBusinessV2CustomerRepository],
  exports: [IdBusinessV2CustomersService]
})
export class IdBusinessV2CustomersModule {}
