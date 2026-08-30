import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('../../styles/order-entry.css', import.meta.url), 'utf8');

describe('order entry footer UI contract', () => {
  it('keeps the submit actions in document flow instead of covering form content', () => {
    const actionRules = styles.match(/\.v2-order-entry-actions\s*\{[^}]+\}/gs) ?? [];

    expect(actionRules.length).toBeGreaterThan(0);
    expect(actionRules.every((rule) => !rule.includes('position: sticky'))).toBe(true);
    expect(actionRules.some((rule) => rule.includes('position: static'))).toBe(true);
  });
});
