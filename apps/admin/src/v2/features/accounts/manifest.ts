import { V2_TABLE_ACTION_COLUMN_WIDTH } from '@/v2/components/tableActionLayout';
import { defineV2Feature } from '@/v2/features/feature';

export const accountsFeature = defineV2Feature({
  key: 'accounts',
  title: 'ID录入',
  group: '业务数据',
  route: '/v2/accounts',
  sourceSheet: 'ID录入',
  permission: 'apple.account.view',
  kind: 'list',
  freshnessPolicy: 'event-driven',
  filters: [
    { key: 'keyword', label: '搜索', kind: 'search', placeholder: 'ID账号、手机号、供应商' },
    { key: 'country', label: '国家', kind: 'select', options: ['美国', '马来西亚'] },
    {
      key: 'status',
      label: '状态',
      kind: 'select',
      options: ['正常', '冻结', '余额封控']
    },
    { key: 'saleState', label: '销售状态', kind: 'select', options: ['可用', '已卖出'] }
  ],
  columns: [
    { key: 'account', label: 'ID账号', minWidth: 200 },
    { key: 'country', label: '国家', minWidth: 110 },
    { key: 'balance', label: '余额', minWidth: 100 },
    { key: 'exchangeRate', label: '汇率', minWidth: 110 },
    { key: 'costRmb', label: '人民币成本', minWidth: 130 },
    { key: 'supplier', label: '供应商', minWidth: 120 },
    { key: 'status', label: 'ID 状态', minWidth: 110 },
    { key: 'saleState', label: '销售状态', minWidth: 110 },
    { key: 'soldByOrder', label: '来源订单', minWidth: 180 },
    { key: 'recordStatus', label: '资料状态', minWidth: 110 },
    { key: 'updatedAt', label: '更新时间', minWidth: 160 },
    {
      key: 'actions',
      label: '操作',
      minWidth: V2_TABLE_ACTION_COLUMN_WIDTH.triple,
      fixed: 'right'
    }
  ],
  loadView: () => import('./V2AccountsView.vue')
});
