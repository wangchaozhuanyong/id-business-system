import { V2_TABLE_ACTION_COLUMN_WIDTH } from '@/v2/components/tableActionLayout';
import { defineV2Feature } from '@/v2/features/feature';

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
        '结算平台'
      ]
    }
  ],
  columns: [
    { key: 'name', label: '选项名称', kind: 'text', minWidth: 180 },
    { key: 'remark', label: '备注', kind: 'text', minWidth: 180 },
    { key: 'parent', label: '上级选项', kind: 'text', minWidth: 160 },
    { key: 'country', label: '上级国家', kind: 'text', minWidth: 130 },
    { key: 'businessAmount', label: '业务金额', kind: 'numeric', minWidth: 128 },
    { key: 'currency', label: '默认货币', kind: 'text', minWidth: 110 },
    { key: 'fixedFee', label: '固定手续费', kind: 'numeric', minWidth: 128 },
    { key: 'percentageFee', label: '手续费百分比', kind: 'numeric', minWidth: 160 },
    { key: 'sortOrder', label: '排序', kind: 'numeric', minWidth: 112 },
    { key: 'systemFixed', label: '属性', kind: 'status', minWidth: 112 },
    { key: 'status', label: '状态', kind: 'status', minWidth: 112 },
    { key: 'updatedAt', label: '更新时间', kind: 'date', minWidth: 165 },
    {
      key: 'actions',
      label: '操作',
      kind: 'actions',
      minWidth: V2_TABLE_ACTION_COLUMN_WIDTH.double,
      fixed: 'right'
    }
  ],
  loadView: () => import('./V2OptionsView.vue')
});
