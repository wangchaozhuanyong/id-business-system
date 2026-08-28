import { Module } from '@nestjs/common';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { IdBusinessV2RuntimeModule } from '../runtime/public-api';
import { IdBusinessV2MailViewerService } from './id-business-v2-mail-viewer.service';
import { IdBusinessV2ManagedMailboxController } from './id-business-v2-managed-mailbox.controller';
import { IdBusinessV2ManagedMailboxService } from './id-business-v2-managed-mailbox.service';
import { IdBusinessV2PublicMailboxController } from './id-business-v2-public-mailbox.controller';
import { IdBusinessV2WorkspaceController } from './id-business-v2-workspace.controller';
import { IdBusinessV2WorkspaceService } from './id-business-v2-workspace.service';
import { IdBusinessV2ManagedMailboxRepository } from './persistence/id-business-v2-managed-mailbox.repository';
import { IdBusinessV2WorkspaceRepository } from './persistence/id-business-v2-workspace.repository';
import { IdBusinessV2ImapMailProvider } from './providers/id-business-v2-imap-mail.provider';

@Module({
  imports: [IdBusinessV2RuntimeModule],
  controllers: [
    IdBusinessV2WorkspaceController,
    IdBusinessV2ManagedMailboxController,
    IdBusinessV2PublicMailboxController
  ],
  providers: [
    IdBusinessV2WorkspaceService,
    IdBusinessV2WorkspaceRepository,
    FieldEncryptionService,
    IdBusinessV2ManagedMailboxService,
    IdBusinessV2ManagedMailboxRepository,
    IdBusinessV2MailViewerService,
    IdBusinessV2ImapMailProvider
  ]
})
export class IdBusinessV2WorkspaceModule {}
