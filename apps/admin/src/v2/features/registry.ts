import { accountsFeature } from '@/v2/features/accounts/manifest';
import { accountLossesFeature } from '@/v2/features/account-losses/manifest';
import { activationsFeature } from '@/v2/features/activations/manifest';
import { customersFeature } from '@/v2/features/customers/manifest';
import { exchangeRatesFeature } from '@/v2/features/exchange-rates/manifest';
import type { V2FeatureManifest, V2ModuleKey, V2NavigationSection } from '@/v2/features/feature';
import { optionsFeature } from '@/v2/features/options/manifest';
import { orderEntryFeature } from '@/v2/features/order-entry/manifest';
import { ordersFeature } from '@/v2/features/orders/manifest';
import { renewalWorkbenchFeature } from '@/v2/features/renewals/manifest';
import { topupRecordsFeature } from '@/v2/features/topup-records/manifest';
import { topupWorkbenchFeature } from '@/v2/features/topups/manifest';

export const v2FeatureRegistry = [
  renewalWorkbenchFeature,
  orderEntryFeature,
  topupWorkbenchFeature,
  accountsFeature,
  ordersFeature,
  customersFeature,
  topupRecordsFeature,
  accountLossesFeature,
  activationsFeature,
  exchangeRatesFeature,
  optionsFeature
] as const satisfies readonly V2FeatureManifest[];

// Compatibility alias while existing V2 consumers migrate to the feature vocabulary.
export const v2ModuleDefinitions = v2FeatureRegistry;

const featureByKey = new Map<V2ModuleKey, V2FeatureManifest>(
  v2FeatureRegistry.map((feature) => [feature.key, feature])
);

export const v2WorkbenchModules = v2FeatureRegistry.filter((feature) => feature.group === '工作台');

export const v2NavigationSections: readonly V2NavigationSection[] = [
  { key: 'workspace', title: '工作台', items: v2WorkbenchModules },
  {
    key: 'business',
    title: '业务数据',
    items: v2FeatureRegistry.filter((feature) => feature.group === '业务数据')
  },
  {
    key: 'records',
    title: '记录',
    items: v2FeatureRegistry.filter((feature) => feature.group === '记录')
  },
  {
    key: 'system',
    title: '系统',
    items: v2FeatureRegistry.filter((feature) => feature.group === '系统')
  }
];

export function getV2ModuleDefinition(key: unknown) {
  return typeof key === 'string' ? featureByKey.get(key as V2ModuleKey) : undefined;
}
