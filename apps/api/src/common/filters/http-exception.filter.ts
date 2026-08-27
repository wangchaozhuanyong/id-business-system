import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { isApiHttpErrorBody, isRetryableStatus } from '../errors/api-http.exception';
import { getRequestHeader, getRequestIdFromArgumentsHost } from '../http/request-id';

interface ErrorResponseBody {
  success: false;
  errorCode: string;
  fieldErrors?: Record<string, string[]>;
  message: string;
  requestId: string;
  retryAfterMs?: number;
  retryable: boolean;
  timestamp: string;
}

interface HttpRequest {
  headers?: Record<string, string | string[] | undefined>;
  method?: string;
  originalUrl?: string;
  requestId?: string;
  url?: string;
}

interface HttpResponse {
  setHeader(name: string, value: string): void;
  status(statusCode: number): {
    json(body: ErrorResponseBody): unknown;
  };
}

const FALLBACK_ERROR_CODES: Partial<Record<HttpStatus, string>> = {
  [HttpStatus.BAD_REQUEST]: 'BAD_REQUEST',
  [HttpStatus.UNAUTHORIZED]: 'AUTH_INVALID',
  [HttpStatus.FORBIDDEN]: 'AUTH_PERMISSION_DENIED',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.CONFLICT]: 'CONFLICT',
  [HttpStatus.TOO_MANY_REQUESTS]: 'RATE_LIMITED',
  [HttpStatus.BAD_GATEWAY]: 'SERVICE_UNAVAILABLE',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'SERVICE_UNAVAILABLE',
  [HttpStatus.GATEWAY_TIMEOUT]: 'SERVICE_UNAVAILABLE'
};

function getErrorMessage(response: string | object, status: number): string {
  if (typeof response === 'string') return response;
  if ('message' in response) {
    const message = response.message;
    return Array.isArray(message) ? message.join('; ') : String(message);
  }
  return status >= 500 ? '服务器内部错误，请稍后重试。' : '请求处理失败。';
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const context = host.switchToHttp();
    const request = context.getRequest<HttpRequest>();
    const response = context.getResponse<HttpResponse>();
    const requestId = getRequestIdFromArgumentsHost(host);
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const exceptionResponse =
      exception instanceof HttpException ? exception.getResponse() : '服务器内部错误，请稍后重试。';
    const apiErrorBody = isApiHttpErrorBody(exceptionResponse) ? exceptionResponse : null;
    const retryable = apiErrorBody?.retryable ?? isRetryableStatus(status);
    const errorCode =
      apiErrorBody?.errorCode ??
      FALLBACK_ERROR_CODES[status as HttpStatus] ??
      'INTERNAL_SERVER_ERROR';
    const body: ErrorResponseBody = {
      success: false,
      errorCode,
      message: getErrorMessage(exceptionResponse, status),
      requestId,
      retryable,
      timestamp: new Date().toISOString()
    };

    if (apiErrorBody?.retryAfterMs !== undefined) {
      body.retryAfterMs = apiErrorBody.retryAfterMs;
      response.setHeader(
        'Retry-After',
        String(Math.max(1, Math.ceil(apiErrorBody.retryAfterMs / 1000)))
      );
    }
    if (apiErrorBody?.fieldErrors) body.fieldErrors = apiErrorBody.fieldErrors;

    this.logEdgeError({ errorCode, exception, request, requestId, status });
    response.status(status).json(body);
  }

  private logEdgeError(input: {
    errorCode: string;
    exception: unknown;
    request: HttpRequest;
    requestId: string;
    status: number;
  }) {
    const isSupabaseEdgeRuntime = process.env.SUPABASE_EDGE_FUNCTION === 'true';
    const isCloudflareWorker = process.env.CLOUDFLARE_WORKER === 'true';
    if (!isSupabaseEdgeRuntime || isCloudflareWorker || input.status < 500) return;

    const exceptionCodes = getSafeExceptionCodes(input.exception);

    console.error(
      JSON.stringify({
        cfRay: getRequestHeader(input.request, 'cf-ray'),
        databaseErrorCode: exceptionCodes.databaseErrorCode,
        errorCode: input.errorCode,
        errorName:
          input.exception instanceof Error ? input.exception.name : 'UnknownServerException',
        method: input.request.method,
        pathname: (input.request.originalUrl ?? input.request.url ?? '').split('?', 1)[0],
        providerErrorCode: exceptionCodes.providerErrorCode,
        requestId: input.requestId,
        status: input.status,
        type: 'api_error'
      })
    );
  }
}

function getSafeExceptionCodes(exception: unknown) {
  if (!exception || typeof exception !== 'object') return {};
  const value = exception as { code?: unknown; meta?: { code?: unknown } };
  return {
    databaseErrorCode: normalizeSafeErrorCode(value.meta?.code),
    providerErrorCode: normalizeSafeErrorCode(value.code)
  };
}

function normalizeSafeErrorCode(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return /^[A-Za-z0-9_-]{1,32}$/.test(normalized) ? normalized : undefined;
}
