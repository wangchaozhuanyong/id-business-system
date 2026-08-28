import { createParamDecorator } from '@nestjs/common';
import { isIP } from 'node:net';

export interface RequestWithClientIp {
  ip?: string | null;
}

interface TrustedProxyApplication {
  set(setting: 'trust proxy', value: number): unknown;
}

export function configureProductionTrustedProxy(
  app: TrustedProxyApplication,
  nodeEnv = process.env.NODE_ENV
) {
  if (nodeEnv === 'production') {
    // AWS production has exactly one proxy hop between Nginx and the API.
    // Caddy overwrites the public forwarding header and Nginx forwards that
    // single value without appending its own address.
    app.set('trust proxy', 1);
  }
}

export function resolveTrustedClientIp(request: RequestWithClientIp | undefined) {
  return normalizeIp(request?.ip);
}

export const TrustedClientIp = createParamDecorator((_data, context) =>
  resolveTrustedClientIp(context.switchToHttp().getRequest<RequestWithClientIp>())
);

function normalizeIp(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized && isIP(normalized) ? normalized : undefined;
}
