import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import {
  recordServerAuthTiming,
  ServerTimingInterceptor,
  startServerTiming
} from './server-timing.interceptor';

describe('ServerTimingInterceptor', () => {
  it('reports the full request, authentication, and handler phases', async () => {
    const request = {};
    const response = { setHeader: vi.fn() };
    startServerTiming(request);
    recordServerAuthTiming(request, 12.34);
    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response
      })
    } as unknown as ExecutionContext;
    const next = { handle: () => of({ ok: true }) } as CallHandler;

    await firstValueFrom(new ServerTimingInterceptor().intercept(context, next));

    expect(response.setHeader).toHaveBeenCalledWith(
      'Server-Timing',
      expect.stringMatching(/^edge;dur=\d+\.\d, auth;dur=12\.3, handler;dur=\d+\.\d$/)
    );
  });
});
