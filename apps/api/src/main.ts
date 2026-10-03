import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { configureProductionTrustedProxy } from './common/http/trusted-client-ip';
import { ApiResponseInterceptor } from './common/interceptors/api-response.interceptor';
import { AppModule } from './app.module';
import { configureRegistrationNameImportBodyParser } from './id-business-v2/auto-registration/public-api';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureRegistrationNameImportBodyParser(app);
  configureProductionTrustedProxy(app);
  const allowedOrigins = process.env.CORS_ORIGIN?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (process.env.NODE_ENV === 'production' && !allowedOrigins?.length) {
    throw new Error('CORS_ORIGIN is required in production');
  }

  app.setGlobalPrefix('api');
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new ApiResponseInterceptor());
  app.enableCors({
    origin: allowedOrigins?.length ? allowedOrigins : true,
    credentials: true,
    exposedHeaders: ['X-Request-Id']
  });

  const port = Number(process.env.APP_PORT ?? 3000);
  await app.listen(port);
}

void bootstrap();
