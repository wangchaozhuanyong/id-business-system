import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  StreamableFile
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map, Observable } from 'rxjs';
import { getRequestIdFromExecutionContext } from '../http/request-id';
import { SKIP_API_RESPONSE_KEY } from './skip-api-response.decorator';

interface ApiSuccessResponse<TData> {
  success: true;
  data: TData;
  message: string;
  requestId: string;
  timestamp: string;
}

interface ApiErrorResponse {
  success: false;
  errorCode: string;
  message: string;
  requestId: string;
  retryable: boolean;
  timestamp: string;
}

function isApiResponse(value: unknown): value is ApiSuccessResponse<unknown> | ApiErrorResponse {
  if (!value || typeof value !== 'object') return false;
  const response = value as Record<string, unknown>;
  const hasEnvelopeMetadata =
    typeof response.message === 'string' &&
    typeof response.requestId === 'string' &&
    typeof response.timestamp === 'string';
  if (!hasEnvelopeMetadata) return false;
  return (
    (response.success === true && 'data' in response) ||
    (response.success === false &&
      typeof response.errorCode === 'string' &&
      typeof response.retryable === 'boolean')
  );
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
    const requestId = getRequestIdFromExecutionContext(context);
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
          requestId,
          timestamp: new Date().toISOString()
        };
      })
    );
  }
}
