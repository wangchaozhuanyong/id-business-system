export type ApiErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'transient'
  | 'validation'
  | 'conflict'
  | 'server'
  | 'network'
  | 'canceled';

export interface ApiErrorOptions {
  cause?: unknown;
  code: string;
  fieldErrors?: Record<string, string[]>;
  kind: ApiErrorKind;
  requestId?: string;
  retryAfterMs?: number;
  retryable: boolean;
  status: number | null;
}

export class ApiError extends Error {
  readonly code: string;
  readonly fieldErrors?: Record<string, string[]>;
  readonly kind: ApiErrorKind;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
  readonly retryable: boolean;
  readonly status: number | null;

  constructor(message: string, options: ApiErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApiError';
    this.code = options.code;
    this.fieldErrors = options.fieldErrors;
    this.kind = options.kind;
    this.requestId = options.requestId;
    this.retryAfterMs = options.retryAfterMs;
    this.retryable = options.retryable;
    this.status = options.status;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return (
    error instanceof ApiError ||
    Boolean(
      error &&
      typeof error === 'object' &&
      (error as { name?: unknown }).name === 'ApiError' &&
      typeof (error as { code?: unknown }).code === 'string'
    )
  );
}

export function createSessionUnavailableError(retryAfterMs?: number) {
  return new ApiError('登录服务暂时不可用，请稍后重试。', {
    code: 'AUTH_CIRCUIT_OPEN',
    kind: 'transient',
    retryAfterMs,
    retryable: true,
    status: 503
  });
}
