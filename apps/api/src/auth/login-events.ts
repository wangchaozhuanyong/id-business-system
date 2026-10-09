import { Global, Injectable, Module } from '@nestjs/common';
import { isIP } from 'node:net';

export interface AuthLoginEvent {
  event: 'admin_login_success' | 'admin_login_failed' | 'admin_2fa_failed';
  loginAttemptId: string;
  userId?: string;
  maskedIp?: string;
}

export function maskLoginEventIp(value?: string | null): string | undefined {
  if (!value) return undefined;
  const normalized = value.startsWith('::ffff:') ? value.slice(7) : value;
  if (isIP(normalized) === 4) return normalized.split('.').slice(0, 3).join('.') + '.*';
  if (isIP(normalized) === 6) return normalized.split(':').slice(0, 2).join(':') + ':…';
  return undefined;
}

@Injectable()
export class AuthLoginEvents {
  private readonly listeners = new Set<(event: Readonly<AuthLoginEvent>) => Promise<void>>();
  subscribe(listener: (event: Readonly<AuthLoginEvent>) => Promise<void>) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async publish(event: AuthLoginEvent): Promise<void> {
    await Promise.allSettled(
      [...this.listeners].map(async (listener) => listener(Object.freeze({ ...event })))
    );
  }
}

@Global()
@Module({ providers: [AuthLoginEvents], exports: [AuthLoginEvents] })
export class AuthLoginEventsModule {}
