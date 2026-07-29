import { SetMetadata } from '@nestjs/common';

export const SENSITIVE_ACTION_KEY = 'sensitiveAction';

export interface SensitiveActionOptions {
  module: string;
  action: string;
  objectType?: string;
  getObjectId?: (data: unknown) => string | undefined;
}

export const SensitiveAction = (options: SensitiveActionOptions) =>
  SetMetadata(SENSITIVE_ACTION_KEY, options);
