// The feature manifests own navigation, access and query freshness metadata.
// Their table schemas and page implementations are loaded only on explicit demand.
export {
  getV2ModuleDefinition as getV2RuntimeModuleDefinition,
  v2FeatureRegistry as v2RuntimeFeatureRegistry,
  v2ModuleDefinitions,
  v2NavigationSections,
  v2WorkbenchModules
} from './registry';
