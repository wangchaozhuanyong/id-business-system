import { HttpException, HttpStatus } from '@nestjs/common';

export interface ApiHttpErrorOptions {
  cause?: unknown;
  fieldErrors?: Record<string, string[]>;
  retryAfterMs?: number;
  retryable?: boolean;
}

export interface ApiHttpErrorBody {
  errorCode: string;
  fieldErrors?: Record<string, string[]>;
  message: string;
  retryAfterMs?: number;
  retryable: boolean;
}

export class ApiHttpException extends HttpException {
  constructor(
    status: HttpStatus,
    errorCode: string,
    message: string,
    options: ApiHttpErrorOptions = {}
  ) {
    const body: ApiHttpErrorBody = {
      errorCode,
      message,
      retryable: options.retryable ?? isRetryableStatus(status)
    };
    if (options.retryAfterMs !== undefined) body.retryAfterMs = options.retryAfterMs;
    if (options.fieldErrors) body.fieldErrors = options.fieldErrors;
    super(body, status, options.cause === undefined ? undefined : { cause: options.cause });
  }
}

export function authHttpError(
  status: HttpStatus.UNAUTHORIZED | HttpStatus.FORBIDDEN | HttpStatus.SERVICE_UNAVAILABLE,
  errorCode:
    | 'AUTH_MISSING'
    | 'AUTH_INVALID'
    | 'AUTH_EXPIRED'
    | 'AUTH_REVOKED'
    | 'AUTH_ACCOUNT_DISABLED'
    | 'AUTH_IP_BLOCKED'
    | 'AUTH_PASSWORD_RESET_REQUIRED'
    | 'AUTH_PERMISSION_DENIED'
    | 'AUTH_DEPENDENCY_UNAVAILABLE',
  message: string,
  cause?: unknown
) {
  return new ApiHttpException(status, errorCode, message, {
    cause,
    retryable: status === HttpStatus.SERVICE_UNAVAILABLE
  });
}

export function isApiHttpErrorBody(value: unknown): value is ApiHttpErrorBody {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ApiHttpErrorBody>;
  return (
    typeof candidate.errorCode === 'string' &&
    typeof candidate.message === 'string' &&
    typeof candidate.retryable === 'boolean'
  );
}

export function isRetryableStatus(status: number) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}
