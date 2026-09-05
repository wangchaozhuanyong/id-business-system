import { Module } from '@nestjs/common';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { IdBusinessV2RuntimeModule } from '../runtime/public-api';
import { IdBusinessV2MailViewerService } from './id-business-v2-mail-viewer.service';
import { IdBusinessV2MediaResolverController } from './id-business-v2-media-resolver.controller';
import { IdBusinessV2MediaResolverService } from './id-business-v2-media-resolver.service';
import { IdBusinessV2MailboxTransientStateService } from './id-business-v2-mailbox-transient-state.service';
import { IdBusinessV2ManagedMailboxController } from './id-business-v2-managed-mailbox.controller';
import { IdBusinessV2ManagedMailboxSettingsService } from './id-business-v2-managed-mailbox-settings.service';
import { IdBusinessV2ManagedMailboxService } from './id-business-v2-managed-mailbox.service';
import { IdBusinessV2MicrosoftMailboxOAuthController } from './id-business-v2-microsoft-mailbox-oauth.controller';
import { IdBusinessV2MicrosoftMailboxAuthorizationService } from './id-business-v2-microsoft-mailbox-authorization.service';
import { IdBusinessV2PublicMailboxController } from './id-business-v2-public-mailbox.controller';
import { IdBusinessV2RelayScriptController } from './id-business-v2-relay-script.controller';
import { IdBusinessV2RelayJobRunnerService } from './id-business-v2-relay-job-runner.service';
import { IdBusinessV2RelayAlternativeRunnerService } from './id-business-v2-relay-alternative-runner.service';
import { IdBusinessV2RelayJobCreationService } from './id-business-v2-relay-job-creation.service';
import { IdBusinessV2RelayScriptOAuthController } from './id-business-v2-relay-script-oauth.controller';
import { IdBusinessV2RelayScriptService } from './id-business-v2-relay-script.service';
import { IdBusinessV2RelaySubscriptionAuthService } from './id-business-v2-relay-subscription-auth.service';
import { IdBusinessV2TotpAccountController } from './id-business-v2-totp-account.controller';
import { IdBusinessV2TotpAccountService } from './id-business-v2-totp-account.service';
import { IdBusinessV2WorkspaceController } from './id-business-v2-workspace.controller';
import { IdBusinessV2WorkspaceService } from './id-business-v2-workspace.service';
import { IdBusinessV2WebsiteMonitorController } from './id-business-v2-website-monitor.controller';
import { IdBusinessV2WebsiteMonitorService } from './id-business-v2-website-monitor.service';
import { IdBusinessV2WebsiteAnalyticsService } from './id-business-v2-website-analytics.service';
import { IdBusinessV2WebsiteAnalyticsClient } from './providers/id-business-v2-website-analytics.client';
import { IdBusinessV2ManagedMailboxRepository } from './persistence/id-business-v2-managed-mailbox.repository';
import { IdBusinessV2RelayScriptRepository } from './persistence/id-business-v2-relay-script.repository';
import { IdBusinessV2TotpAccountRepository } from './persistence/id-business-v2-totp-account.repository';
import { IdBusinessV2WorkspaceRepository } from './persistence/id-business-v2-workspace.repository';
import { IdBusinessV2ImapMailProvider } from './providers/id-business-v2-imap-mail.provider';
import { IdBusinessV2MicrosoftMailOAuthClient } from './providers/id-business-v2-microsoft-mail-oauth.client';
import { IdBusinessV2RelayCloudBridgeClient } from './providers/id-business-v2-relay-cloudbridge.client';
import { IdBusinessV2RelayGoogleCloudClient } from './providers/id-business-v2-relay-google-cloud.client';
import { IdBusinessV2RelayGeminiClient } from './providers/id-business-v2-relay-gemini.client';
import { IdBusinessV2RelayGoogleOAuthClient } from './providers/id-business-v2-relay-google-oauth.client';
import { IdBusinessV2GoogleSheetsSyncController } from './id-business-v2-google-sheets-sync.controller';
import { IdBusinessV2GoogleSheetsOAuthController } from './id-business-v2-google-sheets-oauth.controller';
import { IdBusinessV2GoogleSheetsSyncService } from './id-business-v2-google-sheets-sync.service';
import { IdBusinessV2GoogleSheetsSyncWorker } from './id-business-v2-google-sheets-sync.worker';
import { IdBusinessV2GoogleSheetsSyncRepository } from './persistence/id-business-v2-google-sheets-sync.repository';
import { IdBusinessV2GoogleSheetsClient } from './providers/id-business-v2-google-sheets.client';
import { IdBusinessV2GoogleSheetsOAuthClient } from './providers/id-business-v2-google-sheets-oauth.client';

