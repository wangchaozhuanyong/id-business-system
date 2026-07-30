import type { Component } from 'vue';
import type { V2TableColumnKind } from '@/v2/components/tableColumn';

export type { V2TableColumnKind } from '@/v2/components/tableColumn';

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

export interface V2TableColumnDefinition {
  key: string;
  label: string;
  kind: V2TableColumnKind | 'actions';
  minWidth: number;
  fixed?: 'left' | 'right';
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
  columns: readonly V2TableColumnDefinition[];
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
