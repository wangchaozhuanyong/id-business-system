import { describe, expect, it } from 'vitest';
import { v2FeatureRegistry, v2NavigationSections } from './registry';

describe('V2 feature registry', () => {
  it('registers every feature with a unique key and route', () => {
    const keys = v2FeatureRegistry.map((feature) => feature.key);
    const routes = v2FeatureRegistry.map((feature) => feature.route);

    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(routes).size).toBe(routes.length);
    expect(v2FeatureRegistry).toHaveLength(10);
  });

  it('keeps routing, permissions and loading behavior in each feature manifest', () => {
    for (const feature of v2FeatureRegistry) {
      expect(feature.route).toMatch(/^\/v2(?:\/|$)/);
      expect(feature.loadView).toBeTypeOf('function');
      expect(['critical', 'operational', 'reference', 'live']).toContain(feature.loadingTier);
      expect(feature.permission).toBeTruthy();
    }
  });

  it('derives navigation from the same registered feature objects', () => {
    const navigationItems = v2NavigationSections.flatMap((section) => section.items);

    expect(navigationItems).toHaveLength(v2FeatureRegistry.length);
    expect(new Set(navigationItems)).toEqual(new Set(v2FeatureRegistry));
  });

  it('keeps only the order-entry draft component alive', () => {
    expect(
      v2FeatureRegistry
        .filter((feature) => 'keepAlive' in feature && feature.keepAlive === true)
        .map((feature) => feature.key)
    ).toEqual(['order-entry']);
  });
});