import { IdBusinessV2WebsiteVisitController } from './id-business-v2-website-visit.controller';
import { IdBusinessV2WebsiteVisitService } from './id-business-v2-website-visit.service';
import { IdBusinessV2WebsiteVisitSignatureGuard } from './id-business-v2-website-visit-signature.guard';
import { IdBusinessV2WebsiteVisitRetentionWorker } from './id-business-v2-website-visit-retention.worker';
import { IdBusinessV2WebsiteVisitRepository } from './persistence/id-business-v2-website-visit.repository';

@Module({
  imports: [IdBusinessV2RuntimeModule],
  controllers: [
    IdBusinessV2WebsiteVisitController,
    IdBusinessV2WorkspaceController,
    IdBusinessV2WebsiteMonitorController,
    IdBusinessV2MediaResolverController,
    IdBusinessV2TotpAccountController,
    IdBusinessV2ManagedMailboxController,
    IdBusinessV2MicrosoftMailboxOAuthController,
    IdBusinessV2PublicMailboxController,
    IdBusinessV2RelayScriptController,
    IdBusinessV2RelayScriptOAuthController,
    IdBusinessV2GoogleSheetsSyncController,
    IdBusinessV2GoogleSheetsOAuthController
  ],
  providers: [
    IdBusinessV2WebsiteVisitService,
    IdBusinessV2WebsiteVisitSignatureGuard,
    IdBusinessV2WebsiteVisitRetentionWorker,
    IdBusinessV2WebsiteVisitRepository,
    IdBusinessV2WorkspaceService,
    IdBusinessV2WebsiteMonitorService,
    IdBusinessV2WebsiteAnalyticsService,
    IdBusinessV2WebsiteAnalyticsClient,
    IdBusinessV2MediaResolverService,
    IdBusinessV2WorkspaceRepository,
    IdBusinessV2TotpAccountService,
    IdBusinessV2TotpAccountRepository,
    FieldEncryptionService,
    IdBusinessV2MailboxTransientStateService,
    IdBusinessV2ManagedMailboxService,
    IdBusinessV2ManagedMailboxSettingsService,
    IdBusinessV2ManagedMailboxRepository,
    IdBusinessV2MailViewerService,
    IdBusinessV2ImapMailProvider,
    IdBusinessV2MicrosoftMailOAuthClient,
    IdBusinessV2MicrosoftMailboxAuthorizationService,
    IdBusinessV2RelayScriptService,
    IdBusinessV2RelayJobRunnerService,
    IdBusinessV2RelayAlternativeRunnerService,
    IdBusinessV2RelayJobCreationService,
    IdBusinessV2RelaySubscriptionAuthService,
    IdBusinessV2RelayScriptRepository,
    IdBusinessV2RelayCloudBridgeClient,
    IdBusinessV2RelayGoogleCloudClient,
    IdBusinessV2RelayGeminiClient,
    IdBusinessV2RelayGoogleOAuthClient,
    IdBusinessV2GoogleSheetsSyncService,
    IdBusinessV2GoogleSheetsSyncWorker,
    IdBusinessV2GoogleSheetsSyncRepository,
    IdBusinessV2GoogleSheetsClient,
    IdBusinessV2GoogleSheetsOAuthClient
  ]
})
export class IdBusinessV2WorkspaceModule {}
