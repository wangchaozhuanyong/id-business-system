import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { V2TableSchema } from '@/v2/components/tableSystem';
import type { V2FeatureManifest, V2ModuleKey } from './feature';
import { v2FeatureRegistry, v2NavigationSections } from './registry';
import {
  getV2RuntimeModuleDefinition,
  v2RuntimeFeatureRegistry,
  v2NavigationSections as runtimeNavigationSections
} from './runtimeRegistry';

const loadedTables = new Map<V2ModuleKey, readonly V2TableSchema[]>();
beforeAll(async () => {
  await Promise.all(
    v2FeatureRegistry.map(async (feature) => {
      loadedTables.set(feature.key, await feature.loadTables());
    })
  );
});

function tablesFor(feature: V2FeatureManifest | undefined) {
  return feature ? loadedTables.get(feature.key) : undefined;
}

describe('V2 feature registry', () => {
  it('uses the same manifests and navigation objects for runtime routing and metadata', () => {
    expect(v2RuntimeFeatureRegistry).toBe(v2FeatureRegistry);
    expect(runtimeNavigationSections).toBe(v2NavigationSections);
    for (const feature of v2FeatureRegistry) {
      expect(getV2RuntimeModuleDefinition(feature.key)).toBe(feature);
    }
    expect(getV2RuntimeModuleDefinition('bank-recharge-orders')?.freshnessPolicy).toBe(
      'event-with-deadline'
    );
  });

  it('registers runtime routes without evaluating table schemas or business views', async () => {
    vi.resetModules();
    vi.doMock('@/v2/features/tableSchemas', () => {
      throw new Error('Table schemas must stay out of runtime registration');
    });
    vi.doMock('@/v2/features/accounts/V2AccountsView.vue', () => {
      throw new Error('Business views must stay lazy during runtime registration');
    });
    try {
      const runtime = await import('./runtimeRegistry');
      expect(runtime.v2RuntimeFeatureRegistry).toHaveLength(48);
      expect(runtime.getV2RuntimeModuleDefinition('accounts')?.loadView).toBeTypeOf('function');
    } finally {
      vi.doUnmock('@/v2/features/tableSchemas');
      vi.doUnmock('@/v2/features/accounts/V2AccountsView.vue');
      vi.resetModules();
    }
  });

  it('registers every feature with a unique key and route', () => {
    const keys = v2FeatureRegistry.map((feature) => feature.key);
    const routes = v2FeatureRegistry.map((feature) => feature.route);

    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(routes).size).toBe(routes.length);
    expect(v2FeatureRegistry).toHaveLength(48);
  });

  it('keeps the removed registration names module retired', () => {
    expect(getV2RuntimeModuleDefinition('registration-names')).toBeUndefined();
    expect(
      v2FeatureRegistry.some((feature) => feature.route === '/v2/auto-registration/names')
    ).toBe(false);
  });

  it('registers the new registration workspace as an administrator-only main navigation', () => {
    expect(getV2RuntimeModuleDefinition('auto-registration')).toMatchObject({
      route: '/v2/auto-registration',
      title: '自动注册',
      group: '自动注册',
      kind: 'form',
      requiredRoles: ['admin']
    });
    const section = v2NavigationSections.find((item) => item.key === 'auto-registration');
    expect(section?.items.map((item) => item.key)).toEqual(['auto-registration']);
    expect(
      tablesFor(v2FeatureRegistry.find((item) => item.key === 'auto-registration'))?.map(
        (item) => item.id
      )
    ).toEqual(['auto-registration.apple-mailboxes']);
  });

  it('registers all fifteen online recharge pages immediately after automatic recharge', () => {
    const sectionIndex = v2NavigationSections.findIndex(
      (section) => section.key === 'auto-recharge'
    );
    const online = v2NavigationSections[sectionIndex + 1];
    expect(online?.key).toBe('online-recharge');
    expect(online?.title).toBe('线上代充');
    expect(online?.items.map((item) => item.key)).toEqual([
      'online-recharge-overview',
      'online-recharge-jobs',
      'online-recharge-automation',
      'online-recharge-runtime-logs',
      'online-recharge-billing',
      'online-recharge-cards',
      'online-recharge-proxies',
      'online-recharge-addresses',
      'online-recharge-browser-pool',
      'online-recharge-cdks',
      'online-recharge-sessions',
      'online-recharge-renewal',
      'online-recharge-checkout-debug',
      'online-recharge-config',
      'online-recharge-login-logs'
    ]);
    expect(
      online?.items.every((item) => item.permission === 'id_business_v2.online_recharge.read')
    ).toBe(true);
  });

  it('registers recharge as an administrator-only form under its own navigation group', () => {
    expect(v2FeatureRegistry.find((feature) => feature.key === 'auto-recharge')).toMatchObject({
      route: '/v2/auto-recharge',
      group: '自动充值',
      kind: 'form',
      requiredRoles: ['admin']
    });
    expect(
      v2NavigationSections.find((section) => section.key === 'auto-recharge')?.items
    ).toHaveLength(8);
    expect(
      v2NavigationSections
        .find((section) => section.key === 'auto-recharge')
        ?.items.map((item) => item.key)
    ).toEqual([
      'auto-recharge',
      'chatgpt-accounts',
      'bank-recharge-cards',
      'recharge-proxies',
      'bank-recharge-orders',
      'vendure-mailbox',
      'auto-recharge-addresses',
      'auto-recharge-names'
    ]);
    expect(v2FeatureRegistry.find((feature) => feature.key === 'vendure-mailbox')).toMatchObject({
      title: '邮件验证码查询',
      route: '/v2/auto-recharge/mailbox',
      group: '自动充值',
      kind: 'list',
      requiredRoles: ['admin']
    });
    expect(
      v2FeatureRegistry.find((feature) => feature.key === 'auto-recharge-addresses')
    ).toMatchObject({
      route: '/v2/auto-recharge/addresses',
      group: '自动充值',
      kind: 'list',
      requiredRoles: ['admin']
    });
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
      expect(tablesFor(feature)).toEqual([]);
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
    expect(tablesFor(dataGovernance)?.length).toBeGreaterThan(0);
  });

  it('registers employee accounts as an administrator-only real module', () => {
    const employees = v2FeatureRegistry.find((feature) => feature.key === 'employees');

    expect(employees).toMatchObject({
      kind: 'list',
      requiredRoles: ['admin']
    });
    expect(employees?.status).not.toBe('planned');
    expect(employees?.filters.length).toBeGreaterThan(0);
    expect(tablesFor(employees)?.length).toBeGreaterThan(0);
  });

  it('registers role permissions as an administrator-only real module', () => {
    const roles = v2FeatureRegistry.find((feature) => feature.key === 'roles');

    expect(roles).toMatchObject({
      kind: 'list',
      requiredRoles: ['admin']
    });
    expect(roles?.status).not.toBe('planned');
    expect(roles?.filters.length).toBeGreaterThan(0);
    expect(tablesFor(roles)?.length).toBeGreaterThan(0);
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
    expect(tablesFor(auditLogs)?.length).toBeGreaterThan(0);
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
    expect(tablesFor(security)?.length).toBeGreaterThan(0);
  });

  it('registers the current-user profile as a real self-service module', () => {
    const profile = v2FeatureRegistry.find((feature) => feature.key === 'profile');

    expect(profile).toMatchObject({
      kind: 'list',
      navigation: false,
      freshnessPolicy: 'event-with-deadline'
    });
    expect(profile?.status).not.toBe('planned');
    expect(tablesFor(profile)?.length).toBeGreaterThan(0);
  });

  it('registers the dashboard as a real permission-aware module', () => {
    const dashboard = v2FeatureRegistry.find((feature) => feature.key === 'dashboard');

    expect(dashboard).toMatchObject({
      kind: 'list',
      freshnessPolicy: 'event-with-deadline'
    });
    expect(dashboard?.status).not.toBe('planned');
    expect(tablesFor(dashboard)?.length).toBeGreaterThan(0);
  });

  it('keeps account loss records routable but out of standalone navigation', () => {
    const accountLosses = v2FeatureRegistry.find((feature) => feature.key === 'account-losses');

    expect(accountLosses).toMatchObject({
      navigation: false,
      permission: 'apple.balance.view',
      freshnessPolicy: 'event-driven'
    });
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
    expect(tablesFor(businessMonitoring)?.length).toBeGreaterThan(0);
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
    expect(tablesFor(systemMonitoring)).toEqual([]);
  });

  it('registers branding settings as an administrator-only settings module', () => {
    const branding = v2FeatureRegistry.find((feature) => feature.key === 'branding');

    expect(branding).toMatchObject({
      kind: 'list',
      requiredRoles: ['admin'],
      freshnessPolicy: 'event-driven'
    });
    expect(branding?.status).not.toBe('planned');
    expect(tablesFor(branding)).toEqual([]);
  });

  it('derives navigation from the same registered feature objects', () => {
    const navigationItems = v2NavigationSections.flatMap((section) => section.items);
    const navigableFeatures = v2FeatureRegistry.filter((feature) => feature.navigation !== false);

    expect(navigationItems).toHaveLength(navigableFeatures.length);
    expect(new Set(navigationItems)).toEqual(new Set(navigableFeatures));
  });

  it('keeps the requested workbench, business and finance navigation hierarchy', () => {
    const navigation = Object.fromEntries(
      v2NavigationSections.map((section) => [
        section.title,
        section.items.map((item) => item.title)
      ])
    );

    expect(navigation['工作台']).toEqual(['续费操作', '订单录入', 'ID加额', 'ID管理']);
    expect(navigation['业务中心']).toEqual(['订单管理', '客户记录', '加卡记录', '开通记录']);
    expect(navigation['财务记账']).toEqual(['钱包账户', '收支记账', '经营分析']);
    expect(navigation['数据中心']).toEqual(['数据治理']);
    expect(navigation).not.toHaveProperty('记录中心');
  });

  it('keeps only the order-entry draft component alive', () => {
    expect(
      v2FeatureRegistry
        .filter((feature) => 'keepAlive' in feature && feature.keepAlive === true)
        .map((feature) => feature.key)
    ).toEqual(['order-entry']);
  });
});
