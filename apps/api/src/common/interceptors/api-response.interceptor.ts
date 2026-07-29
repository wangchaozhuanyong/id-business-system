import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  StreamableFile
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map, Observable } from 'rxjs';
import { SKIP_API_RESPONSE_KEY } from './skip-api-response.decorator';

interface ApiSuccessResponse<TData> {
  success: true;
  data: TData;
  message: string;
  timestamp: string;
}

function isApiResponse(value: unknown): value is { success: boolean } {
  return Boolean(value && typeof value === 'object' && 'success' in value);
}

@Injectable()
export class ApiResponseInterceptor<TData> implements NestInterceptor<
  TData,
  ApiSuccessResponse<TData> | TData
> {
  private readonly reflector = new Reflector();

  intercept(
    context: ExecutionContext,
    next: CallHandler<TData>
  ): Observable<ApiSuccessResponse<TData> | TData> {
    const skipApiResponse = this.reflector.getAllAndOverride<boolean>(SKIP_API_RESPONSE_KEY, [
      context.getHandler(),
      context.getClass()
    ]);

    if (skipApiResponse) {
      return next.handle();
    }

    return next.handle().pipe(
      map((data) => {
        if (data instanceof StreamableFile) {
          return data;
        }

        if (isApiResponse(data)) {
          return data;
        }

        return {
          success: true,
          data,
          message: 'ok',
          timestamp: new Date().toISOString()
        };
      })
    );
  }
}
