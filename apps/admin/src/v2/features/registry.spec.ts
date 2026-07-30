import { describe, expect, it } from 'vitest';
import { v2FeatureRegistry, v2NavigationSections } from './registry';

describe('V2 feature registry', () => {
  it('registers every feature with a unique key and route', () => {
    const keys = v2FeatureRegistry.map((feature) => feature.key);
    const routes = v2FeatureRegistry.map((feature) => feature.route);

    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(routes).size).toBe(routes.length);
    expect(v2FeatureRegistry).toHaveLength(22);
  });

  it('keeps routing, access and loading behavior in each feature manifest', () => {
    for (const feature of v2FeatureRegistry) {
      expect(feature.route).toMatch(/^\/v2(?:\/|$)/);
      expect(feature.loadView).toBeTypeOf('function');
      expect(['event-driven', 'event-with-deadline']).toContain(feature.freshnessPolicy);
      expect(
        Boolean(feature.permission) ||
          Boolean(feature.requiredRoles?.length) ||
          feature.key === 'dashboard' ||
          feature.key === 'profile'
      ).toBe(true);
    }
  });

  it('keeps planned modules explicit and free of fake table configuration', () => {
    const plannedFeatures = v2FeatureRegistry.filter((feature) => feature.status === 'planned');

    expect(plannedFeatures).toHaveLength(9);
    for (const feature of plannedFeatures) {
      expect(feature.kind).toBe('planned');
      expect(feature.summary).toBeTruthy();
      expect(feature.plannedSections?.length).toBeGreaterThan(0);
      expect(feature.filters).toEqual([]);
      expect(feature.columns).toEqual([]);
    }
  });

  it('derives navigation from the same registered feature objects', () => {
    const navigationItems = v2NavigationSections.flatMap((section) => section.items);
    const navigableFeatures = v2FeatureRegistry.filter((feature) => feature.navigation !== false);

    expect(navigationItems).toHaveLength(navigableFeatures.length);
    expect(new Set(navigationItems)).toEqual(new Set(navigableFeatures));
  });

  it('keeps only the order-entry draft component alive', () => {
    expect(
      v2FeatureRegistry
        .filter((feature) => 'keepAlive' in feature && feature.keepAlive === true)
        .map((feature) => feature.key)
    ).toEqual(['order-entry']);
  });
});
