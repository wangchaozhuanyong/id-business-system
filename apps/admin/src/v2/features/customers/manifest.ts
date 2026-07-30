import { V2_TABLE_ACTION_COLUMN_WIDTH } from '@/v2/components/tableActionLayout';
import { defineV2Feature } from '@/v2/features/feature';

export const customersFeature = defineV2Feature({
  key: 'customers',
  title: '客户记录',
  group: '业务数据',
  route: '/v2/customers',
  sourceSheet: '客户记录',
  permission: 'customer.view',
  kind: 'list',
  freshnessPolicy: 'event-driven',
  filters: [
    { key: 'keyword', label: '搜索', kind: 'search', placeholder: '客户名称、手机、微信' },
    {
      key: 'source',
      label: '来源',
      kind: 'select',
      options: ['微信', '淘宝', '闲鱼', '抖音']
    },
    {
      key: 'tag',
      label: '标签',
      kind: 'select',
      options: ['公司客户', '个人客户', '大客户', '小客户']
    }
  ],
  columns: [
    { key: 'name', label: '客户名称', kind: 'text', widthPreset: 'identifier' },
    { key: 'phone', label: '手机号', kind: 'identifier', widthPreset: 'wide' },
    { key: 'wechat', label: '微信', kind: 'identifier', widthPreset: 'wide' },
    { key: 'source', label: '来源', kind: 'text', widthPreset: 'standard' },
    { key: 'tag', label: '标签', kind: 'text', widthPreset: 'identifier' },
    {
      key: 'frequentService',
      label: '常开业务',
      kind: 'text',
      widthPreset: 'identifier'
    },
    { key: 'status', label: '状态', kind: 'status', widthPreset: 'compact' },
    { key: 'updatedAt', label: '更新时间', kind: 'date', widthPreset: 'dateTime' },
    {
      key: 'actions',
      label: '操作',
      kind: 'actions',
      minWidth: V2_TABLE_ACTION_COLUMN_WIDTH.triple,
      fixed: 'right'
    }
  ],
  loadView: () => import('./V2CustomersView.vue')
});
