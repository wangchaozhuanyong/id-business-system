import { Injectable } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

interface TimingResponse {
  setHeader(name: string, value: string): void;
}

interface ServerTimingContext {
  authDurationMs?: number;
  startedAt: number;
}

const serverTimingContexts = new WeakMap<object, ServerTimingContext>();

export function startServerTiming(request: object) {
  serverTimingContexts.set(request, { startedAt: performance.now() });
}

export function recordServerAuthTiming(request: object, durationMs: number) {
  const context = serverTimingContexts.get(request);
  if (!context || !Number.isFinite(durationMs)) return;
  context.authDurationMs = Math.max(0, durationMs);
}

@Injectable()
export class ServerTimingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const handlerStartedAt = performance.now();
    const request = context.switchToHttp().getRequest<object>();
    const timingContext = serverTimingContexts.get(request);
    const response = context.switchToHttp().getResponse<TimingResponse>();
    const writeTiming = () => {
      const completedAt = performance.now();
      const totalDuration = Math.max(
        0,
        completedAt - (timingContext?.startedAt ?? handlerStartedAt)
      ).toFixed(1);
      const handlerDuration = Math.max(0, completedAt - handlerStartedAt).toFixed(1);
      const metrics = [`edge;dur=${totalDuration}`];
      if (timingContext?.authDurationMs !== undefined) {
        metrics.push(`auth;dur=${timingContext.authDurationMs.toFixed(1)}`);
      }
      metrics.push(`handler;dur=${handlerDuration}`);
      response.setHeader('Server-Timing', metrics.join(', '));
      serverTimingContexts.delete(request);
    };

    return next.handle().pipe(
      tap({
        next: writeTiming,
        error: writeTiming
      })
    );
  }
}
