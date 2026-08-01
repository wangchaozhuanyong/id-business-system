import type { Component } from 'vue';
import type { V2TableSchema } from '@/v2/components/tableSystem';

export type V2ModuleKey =
  | 'renewal-workbench'
  | 'order-entry'
  | 'topup-workbench'
  | 'accounts'
  | 'orders'
  | 'customers'
  | 'topup-records'
  | 'account-losses'
  | 'activation-records'
  | 'exchange-rates'
  | 'options'
  | 'dashboard'
  | 'analytics'
  | 'finance-ledger'
  | 'data-governance'
  | 'business-monitoring'
  | 'system-monitoring'
  | 'employees'
  | 'roles'
  | 'audit-logs'
  | 'security'
  | 'profile';

export type V2ModuleKind = 'list' | 'form' | 'planned';
export type V2ModuleStatus = 'ready' | 'planned';
export type V2FreshnessPolicy = 'event-driven' | 'event-with-deadline';
export type V2FilterKind = 'search' | 'select' | 'date-range' | 'number-range';
export type V2ViewLoader = () => Promise<{ default: Component }>;

export interface V2FilterDefinition {
  key: string;
  label: string;
  kind: V2FilterKind;
  placeholder?: string;
  options?: readonly string[];
}

export interface V2PlannedSectionDefinition {
  title: string;
  description: string;
}

export interface V2FeatureManifest {
  key: V2ModuleKey;
  title: string;
  group: string;
  route: string;
  sourceSheet: string;
  permission?: string;
  requiredRoles?: readonly string[];
  status?: V2ModuleStatus;
  navigation?: boolean;
  kind: V2ModuleKind;
  freshnessPolicy: V2FreshnessPolicy;
  keepAlive?: boolean;
  summary?: string;
  plannedSections?: readonly V2PlannedSectionDefinition[];
  safetyNotice?: string;
  filters: readonly V2FilterDefinition[];
  tables: readonly V2TableSchema[];
  loadView: V2ViewLoader;
}

export interface V2NavigationSection {
  key: string;
  title: string;
  items: readonly V2FeatureManifest[];
}

export function defineV2Feature<const TFeature extends V2FeatureManifest>(feature: TFeature) {
  return feature;
}
