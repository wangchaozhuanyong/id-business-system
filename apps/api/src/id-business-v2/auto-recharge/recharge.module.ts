import { BankRechargeSubscriptionReviewService } from './bank-recharge-subscription-review.service';
import { BankRechargeLifecycleService } from './bank-recharge-lifecycle.service';
import { BankRechargeLifecycleRepository } from './persistence/bank-recharge-lifecycle.repository';
import { BankRechargeFeesService } from './bank-recharge-fees.service';
import { Module } from '@nestjs/common';
import { RechargeNameService } from './recharge-name.service';
import { RechargeNameRepository } from './persistence/recharge-name.repository';
import { RechargeNameController } from './recharge-name.controller';
import { RechargeCardRemovalService } from './recharge-card-removal.service';
import { RechargeCardRemovalRepository } from './persistence/recharge-card-removal.repository';
import { IdBusinessV2RuntimeModule } from '../runtime/public-api';
import { RechargeRepository } from './persistence/recharge.repository';
import { RechargeAddressRepository } from './persistence/recharge-address.repository';
import { RechargeController } from './recharge.controller';
import { RechargeService } from './recharge.service';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { RechargeLocalService } from './recharge-local.service';
import { RechargeSettingsService } from './recharge-settings.service';
import { RechargeSettingsRepository } from './persistence/recharge-settings.repository';
import { RechargeProxyController } from './recharge-proxy.controller';
import { RechargeProxyService } from './recharge-proxy.service';
import { RechargeProxyRepository } from './persistence/recharge-proxy.repository';
import { BankRechargeController } from './bank-recharge.controller';
import { BankRechargeAccountDeliveryService } from './bank-recharge-account-delivery.service';
import { IdBusinessV2WorkspaceModule } from '../workspace/public-api';
import { BankRechargeAccountService } from './bank-recharge-account.service';
import { BankRechargeCardService } from './bank-recharge-card.service';
import { BankRechargeCardRepository } from './persistence/bank-recharge-card.repository';
import { BankRechargeOrderService } from './bank-recharge-order.service';
import { BankRechargeQueryRepository } from './persistence/bank-recharge-query.repository';
import { BankRechargeRepository } from './persistence/bank-recharge.repository';
import { BankRechargeCorrectionService } from './bank-recharge-correction.service';
import { BankRechargeFinanceService } from './bank-recharge-finance.service';
import { IdBusinessV2FinanceModule } from '../finance/public-api';
import { V2IdentityService } from '../../v2-auth/v2-identity.service';
import { RechargeEmailCodeController } from './recharge-email-code.controller';
import { RechargeEmailCodeService } from './recharge-email-code.service';
@Module({
  imports: [IdBusinessV2RuntimeModule, IdBusinessV2FinanceModule, IdBusinessV2WorkspaceModule],
  controllers: [
    RechargeEmailCodeController,
    RechargeController,
    BankRechargeController,
    RechargeProxyController,
    RechargeNameController
  ],
  exports: [RechargeSettingsService, RechargeProxyService],
  providers: [
    BankRechargeSubscriptionReviewService,
    BankRechargeLifecycleService,
    BankRechargeLifecycleRepository,
    RechargeEmailCodeService,
    V2IdentityService,
    RechargeNameService,
    RechargeNameRepository,
    RechargeCardRemovalService,
    RechargeCardRemovalRepository,
    BankRechargeFeesService,
    FieldEncryptionService,
    BankRechargeAccountService,
    BankRechargeAccountDeliveryService,
    BankRechargeCardService,
    BankRechargeCardRepository,
    BankRechargeOrderService,
    BankRechargeQueryRepository,
    BankRechargeRepository,
    BankRechargeFinanceService,
    BankRechargeCorrectionService,
    RechargeService,
    RechargeLocalService,
    RechargeSettingsService,
    RechargeRepository,
    RechargeAddressRepository,
    RechargeSettingsRepository,
    RechargeProxyService,
    RechargeProxyRepository
  ]
})
export class RechargeModule {}
