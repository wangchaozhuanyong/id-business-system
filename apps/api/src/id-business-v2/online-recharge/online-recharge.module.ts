import { OnlineRechargeVendureController } from './vendure-integration.controller';
import { OnlineRechargeVendureIntegration } from './vendure-integration.service';
import { ProxyPoolModule } from '../proxy-pool/public-api';
import { SharedBankCardPoolModule } from '../bank-card-pool/public-api';
import { Module } from '@nestjs/common';
import { IdBusinessV2RuntimeModule } from '../runtime/public-api';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { OnlineRechargeAdminController } from './admin.controller';
import { OnlineRechargePublicController, OnlineRechargePublicLimiter } from './public.controller';
import { OnlineRechargeWorkerController } from './worker.controller';
import { OnlineRechargeRepository } from './persistence/online-recharge.repository';
import { OnlineRechargeWorkerRepository } from './persistence/worker.repository';
import { OnlineRechargeAdminService } from './admin.service';
import { OnlineRechargeAssetsService } from './assets.service';
import { OnlineRechargeSettingsService } from './settings.service';
import { OnlineRechargeTasksService } from './tasks.service';
import { OnlineRechargeWorkerService } from './worker.service';
import { OnlineRechargeWebhooksService } from './webhooks.service';
import { OnlineRechargeEphemeralCredentials } from './ephemeral-credentials.service';
import { OnlineRechargeArtifactsService } from './artifacts.service';
import { OnlineRechargeProgressWebsocket } from './progress-websocket.service';
import { OnlineRechargeSettingsRepository } from './persistence/settings.repository';
import { OnlineRechargeAssetsRepository } from './persistence/assets.repository';
import { OnlineRechargeTasksRepository } from './persistence/tasks.repository';
import { OnlineRechargeArtifactsRepository } from './persistence/artifacts.repository';
import { OnlineRechargeAdminRepository } from './persistence/admin.repository';
import { OnlineRechargeWebhooksRepository } from './persistence/webhooks.repository';
import { OnlineRechargeWorkerRpcRepository } from './persistence/worker-rpc.repository';
import { OnlineRechargeSecurityNotificationService } from './security-notification.service';
import { OnlineRechargeSecurityNotificationRepository } from './persistence/security-notification.repository';
import { AuthLoginEventsModule } from '../../auth/login-events';
import { OnlineRechargeLoginNotificationBridge } from './login-notification-bridge.service';
import { RechargeModule } from '../auto-recharge/public-api';
import { OnlineRechargeOrderSyncService } from './order-sync.service';
import { OnlineRechargeOrderSyncRepository } from './persistence/order-sync.repository';
import { OnlineRechargeReconciliationService } from './reconciliation.service';
import { OnlineRechargeHumanVerification } from './human-verification.service';

@Module({
  imports: [
    SharedBankCardPoolModule,
    ProxyPoolModule,
    IdBusinessV2RuntimeModule,
    AuthLoginEventsModule,
    RechargeModule
  ],
  controllers: [
    OnlineRechargeVendureController,
    OnlineRechargeAdminController,
    OnlineRechargePublicController,
    OnlineRechargeWorkerController
  ],
  exports: [OnlineRechargeSecurityNotificationService],
  providers: [
    OnlineRechargeHumanVerification,
    OnlineRechargeVendureIntegration,
    FieldEncryptionService,
    OnlineRechargeRepository,
    OnlineRechargeWorkerRepository,
    OnlineRechargeOrderSyncService,
    OnlineRechargeReconciliationService,
    OnlineRechargeOrderSyncRepository,
    OnlineRechargeAdminService,
    OnlineRechargeAssetsService,
    OnlineRechargeSettingsService,
    OnlineRechargeTasksService,
    OnlineRechargeWorkerService,
    OnlineRechargeWebhooksService,
    OnlineRechargeEphemeralCredentials,
    OnlineRechargeArtifactsService,
    OnlineRechargeProgressWebsocket,
    OnlineRechargePublicLimiter,
    OnlineRechargeSettingsRepository,
    OnlineRechargeAssetsRepository,
    OnlineRechargeTasksRepository,
    OnlineRechargeArtifactsRepository,
    OnlineRechargeAdminRepository,
    OnlineRechargeWebhooksRepository,
    OnlineRechargeWorkerRpcRepository,
    OnlineRechargeSecurityNotificationService,
    OnlineRechargeSecurityNotificationRepository,
    OnlineRechargeLoginNotificationBridge
  ]
})
export class OnlineRechargeModule {}
