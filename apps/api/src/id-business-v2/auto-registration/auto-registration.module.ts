import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../../audit-logs/audit-logs.module';
import { V2AuthModule } from '../../v2-auth/v2-auth.module';
import { AutoRegistrationController } from './auto-registration.controller';
import { AutoRegistrationService } from './auto-registration.service';

@Module({
  imports: [AuditLogsModule, V2AuthModule],
  controllers: [AutoRegistrationController],
  providers: [AutoRegistrationService],
  exports: [AutoRegistrationService]
})
export class AutoRegistrationModule {}
