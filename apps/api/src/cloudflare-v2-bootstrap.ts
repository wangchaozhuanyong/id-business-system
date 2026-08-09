import { NestFactory } from '@nestjs/core';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ApiResponseInterceptor } from './common/interceptors/api-response.interceptor';
import {
  ServerTimingInterceptor,
  startServerTiming
} from './common/interceptors/server-timing.interceptor';
import { CloudflareV2AppModule } from './cloudflare-v2-app.module';

export async function createCloudflareV2HttpServer(globalPrefix = 'api') {
  const app = await NestFactory.create(CloudflareV2AppModule, {
    logger: ['error', 'warn']
  });
  const allowedOrigins = process.env.CORS_ORIGIN?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const pagesProjectHost = 'daichongxitong-v2.pages.dev';
  const isSupabaseEdge = globalPrefix !== 'api';

  app.use((request: object, _response: unknown, next: () => void) => {
    startServerTiming(request);
    next();
  });
  app.setGlobalPrefix(globalPrefix);
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new ServerTimingInterceptor(), new ApiResponseInterceptor());
  app.enableCors({
    origin(origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) {
      if (!origin || !allowedOrigins?.length || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      try {
        const originUrl = new URL(origin);
        const isProjectPreview =
          isSupabaseEdge &&
          originUrl.protocol === 'https:' &&
          (originUrl.hostname === pagesProjectHost ||
            originUrl.hostname.endsWith(`.${pagesProjectHost}`));
        callback(null, isProjectPreview);
      } catch {
        callback(null, false);
      }
    },
    credentials: true,
    exposedHeaders: ['Server-Timing', 'X-Request-Id']
  });

  await app.init();
  return app.getHttpServer();
}
