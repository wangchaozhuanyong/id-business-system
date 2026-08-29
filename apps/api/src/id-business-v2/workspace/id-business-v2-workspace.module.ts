import { Module } from '@nestjs/common';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { IdBusinessV2RuntimeModule } from '../runtime/public-api';
import { IdBusinessV2MailViewerService } from './id-business-v2-mail-viewer.service';
import { IdBusinessV2MailboxTransientStateService } from './id-business-v2-mailbox-transient-state.service';
import { IdBusinessV2ManagedMailboxController } from './id-business-v2-managed-mailbox.controller';
import { IdBusinessV2ManagedMailboxSettingsService } from './id-business-v2-managed-mailbox-settings.service';
import { IdBusinessV2ManagedMailboxService } from './id-business-v2-managed-mailbox.service';
import { IdBusinessV2MicrosoftMailboxOAuthController } from './id-business-v2-microsoft-mailbox-oauth.controller';
import { IdBusinessV2MicrosoftMailboxAuthorizationService } from './id-business-v2-microsoft-mailbox-authorization.service';
import { IdBusinessV2PublicMailboxController } from './id-business-v2-public-mailbox.controller';
import { IdBusinessV2TotpAccountController } from './id-business-v2-totp-account.controller';
import { IdBusinessV2TotpAccountService } from './id-business-v2-totp-account.service';
import { IdBusinessV2WorkspaceController } from './id-business-v2-workspace.controller';
import { IdBusinessV2WorkspaceService } from './id-business-v2-workspace.service';
import { IdBusinessV2ManagedMailboxRepository } from './persistence/id-business-v2-managed-mailbox.repository';
import { IdBusinessV2TotpAccountRepository } from './persistence/id-business-v2-totp-account.repository';
import { IdBusinessV2WorkspaceRepository } from './persistence/id-business-v2-workspace.repository';
import { IdBusinessV2ImapMailProvider } from './providers/id-business-v2-imap-mail.provider';
import { IdBusinessV2MicrosoftMailOAuthClient } from './providers/id-business-v2-microsoft-mail-oauth.client';

@Module({
  imports: [IdBusinessV2RuntimeModule],
  controllers: [
    IdBusinessV2WorkspaceController,
    IdBusinessV2TotpAccountController,
    IdBusinessV2ManagedMailboxController,
    IdBusinessV2MicrosoftMailboxOAuthController,
    IdBusinessV2PublicMailboxController
  ],
  providers: [
    IdBusinessV2WorkspaceService,
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
    IdBusinessV2MicrosoftMailboxAuthorizationService
  ]
})
export class IdBusinessV2WorkspaceModule {}
