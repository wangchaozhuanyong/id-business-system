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
    { key: 'name', label: '客户名称', kind: 'text', minWidth: 150 },
    { key: 'phone', label: '手机号', kind: 'identifier', minWidth: 160 },
    { key: 'wechat', label: '微信', kind: 'identifier', minWidth: 160 },
    { key: 'source', label: '来源', kind: 'text', minWidth: 110 },
    { key: 'tag', label: '标签', kind: 'text', minWidth: 110 },
    { key: 'frequentService', label: '常开业务', kind: 'text', minWidth: 150 },
    { key: 'status', label: '状态', kind: 'status', minWidth: 112 },
    { key: 'updatedAt', label: '更新时间', kind: 'date', minWidth: 165 },
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
