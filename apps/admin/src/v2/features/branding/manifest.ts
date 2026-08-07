import { defineV2Feature } from '@/v2/features/feature';
import { v2TablesByFeature } from '@/v2/features/tableSchemas';

export const brandingFeature = defineV2Feature({
  key: 'branding',
  title: '品牌设置',
  group: '系统管理',
  route: '/v2/system/branding',
  sourceSheet: '系统管理-品牌设置',
  requiredRoles: ['admin'],
  kind: 'list',
  freshnessPolicy: 'event-driven',
  filters: [{ key: 'keyword', label: '搜索', kind: 'search', placeholder: '品牌文案' }],
  tables: v2TablesByFeature['branding'],
  loadView: () => import('./V2BrandingSettingsView.vue')
});
