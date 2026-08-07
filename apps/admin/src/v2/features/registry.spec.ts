import { describe, expect, it } from 'vitest';
import { v2FeatureRegistry, v2NavigationSections } from './registry';

describe('V2 feature registry', () => {
  it('registers every feature with a unique key and route', () => {
    const keys = v2FeatureRegistry.map((feature) => feature.key);
    const routes = v2FeatureRegistry.map((feature) => feature.route);

    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(routes).size).toBe(routes.length);
    expect(v2FeatureRegistry).toHaveLength(23);
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

    expect(plannedFeatures).toHaveLength(0);
    for (const feature of plannedFeatures) {
      expect(feature.kind).toBe('planned');
      expect(feature.summary).toBeTruthy();
      expect(feature.plannedSections?.length).toBeGreaterThan(0);
      expect(feature.filters).toEqual([]);
      expect(feature.tables).toEqual([]);
    }
  });

  it('registers data governance as an administrator-only real module', () => {
    const dataGovernance = v2FeatureRegistry.find((feature) => feature.key === 'data-governance');

    expect(dataGovernance).toMatchObject({
      kind: 'list',
      requiredRoles: ['admin'],
      freshnessPolicy: 'event-driven'
    });
    expect(dataGovernance?.status).not.toBe('planned');
    expect(dataGovernance?.filters.length).toBeGreaterThan(0);
    expect(dataGovernance?.tables.length).toBeGreaterThan(0);
  });

  it('registers employee accounts as an administrator-only real module', () => {
    const employees = v2FeatureRegistry.find((feature) => feature.key === 'employees');

    expect(employees).toMatchObject({
      kind: 'list',
      requiredRoles: ['admin']
    });
    expect(employees?.status).not.toBe('planned');
    expect(employees?.filters.length).toBeGreaterThan(0);
    expect(employees?.tables.length).toBeGreaterThan(0);
  });

  it('registers role permissions as an administrator-only real module', () => {
    const roles = v2FeatureRegistry.find((feature) => feature.key === 'roles');

    expect(roles).toMatchObject({
      kind: 'list',
      requiredRoles: ['admin']
    });
    expect(roles?.status).not.toBe('planned');
    expect(roles?.filters.length).toBeGreaterThan(0);
    expect(roles?.tables.length).toBeGreaterThan(0);
  });

  it('registers audit logs as a permission-protected real module', () => {
    const auditLogs = v2FeatureRegistry.find((feature) => feature.key === 'audit-logs');

    expect(auditLogs).toMatchObject({
      kind: 'list',
      permission: 'audit_log.view',
      freshnessPolicy: 'event-with-deadline'
    });
    expect(auditLogs?.status).not.toBe('planned');
    expect(auditLogs?.filters.length).toBeGreaterThan(0);
    expect(auditLogs?.tables.length).toBeGreaterThan(0);
  });

  it('registers the security center as an administrator-only real module', () => {
    const security = v2FeatureRegistry.find((feature) => feature.key === 'security');

    expect(security).toMatchObject({
      kind: 'list',
      requiredRoles: ['admin'],
      freshnessPolicy: 'event-with-deadline'
    });
    expect(security?.status).not.toBe('planned');
    expect(security?.filters.length).toBeGreaterThan(0);
    expect(security?.tables.length).toBeGreaterThan(0);
  });

  it('registers the current-user profile as a real self-service module', () => {
    const profile = v2FeatureRegistry.find((feature) => feature.key === 'profile');

    expect(profile).toMatchObject({
      kind: 'list',
      navigation: false,
      freshnessPolicy: 'event-with-deadline'
    });
    expect(profile?.status).not.toBe('planned');
    expect(profile?.tables.length).toBeGreaterThan(0);
  });

  it('registers the dashboard as a real permission-aware module', () => {
    const dashboard = v2FeatureRegistry.find((feature) => feature.key === 'dashboard');

    expect(dashboard).toMatchObject({
      kind: 'list',
      freshnessPolicy: 'event-with-deadline'
    });
    expect(dashboard?.status).not.toBe('planned');
    expect(dashboard?.tables.length).toBeGreaterThan(0);
  });

  it('registers business monitoring as an administrator-only real module', () => {
    const businessMonitoring = v2FeatureRegistry.find(
      (feature) => feature.key === 'business-monitoring'
    );

    expect(businessMonitoring).toMatchObject({
      kind: 'list',
      requiredRoles: ['admin'],
      freshnessPolicy: 'event-with-deadline'
    });
    expect(businessMonitoring?.status).not.toBe('planned');
    expect(businessMonitoring?.filters.length).toBeGreaterThan(0);
    expect(businessMonitoring?.tables.length).toBeGreaterThan(0);
  });

  it('registers system monitoring as an administrator-only real module', () => {
    const systemMonitoring = v2FeatureRegistry.find(
      (feature) => feature.key === 'system-monitoring'
    );

    expect(systemMonitoring).toMatchObject({
      kind: 'list',
      requiredRoles: ['admin'],
      freshnessPolicy: 'event-with-deadline'
    });
    expect(systemMonitoring?.status).not.toBe('planned');
    expect(systemMonitoring?.tables).toEqual([]);
  });

  it('registers branding settings as an administrator-only settings module', () => {
    const branding = v2FeatureRegistry.find((feature) => feature.key === 'branding');

    expect(branding).toMatchObject({
      kind: 'list',
      requiredRoles: ['admin'],
      freshnessPolicy: 'event-driven'
    });
    expect(branding?.status).not.toBe('planned');
    expect(branding?.tables).toEqual([]);
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
