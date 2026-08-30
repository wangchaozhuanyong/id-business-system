import { vi } from 'vitest';

// The current runtime is MySQL; keep adapter-sensitive unit tests deterministic when CI has no .env.
process.env.DATABASE_URL ||= 'mysql://test:test@127.0.0.1:3306/id_business_v2_test';

Object.defineProperty(globalThis, 'jest', {
  configurable: true,
  value: vi
});
