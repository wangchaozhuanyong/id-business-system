import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { CloudflarePrismaService } from './cloudflare-prisma.service';

@Global()
@Module({
  providers: [
    CloudflarePrismaService,
    {
      provide: PrismaService,
      useExisting: CloudflarePrismaService
    }
  ],
  exports: [PrismaService]
})
export class CloudflarePrismaModule {}
