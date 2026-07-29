import { describe, expect, it } from 'vitest';
import { shouldIgnoreRuntimeError } from './appRuntimeError';

describe('V2 app runtime error classification', () => {
  it.each([
    'Failed to fetch dynamically imported module: /assets/V2OrdersView.js',
    'error loading dynamically imported module',
    'Importing a module script failed.',
    'Unable to preload CSS for /assets/V2OrdersView.css',
    `Couldn't resolve component "default" at "/v2/orders"`
  ])('leaves route resource failures to the router recovery boundary: %s', (message) => {
    expect(shouldIgnoreRuntimeError(new Error(message))).toBe(true);
  });

  it('keeps real application errors fatal', () => {
    expect(shouldIgnoreRuntimeError(new Error('Cannot read properties of undefined'))).toBe(false);
  });
});
