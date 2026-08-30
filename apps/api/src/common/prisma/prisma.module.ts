import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { V2ChangeEventPublisher } from './v2-change-event.publisher';

@Global()
@Module({
  providers: [PrismaService, V2ChangeEventPublisher],
  exports: [PrismaService, V2ChangeEventPublisher]
})
export class PrismaModule {}
