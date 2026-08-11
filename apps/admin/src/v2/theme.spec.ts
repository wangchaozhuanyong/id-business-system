import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyV2Theme } from './theme';

describe('v2 theme contract', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['light', false],
    ['dark', true]
  ] as const)('synchronizes the %s product and Element Plus theme markers', (theme, isDark) => {
    const toggle = vi.fn();
    const documentElement = {
      classList: { toggle },
      dataset: {} as Record<string, string>,
      style: {} as Record<string, string>
    };
    vi.stubGlobal('document', { documentElement });

    applyV2Theme(theme);

    expect(documentElement.dataset.v2Theme).toBe(theme);
    expect(documentElement.style.colorScheme).toBe(theme);
    expect(toggle).toHaveBeenCalledWith('dark', isDark);
  });
});
