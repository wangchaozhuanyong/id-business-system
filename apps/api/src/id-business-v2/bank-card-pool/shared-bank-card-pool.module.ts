import { Module } from '@nestjs/common';
import { IdBusinessV2RuntimeModule } from '../runtime/public-api';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { SharedBankCardRepository } from './persistence/shared-bank-card.repository';
import { SharedBankCardController } from './shared-bank-card.controller';

@Module({
  imports: [IdBusinessV2RuntimeModule],
  controllers: [SharedBankCardController],
  providers: [FieldEncryptionService, SharedBankCardRepository],
  exports: [SharedBankCardRepository]
})
export class SharedBankCardPoolModule {}
