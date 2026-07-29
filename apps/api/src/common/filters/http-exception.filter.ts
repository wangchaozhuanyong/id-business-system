import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';

interface ErrorResponseBody {
  success: false;
  errorCode: string;
  message: string;
  details?: unknown;
  timestamp: string;
}

interface HttpResponse {
  status(statusCode: number): {
    json(body: ErrorResponseBody): unknown;
  };
}

function getErrorMessage(response: string | object): string {
  if (typeof response === 'string') {
    return response;
  }

  if ('message' in response) {
    const message = response.message;
    return Array.isArray(message) ? message.join('; ') : String(message);
  }

  return 'Request failed';
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const context = host.switchToHttp();
    const response = context.getResponse<HttpResponse>();
    this.logCloudflareError(exception);

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    const exceptionResponse =
      exception instanceof HttpException ? exception.getResponse() : 'Internal server error';

    const body: ErrorResponseBody = {
      success: false,
      errorCode:
        exception instanceof HttpException
          ? (HttpStatus[status] ?? 'HTTP_ERROR')
          : 'INTERNAL_SERVER_ERROR',
      message: getErrorMessage(exceptionResponse),
      timestamp: new Date().toISOString()
    };

    if (typeof exceptionResponse === 'object') {
      body.details = exceptionResponse;
    }

    response.status(status).json(body);
  }

  private logCloudflareError(exception: unknown) {
    const isEdgeRuntime =
      process.env.CLOUDFLARE_WORKER === 'true' || process.env.SUPABASE_EDGE_FUNCTION === 'true';
    if (!isEdgeRuntime || !(exception instanceof Error)) return;

    const errorCode =
      'code' in exception && typeof exception.code === 'string' ? ` code=${exception.code}` : '';
    const safeMessage = exception.message
      .replace(/postgres(?:ql)?:\/\/[^\s)]+/gi, '[redacted-database-url]')
      .replace(/(password|token|secret)=([^\s&,]+)/gi, '$1=[redacted]')
      .slice(0, 500);
    const stackFrames = exception.stack?.split('\n').slice(1, 6).join('\n') ?? '';
    console.error(
      `[Cloudflare Worker] ${exception.name}${errorCode}: ${safeMessage}${
        stackFrames ? `\n${stackFrames}` : ''
      }`
    );
  }
}
