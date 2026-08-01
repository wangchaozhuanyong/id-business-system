import { defineV2Feature } from '@/v2/features/feature';
import { v2TablesByFeature } from '@/v2/features/tableSchemas';

export const optionsFeature = defineV2Feature({
  key: 'options',
  title: '选项设置',
  group: '系统',
  route: '/v2/options',
  sourceSheet: '选项设置',
  permission: 'data.dictionary.manage',
  kind: 'list',
  freshnessPolicy: 'event-driven',
  filters: [
    { key: 'keyword', label: '搜索', kind: 'search', placeholder: '选项名称' },
    {
      key: 'type',
      label: '选项类型',
      kind: 'select',
      options: [
        'ID状态',
        '国家',
        '客户来源',
        '客户标签',
        '业务名称',
        'ID供应商',
        '加卡供应商',
        '卡片名称',
        '结算平台'
      ]
    }
  ],
  tables: v2TablesByFeature['options'],
  loadView: () => import('./V2OptionsView.vue')
});
