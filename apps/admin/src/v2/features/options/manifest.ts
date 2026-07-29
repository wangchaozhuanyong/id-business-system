import { defineV2Feature } from '@/v2/features/feature';

export const optionsFeature = defineV2Feature({
  key: 'options',
  title: '选项设置',
  group: '系统',
  route: '/v2/options',
  sourceSheet: '选项设置',
  permission: 'data.dictionary.manage',
  kind: 'list',
  loadingTier: 'reference',
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
    { key: 'name', label: '选项名称', minWidth: 180 },
    { key: 'remark', label: '备注', minWidth: 180 },
    { key: 'parent', label: '上级选项', minWidth: 160 },
    { key: 'country', label: '上级国家', minWidth: 130 },
    { key: 'businessAmount', label: '业务金额', minWidth: 130 },
    { key: 'currency', label: '默认货币', minWidth: 110 },
    { key: 'fixedFee', label: '固定手续费', minWidth: 130 },
    { key: 'percentageFee', label: '手续费百分比', minWidth: 140 },
    { key: 'sortOrder', label: '排序', minWidth: 90 },
    { key: 'systemFixed', label: '属性', minWidth: 110 },
    { key: 'status', label: '状态', minWidth: 100 },
    { key: 'updatedAt', label: '更新时间', minWidth: 160 },
    { key: 'actions', label: '操作', minWidth: 150, fixed: 'right' }
  ],
  loadView: () => import('./V2OptionsView.vue')
});
