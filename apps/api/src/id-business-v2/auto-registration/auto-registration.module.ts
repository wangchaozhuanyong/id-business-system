import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../../audit-logs/audit-logs.module';
import { V2AuthModule } from '../../v2-auth/v2-auth.module';
import { AutoRegistrationController } from './auto-registration.controller';
import { AutoRegistrationService } from './auto-registration.service';
import { IdBusinessV2WorkspaceModule } from '../workspace/public-api';
import { AppleMailboxesController } from './apple-mailboxes.controller';
import { AppleMailboxesService } from './apple-mailboxes.service';
import { RechargeModule } from '../auto-recharge/public-api';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { AppleMailboxTaskBridgeService } from './apple-mailboxes-task-bridge.service';

@Module({
  imports: [AuditLogsModule, V2AuthModule, IdBusinessV2WorkspaceModule, RechargeModule],
  controllers: [AutoRegistrationController, AppleMailboxesController],
  providers: [
    AutoRegistrationService,
    AppleMailboxesService,
    FieldEncryptionService,
    AppleMailboxTaskBridgeService
  ],
  exports: [AutoRegistrationService]
})
export class AutoRegistrationModule {}
