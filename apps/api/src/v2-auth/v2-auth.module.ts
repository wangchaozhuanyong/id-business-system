import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import type ms from 'ms';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { FieldEncryptionService } from '../common/crypto/field-encryption.service';
import { SecurityService } from '../security/security.service';
import { AuthService } from '../auth/auth.service';
import { AuthAvailabilityMonitor } from '../auth/auth-availability.monitor';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { V2AuthController } from './v2-auth.controller';
import { V2EmployeesController } from './employees/v2-employees.controller';
import { V2EmployeesService } from './employees/v2-employees.service';
import { V2IdentityService } from './v2-identity.service';
import { V2ProfileController } from './profile/v2-profile.controller';
import { V2ProfileService } from './profile/v2-profile.service';
import { V2RolesController } from './roles/v2-roles.controller';
import { V2RolesService } from './roles/v2-roles.service';
import { V2SecurityController } from './security/v2-security.controller';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const nodeEnv = configService.get<string>('NODE_ENV') ?? 'development';
        const secret = configService.get<string>('JWT_SECRET');
        if (!secret && nodeEnv === 'production') {
          throw new Error('JWT_SECRET is required in production');
        }

        return {
          secret: secret ?? 'dev-only-jwt-secret',
          signOptions: {
            expiresIn: (configService.get<string>('JWT_EXPIRES_IN') ?? '7d') as ms.StringValue
          }
        };
      }
    })
  ],
  controllers: [
    V2AuthController,
    V2EmployeesController,
    V2RolesController,
    V2SecurityController,
    V2ProfileController
  ],
  providers: [
    AuditLogsService,
    FieldEncryptionService,
    SecurityService,
    V2IdentityService,
    V2EmployeesService,
    V2ProfileService,
    V2RolesService,
    AuthService,
    AuthAvailabilityMonitor,
    JwtAuthGuard,
    PermissionsGuard,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard
    },
    {
      provide: APP_GUARD,
      useClass: PermissionsGuard
    }
  ],
  exports: [AuthAvailabilityMonitor, JwtAuthGuard, PermissionsGuard]
})
export class V2AuthModule {}
