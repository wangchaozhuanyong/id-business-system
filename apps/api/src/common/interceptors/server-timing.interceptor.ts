import { Injectable } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

interface TimingResponse {
  setHeader(name: string, value: string): void;
}

@Injectable()
export class ServerTimingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const startedAt = performance.now();
    const response = context.switchToHttp().getResponse<TimingResponse>();
    const writeTiming = () => {
      const duration = Math.max(0, performance.now() - startedAt).toFixed(1);
      response.setHeader('Server-Timing', `edge;dur=${duration}`);
    };

    return next.handle().pipe(
      tap({
        next: writeTiming,
        error: writeTiming
      })
    );
  }
}
