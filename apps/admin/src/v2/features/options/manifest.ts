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
        '卡片名称',
        '结算平台'
      ]
    }
  ],
  columns: [
    { key: 'name', label: '选项名称', kind: 'text', widthPreset: 'identifier' },
    { key: 'remark', label: '备注', kind: 'text', widthPreset: 'identifier' },
    { key: 'parent', label: '上级选项', kind: 'text', widthPreset: 'wide' },
    { key: 'country', label: '上级国家', kind: 'text', widthPreset: 'wide' },
    { key: 'businessAmount', label: '业务金额', kind: 'numeric', widthPreset: 'standard' },
    { key: 'currency', label: '默认货币', kind: 'text', widthPreset: 'compact' },
    { key: 'fixedFee', label: '固定手续费', kind: 'numeric', widthPreset: 'standard' },
    {
      key: 'percentageFee',
      label: '手续费百分比',
      kind: 'numeric',
      widthPreset: 'wide'
    },
    { key: 'sortOrder', label: '排序', kind: 'numeric', widthPreset: 'compact' },
    { key: 'systemFixed', label: '属性', kind: 'status', widthPreset: 'compact' },
    { key: 'status', label: '状态', kind: 'status', widthPreset: 'compact' },
    { key: 'updatedAt', label: '更新时间', kind: 'date', widthPreset: 'dateTime' },
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
