import { defineV2Feature } from '@/v2/features/feature';
import { v2TablesByFeature } from '@/v2/features/tableSchemas';

export const customersFeature = defineV2Feature({
  key: 'customers',
  title: '客户记录',
  group: '业务中心',
  route: '/v2/customers',
  sourceSheet: '客户记录',
  permission: 'customer.view',
  kind: 'list',
  freshnessPolicy: 'event-driven',
  filters: [
    {
      key: 'keyword',
      label: '搜索',
      kind: 'search',
      placeholder: '客户名称、手机、微信、QQ、WhatsApp'
    },
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
  tables: v2TablesByFeature['customers'],
  loadView: () => import('./V2CustomersView.vue')
});
