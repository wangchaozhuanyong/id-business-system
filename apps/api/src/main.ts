import { NestFactory } from '@nestjs/core';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ApiResponseInterceptor } from './common/interceptors/api-response.interceptor';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
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
    credentials: true
  });

  const port = Number(process.env.APP_PORT ?? 3000);
  await app.listen(port);
}

void bootstrap();
