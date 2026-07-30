export type {
  V2FeatureManifest as V2ModuleDefinition,
  V2FilterDefinition,
  V2FilterKind,
  V2ModuleKey,
  V2ModuleKind,
  V2ModuleStatus,
  V2NavigationSection,
  V2FreshnessPolicy,
  V2PlannedSectionDefinition,
  V2TableColumnDefinition,
  V2TableColumnKind
} from '@/v2/features/feature';

export {
  getV2ModuleDefinition,
  v2FeatureRegistry,
  v2ModuleDefinitions,
  v2NavigationSections,
  v2WorkbenchModules
} from '@/v2/features/registry';
