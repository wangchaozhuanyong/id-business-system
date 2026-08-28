import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger
} from '@nestjs/common';
import { isApiHttpErrorBody, isRetryableStatus } from '../errors/api-http.exception';
import { getRequestIdFromArgumentsHost } from '../http/request-id';

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

interface HttpResponse {
  setHeader(name: string, value: string): void;
  status(statusCode: number): {
    json(body: ErrorResponseBody): unknown;
  };
}

interface HttpRequest {
  baseUrl?: string;
  method?: string;
  route?: { path?: string };
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
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const context = host.switchToHttp();
    const response = context.getResponse<HttpResponse>();
    const request = context.getRequest<HttpRequest>();
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

    if (status >= 500 && !apiErrorBody) {
      this.logger.error({
        event: 'http_request_failed',
        requestId,
        method: request.method ?? 'UNKNOWN',
        route: `${request.baseUrl ?? ''}${request.route?.path ?? ''}` || 'unknown',
        status,
        ...getSafeExceptionIdentity(exception)
      });
    }

    response.status(status).json(body);
  }
}

function getSafeExceptionIdentity(exception: unknown) {
  if (!exception || typeof exception !== 'object') return {};
  const candidate = exception as { code?: unknown; name?: unknown };
  const name =
    typeof candidate.name === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(candidate.name)
      ? candidate.name
      : undefined;
  const code =
    typeof candidate.code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(candidate.code)
      ? candidate.code
      : undefined;
  return {
    ...(name ? { exceptionName: name } : {}),
    ...(code ? { exceptionCode: code } : {})
  };
}
