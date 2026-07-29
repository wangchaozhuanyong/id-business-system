import { Controller, Get, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Public } from './auth/auth.decorators';
import { PrismaService } from './common/prisma/prisma.service';

@Controller('health')
export class AppController {
  private readonly logger = new Logger(AppController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('live')
  live() {
    return {
      status: 'ok'
    };
  }

  @Public()
  @Get('ready')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      const safeMessage =
        error instanceof Error
          ? error.message
              .replace(/postgres(?:ql)?:\/\/[^\s)]+/gi, '[redacted-database-url]')
              .replace(/(password|token|secret)=([^\s&,]+)/gi, '$1=[redacted]')
              .slice(0, 500)
          : 'Unknown database readiness error';
      this.logger.error(`Database readiness check failed: ${safeMessage}`);
      console.error(`[V2 API] Database readiness check failed: ${safeMessage}`);
      throw new ServiceUnavailableException('Database is not ready');
    }

    return {
      status: 'ready',
      database: 'ok'
    };
  }
}
