import type { ArgumentsHost, ExecutionContext } from '@nestjs/common';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

interface RequestWithHeaders {
  headers?: Record<string, string | string[] | undefined>;
  requestId?: string;
}

interface ResponseWithHeader {
  setHeader(name: string, value: string): void;
}

export function getRequestIdFromExecutionContext(context: ExecutionContext) {
  const http = context.switchToHttp();
  return getOrCreateRequestId(
    http.getRequest<RequestWithHeaders>(),
    http.getResponse<ResponseWithHeader>()
  );
}

export function getRequestIdFromArgumentsHost(host: ArgumentsHost) {
  const http = host.switchToHttp();
  return getOrCreateRequestId(
    http.getRequest<RequestWithHeaders>(),
    http.getResponse<ResponseWithHeader>()
  );
}

export function getRequestHeader(request: RequestWithHeaders, name: string): string | undefined {
  const value = request.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function getOrCreateRequestId(request: RequestWithHeaders, response: ResponseWithHeader) {
  const incoming = getRequestHeader(request, 'x-request-id')?.trim();
  const requestId =
    request.requestId ??
    (incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : crypto.randomUUID());
  request.requestId = requestId;
  response.setHeader('X-Request-Id', requestId);
  return requestId;
}
