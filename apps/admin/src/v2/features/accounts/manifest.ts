import { defineV2Feature } from '@/v2/features/feature';
import { v2TablesByFeature } from '@/v2/features/tableSchemas';

export const accountsFeature = defineV2Feature({
  key: 'accounts',
  title: 'ID管理',
  group: '工作台',
  route: '/v2/accounts',
  sourceSheet: 'ID管理',
  permission: 'apple.account.view',
  kind: 'list',
  freshnessPolicy: 'event-driven',
  filters: [
    {
      key: 'lifecycle',
      label: '快捷分类',
      kind: 'select',
      options: ['可用 ID', '已停用', '已售出', '已报损']
    },
    { key: 'keyword', label: '搜索', kind: 'search', placeholder: 'ID账号、手机号、供应商' },
    { key: 'country', label: '国家', kind: 'select', options: ['美国', '马来西亚'] },
    {
      key: 'status',
      label: '状态',
      kind: 'select',
      options: ['正常', '冻结', '余额封控']
    }
  ],
  tables: v2TablesByFeature['accounts'],
  loadView: () => import('./V2AccountsView.vue')
});
