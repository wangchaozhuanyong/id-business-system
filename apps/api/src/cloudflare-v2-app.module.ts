import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AppController } from './app.controller';
import { AuditLogsModule } from './audit-logs/audit-logs.module';
import { SensitiveActionAuditInterceptor } from './audit-logs/sensitive-action-audit.interceptor';
import { CloudflarePrismaModule } from './common/prisma/cloudflare-prisma.module';
import { validateEnv } from './config/env.validation';
import { IdBusinessV2Module } from './id-business-v2/id-business-v2.module';
import { V2AuthModule } from './v2-auth/v2-auth.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      validate: validateEnv
    }),
    CloudflarePrismaModule,
    V2AuthModule,
    AuditLogsModule,
    IdBusinessV2Module
  ],
  controllers: [AppController],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: SensitiveActionAuditInterceptor
    }
  ]
})
export class CloudflareV2AppModule {}
