import { defineV2TableSchema } from '@/v2/components/tableSystem';

const table = defineV2TableSchema;

export const v2TableSchemas = {
  accountLosses: {
    main: table({
      id: 'account-losses.main',
      feature: 'account-losses',
      role: 'primary',
      mobileMode: 'cards',
      rowKey: { kind: 'path', value: 'id' },
      columns: [
        { key: 'rowNumber', label: '序号', kind: 'index', widthPreset: 'index', pin: 'start' },
        {
          key: 'ID 账号',
          label: 'ID 账号',
          kind: 'identifier',
          widthPreset: 'identifier',
          pin: 'start'
        },
        { key: 'countryName', label: '国家', kind: 'text', widthPreset: 'compact' },
        { key: '供应商', label: '供应商', kind: 'text', widthPreset: 'standard' },
        { key: '销售状态', label: '销售状态', kind: 'status', widthPreset: 'compact' },
        { key: '来源订单', label: '来源订单', kind: 'identifier', widthPreset: 'identifier' },
        { key: 'lossBalance', label: '损失余额', kind: 'numeric', widthPreset: 'standard' },
        { key: 'lossCostAmount', label: '人民币亏损', kind: 'numeric', widthPreset: 'standard' },
        { key: '记录状态', label: '记录状态', kind: 'status', widthPreset: 'compact' },
        { key: 'reason', label: '报损原因', kind: 'text', widthPreset: 'longText' },
        { key: '操作人', label: '操作人', kind: 'text', widthPreset: 'standard' },
        { key: 'reportedAt', label: '报损时间', kind: 'date', widthPreset: 'dateTime' },
        { key: 'actions', label: '操作', kind: 'actions', layout: 'single', pin: 'end' }
      ]
    })
  },
  accounts: {
    main: table({
      id: 'accounts.main',
      feature: 'accounts',
      role: 'primary',
      mobileMode: 'cards',
      rowKey: { kind: 'path', value: 'id' },
      columns: [
        { key: 'appleId', label: 'ID 账号', kind: 'identifier', widthPreset: 'identifier' },
        { key: '销售状态', label: '销售状态', kind: 'status', widthPreset: 'compact' },
        { key: '来源订单', label: '来源订单', kind: 'identifier', widthPreset: 'identifier' },
        { key: '国家', label: '国家', kind: 'text', widthPreset: 'compact' },
        { key: 'currentBalance', label: '余额', kind: 'numeric', widthPreset: 'compact' },
        { key: '汇率', label: '汇率', kind: 'numeric', widthPreset: 'compact' },
        { key: 'balanceCostAmount', label: '人民币成本', kind: 'numeric', widthPreset: 'standard' },
        { key: '供应商', label: '供应商', kind: 'text', widthPreset: 'standard' },
        { key: 'ID 状态', label: 'ID 状态', kind: 'status', widthPreset: 'compact' },
        { key: 'recordStatus', label: '资料状态', kind: 'status', widthPreset: 'compact' },
        { key: '操作人', label: '操作人', kind: 'text', widthPreset: 'standard' },
        { key: 'updatedAt', label: '更新时间', kind: 'date', widthPreset: 'dateTime' },
        { key: 'actions', label: '操作', kind: 'actions', layout: 'triple', pin: 'end' }
      ]
    }),
    importErrors: table({
      id: 'accounts.import-errors',
      feature: 'accounts',
      role: 'embedded',
      mobileMode: 'scroll',
      rowKey: null,
      columns: [
        { key: 'rowNumber', label: '行号', kind: 'index', widthPreset: 'index' },
        { key: 'reason', label: '未导入原因', kind: 'text', widthPreset: 'longText' }
      ]
    })
  },
  activations: {
    main: table({
      id: 'activation-records.main',
      feature: 'activation-records',
      role: 'primary',
      mobileMode: 'cards',
      rowKey: { kind: 'path', value: 'id' },
      columns: [
        { key: '订单', label: '订单', kind: 'identifier', widthPreset: 'identifier', pin: 'start' },
        { key: '客户', label: '客户', kind: 'text', widthPreset: 'wide' },
        { key: '业务', label: '业务', kind: 'text', widthPreset: 'wide' },
        { key: '苹果 ID', label: '苹果 ID', kind: 'identifier', widthPreset: 'identifier' },
        { key: '客户网站账号', label: '客户网站账号', kind: 'identifier', widthPreset: 'wide' },
        { key: 'openedAt', label: '开通日期', kind: 'date', widthPreset: 'dateTime' },
        { key: 'dueAt', label: '到期日期', kind: 'date', widthPreset: 'dateTime' },
        { key: '操作人', label: '操作人', kind: 'text', widthPreset: 'standard' },
        { key: 'status', label: '状态', kind: 'status', widthPreset: 'compact' },
        { key: 'actions', label: '操作', kind: 'actions', layout: 'single', pin: 'end' }
      ]
    })
  },
  auditLogs: {
    operations: table({
      id: 'audit-logs.operations',
      feature: 'audit-logs',
      role: 'primary',
      mobileMode: 'cards',
      rowKey: { kind: 'path', value: 'id' },
      columns: [
        { key: '操作人', label: '操作人', kind: 'text', widthPreset: 'wide', pin: 'start' },
        { key: 'module', label: '模块', kind: 'text', widthPreset: 'standard' },
        { key: 'action', label: '动作', kind: 'identifier', widthPreset: 'identifier' },
        { key: '对象', label: '对象', kind: 'identifier', widthPreset: 'longText' },
        { key: 'remark', label: '说明', kind: 'text', widthPreset: 'longText' },
        { key: 'createdAt', label: '时间', kind: 'date', widthPreset: 'dateTime' },
        { key: 'actions', label: '操作', kind: 'actions', layout: 'single', pin: 'end' }
      ]
    }),
    sensitiveAccess: table({
      id: 'audit-logs.sensitive-access',
      feature: 'audit-logs',
      role: 'secondary',
      mobileMode: 'cards',
      rowKey: { kind: 'path', value: 'id' },
      columns: [
        { key: '访问人', label: '访问人', kind: 'text', widthPreset: 'wide', pin: 'start' },
        { key: 'module', label: '模块', kind: 'text', widthPreset: 'standard' },
        { key: 'fieldName', label: '敏感字段', kind: 'identifier', widthPreset: 'identifier' },
        { key: '对象', label: '对象', kind: 'identifier', widthPreset: 'longText' },
        { key: 'approved', label: '审批', kind: 'status', widthPreset: 'compact' },
        { key: 'accessReason', label: '访问原因', kind: 'text', widthPreset: 'longText' },
        { key: 'createdAt', label: '时间', kind: 'date', widthPreset: 'dateTime' },
        { key: 'actions', label: '操作', kind: 'actions', layout: 'single', pin: 'end' }
      ]
    })
  },
  businessMonitoring: {
    main: table({
      id: 'business-monitoring.main',
      feature: 'business-monitoring',
      role: 'primary',
      mobileMode: 'cards',
      rowKey: { kind: 'path', value: 'id' },
      columns: [
        { key: '级别', label: '级别', kind: 'status', widthPreset: 'compact', pin: 'start' },
        { key: '分类', label: '分类', kind: 'text', widthPreset: 'standard' },
        { key: 'subject', label: '对象', kind: 'identifier', widthPreset: 'wide' },
        { key: 'description', label: '异常说明', kind: 'text', widthPreset: 'longText' },
        { key: '处理方式', label: '处理方式', kind: 'status', widthPreset: 'standard' },
        { key: '发现时间', label: '发现时间', kind: 'date', widthPreset: 'dateTime' },
        { key: 'actions', label: '操作', kind: 'actions', layout: 'single', pin: 'end' }
      ]
    })
  },
  customers: {
    main: table({
      id: 'customers.main',
      feature: 'customers',
      role: 'primary',
      mobileMode: 'cards',
      rowKey: { kind: 'path', value: 'id' },
      columns: [
        { key: 'name', label: '客户', kind: 'text', widthPreset: 'identifier' },
        { key: '手机号', label: '手机号', kind: 'identifier', widthPreset: 'wide' },
        { key: 'wechat', label: '微信', kind: 'identifier', widthPreset: 'wide' },
        { key: 'qq', label: 'QQ', kind: 'identifier', widthPreset: 'wide' },
        { key: 'WhatsApp', label: 'WhatsApp', kind: 'identifier', widthPreset: 'wide' },
        { key: '来源', label: '来源', kind: 'text', widthPreset: 'standard' },
        { key: '标签', label: '标签', kind: 'text', widthPreset: 'identifier' },
        { key: '历史开通业务', label: '历史开通业务', kind: 'text', widthPreset: 'identifier' },
        { key: 'recordStatus', label: '状态', kind: 'status', widthPreset: 'compact' },
        { key: '操作人', label: '操作人', kind: 'text', widthPreset: 'standard' },
        { key: 'updatedAt', label: '更新时间', kind: 'date', widthPreset: 'dateTime' },
        { key: 'actions', label: '操作', kind: 'actions', layout: 'triple', pin: 'end' }
      ]
    })
  },
  dashboard: {
    activity: table({
      id: 'dashboard.activity',
      feature: 'dashboard',
      role: 'primary',
      mobileMode: 'scroll',
      rowKey: { kind: 'path', value: 'id' },
      columns: [
        {
          key: 'orderNo',
          label: '订单号',
          kind: 'identifier',
          widthPreset: 'standard',
          pin: 'start'
        },
        { key: 'customer.name', label: '客户', kind: 'text', widthPreset: 'compact' },
        { key: 'serviceOption.name', label: '业务', kind: 'text', widthPreset: 'standard' },
        { key: 'status', label: '状态', kind: 'status', widthPreset: 'compact' },
        { key: 'receivedAmount', label: '收款', kind: 'numeric', widthPreset: 'compact' },
        { key: 'createdAt', label: '创建时间', kind: 'date', widthPreset: 'standard' },
        { key: 'actions', label: '操作', kind: 'actions', layout: 'icon', pin: 'end' }
      ]
    })
  },
  dataAnalytics: {
    settlementPlatforms: table({
      id: 'analytics.settlement-platforms',
      feature: 'analytics',
      role: 'primary',
      mobileMode: 'scroll',
      rowKey: { kind: 'binding', value: 'settlementPlatformRowKey' },
      columns: [
        {
          key: '结算平台',
          label: '结算平台',
          kind: 'text',
          widthPreset: 'identifier',
          pin: 'start'
        },
        { key: '已结算订单', label: '当前完成订单', kind: 'numeric', widthPreset: 'standard' },
        { key: '原币实收', label: '原币实收（退款前）', kind: 'text', widthPreset: 'identifier' },
        { key: '原币退款', label: '原币已退款', kind: 'text', widthPreset: 'identifier' },
        {
          key: '人民币实收',
          label: '人民币实收（退款前）',
          kind: 'numeric',
          widthPreset: 'standard'
        },
        { key: '退款', label: '人民币已退款', kind: 'numeric', widthPreset: 'standard' },
        { key: '手续费', label: '手续费', kind: 'numeric', widthPreset: 'standard' },
        { key: '净入账', label: '净收款', kind: 'numeric', widthPreset: 'standard' },
        { key: '已实现利润', label: '已实现利润', kind: 'numeric', widthPreset: 'standard' },
        { key: '利润率', label: '利润率', kind: 'numeric', widthPreset: 'standard' },
        { key: '处理中预计', label: '处理中预计', kind: 'numeric', widthPreset: 'wide' }
      ]
    }),
    currencies: table({
      id: 'analytics.currencies',
      feature: 'analytics',
      role: 'secondary',
      mobileMode: 'scroll',
      rowKey: { kind: 'path', value: 'currency' },
      columns: [
        { key: '币种', label: '币种', kind: 'status', widthPreset: 'compact' },
        { key: '收入', label: '现金流入', kind: 'numeric', widthPreset: 'standard' },
        { key: '经营收入', label: '手工经营收入', kind: 'numeric', widthPreset: 'standard' },
        { key: '股东投入', label: '股东投入', kind: 'numeric', widthPreset: 'standard' },
        { key: '借入资金', label: '借入资金', kind: 'numeric', widthPreset: 'standard' },
        { key: '支出', label: '支出', kind: 'numeric', widthPreset: 'standard' },
        { key: '净现金流', label: '净现金流', kind: 'numeric', widthPreset: 'standard' },
        { key: '最新汇率', label: '最新汇率', kind: 'numeric', widthPreset: 'standard' },
        { key: '最新估值', label: '最新估值', kind: 'numeric', widthPreset: 'standard' }
      ]
    }),
    supplierWallets: table({
      id: 'analytics.supplier-wallets',
      feature: 'analytics',
      role: 'secondary',
      mobileMode: 'scroll',
      rowKey: { kind: 'path', value: 'id' },
      columns: [
        { key: '供应商', label: '供应商', kind: 'text', widthPreset: 'identifier', pin: 'start' },
        { key: '币种', label: '币种', kind: 'status', widthPreset: 'compact' },
        { key: '期初余额', label: '期初余额', kind: 'numeric', widthPreset: 'standard' },
        { key: '当前余额', label: '当前余额', kind: 'numeric', widthPreset: 'standard' },
        { key: '账面人民币', label: '账面人民币', kind: 'numeric', widthPreset: 'standard' },
        { key: '状态', label: '状态', kind: 'status', widthPreset: 'compact' }
      ]
    }),
    journals: table({
      id: 'analytics.journals',
      feature: 'analytics',
      role: 'secondary',
      mobileMode: 'scroll',
      rowKey: { kind: 'path', value: 'id' },
      columns: [
        {
          key: 'details',
          label: '明细',
          kind: 'control',
          control: 'expand',
          width: 52,
          pin: 'start'
        },
        {
          key: '财务流水号',
          label: '财务流水号',
          kind: 'identifier',
          widthPreset: 'wide',
          pin: 'start'
        },
        { key: '发生时间', label: '发生时间', kind: 'date', widthPreset: 'dateTime' },
        { key: '业务类型', label: '业务类型', kind: 'status', widthPreset: 'wide' },
        { key: 'summary', label: '摘要', kind: 'text', widthPreset: 'longText' },
        { key: '来源单号', label: '来源单号', kind: 'identifier', widthPreset: 'identifier' },
        { key: '人民币金额', label: '人民币金额', kind: 'numeric', widthPreset: 'standard' }
      ]
    })
  },
  dataGovernance: {
    recycle: table({
      id: 'data-governance.recycle',
      feature: 'data-governance',
      role: 'primary',
      mobileMode: 'cards',
      rowKey: { kind: 'path', value: 'id' },
      columns: [
        {
          key: 'selection',
          label: '',
          kind: 'control',
          control: 'selection',
          width: 46,
          pin: 'start'
        },
        { key: '类型', label: '类型', kind: 'text', widthPreset: 'standard' },
        { key: 'label', label: '记录', kind: 'identifier', widthPreset: 'wide' },
        { key: '删除时间', label: '删除时间', kind: 'date', widthPreset: 'dateTime' },
        { key: '恢复状态', label: '恢复状态', kind: 'status', widthPreset: 'standard' }
      ]
    }),
    jobs: table({
      id: 'data-governance.jobs',
      feature: 'data-governance',
      role: 'secondary',
      mobileMode: 'cards',
      rowKey: { kind: 'path', value: 'id' },
      columns: [
        { key: 'jobNo', label: '任务编号', kind: 'identifier', widthPreset: 'wide', pin: 'start' },
        { key: '类型', label: '类型', kind: 'text', widthPreset: 'standard' },
        { key: '状态', label: '状态', kind: 'status', widthPreset: 'standard' },
        { key: '执行结果', label: '执行结果', kind: 'numeric', widthPreset: 'standard' },
        { key: '申请人', label: '申请人', kind: 'text', widthPreset: 'standard' },
        { key: '审批人', label: '审批人', kind: 'text', widthPreset: 'standard' },
        { key: '创建时间', label: '创建时间', kind: 'date', widthPreset: 'dateTime' },
        { key: 'actions', label: '操作', kind: 'actions', layout: 'triple', pin: 'end' }
      ]
    }),
    items: table({
      id: 'data-governance.items',
      feature: 'data-governance',
      role: 'embedded',
      mobileMode: 'scroll',
      rowKey: null,
      columns: [
        { key: 'sequence', label: '#', kind: 'index', widthPreset: 'index' },
        { key: '类型', label: '类型', kind: 'text', widthPreset: 'standard' },
        { key: 'safeLabel', label: '对象', kind: 'identifier', widthPreset: 'wide' },
        { key: '状态', label: '状态', kind: 'status', widthPreset: 'standard' },
        { key: 'resultMessage', label: '结果', kind: 'text', widthPreset: 'longText' },
        { key: '审计编号', label: '审计编号', kind: 'identifier', widthPreset: 'wide' }
      ]
    }),
    checkpoints: table({
      id: 'data-governance.checkpoints',
      feature: 'data-governance',
      role: 'embedded',
      mobileMode: 'scroll',
      rowKey: null,
      columns: [
        { key: 'batchNo', label: '批次', kind: 'index', widthPreset: 'index' },
        { key: 'status', label: '状态', kind: 'status', widthPreset: 'standard' },
        { key: 'attemptedItems', label: '处理数', kind: 'numeric', widthPreset: 'compact' },
        { key: 'succeededItems', label: '成功', kind: 'numeric', widthPreset: 'compact' },
        { key: 'skippedItems', label: '跳过', kind: 'numeric', widthPreset: 'compact' },
        { key: 'failedItems', label: '失败', kind: 'numeric', widthPreset: 'compact' },
        { key: '完成时间', label: '完成时间', kind: 'date', widthPreset: 'dateTime' }
      ]
    })
  },
  employees: {
    main: table({
      id: 'employees.main',
      feature: 'employees',
      role: 'primary',
      mobileMode: 'cards',
      rowKey: { kind: 'path', value: 'id' },
      columns: [
        {
          key: 'username',
          label: '登录账号',
          kind: 'identifier',
          widthPreset: 'identifier',
          pin: 'start'
        },
        { key: 'displayName', label: '员工姓名', kind: 'text', widthPreset: 'wide' },
        { key: '角色', label: '角色', kind: 'text', widthPreset: 'wide' },
        { key: 'status', label: '状态', kind: 'status', widthPreset: 'compact' },
        { key: '在线会话', label: '在线会话', kind: 'numeric', widthPreset: 'compact' },
        { key: '密码状态', label: '密码状态', kind: 'status', widthPreset: 'standard' },
        { key: 'lastLoginAt', label: '最近登录', kind: 'date', widthPreset: 'dateTime' },
        { key: '操作人', label: '操作人', kind: 'text', widthPreset: 'standard' },
        { key: 'createdAt', label: '开通时间', kind: 'date', widthPreset: 'dateTime' },
        { key: 'actions', label: '操作', kind: 'actions', layout: 'single', pin: 'end' }
      ]
    })
  },
  exchangeRates: {
    purchaseQuotes: table({
      id: 'exchange-rates.purchase-quotes',
      feature: 'exchange-rates',
      role: 'primary',
      mobileMode: 'scroll',
      rowKey: { kind: 'path', value: 'code' },
      columns: [
        { key: '币种', label: '货币', kind: 'identifier', widthPreset: 'identifier', pin: 'start' },
        { key: '市场汇率', label: '国际人民币汇率', kind: 'numeric', widthPreset: 'standard' },
        { key: '收购比例', label: '收购比例', kind: 'numeric', widthPreset: 'compact' },
        { key: '显示单位', label: '显示单位', kind: 'numeric', widthPreset: 'compact' },
        { key: '今日收购价', label: '今日收购价', kind: 'numeric', widthPreset: 'standard' },
        { key: '小数规则', label: '小数规则', kind: 'text', widthPreset: 'standard' },
        { key: '汇率时间', label: '汇率时间', kind: 'date', widthPreset: 'dateTime' },
        { key: '状态', label: '状态', kind: 'status', widthPreset: 'compact' },
        { key: 'actions', label: '操作', kind: 'actions', layout: 'single', pin: 'end' }
      ]
    }),
    snapshots: table({
      id: 'exchange-rates.snapshots',
      feature: 'exchange-rates',
      role: 'primary',
      mobileMode: 'scroll',
      rowKey: { kind: 'path', value: 'id' },
      columns: [
        { key: '采集时间', label: '采集时间', kind: 'date', widthPreset: 'dateTime', pin: 'start' },
        { key: '币种', label: '币种', kind: 'status', widthPreset: 'compact' },
        { key: '汇率', label: '兑人民币汇率', kind: 'numeric', widthPreset: 'standard' },
        { key: '来源', label: '来源', kind: 'text', widthPreset: 'wide' },
        { key: '状态', label: '状态', kind: 'status', widthPreset: 'compact' },
        { key: '业务日期', label: '业务日期', kind: 'date', widthPreset: 'standard' },
        { key: '过期时间', label: '过期时间', kind: 'date', widthPreset: 'dateTime' },
        { key: '证据', label: '证据', kind: 'text', widthPreset: 'identifier' },
        { key: 'actions', label: '操作', kind: 'actions', layout: 'icon', pin: 'end' }
      ]
    }),
    manualChanges: table({
      id: 'exchange-rates.manual-changes',
      feature: 'exchange-rates',
      role: 'secondary',
      mobileMode: 'scroll',
      rowKey: { kind: 'path', value: 'id' },
      columns: [
        { key: '记录时间', label: '记录时间', kind: 'date', widthPreset: 'dateTime', pin: 'start' },
        { key: '币种', label: '币种', kind: 'status', widthPreset: 'compact' },
        { key: '汇率', label: '兑人民币汇率', kind: 'numeric', widthPreset: 'standard' },
        { key: '来源', label: '来源说明', kind: 'text', widthPreset: 'identifier' },
        { key: '原因', label: '原因', kind: 'text', widthPreset: 'longText' },
        { key: '操作人', label: '操作人', kind: 'text', widthPreset: 'standard' },
        { key: 'actions', label: '操作', kind: 'actions', layout: 'icon', pin: 'end' }
      ]
    }),
    offers: table({
      id: 'exchange-rates.offers',
      feature: 'exchange-rates',
      role: 'embedded',
      mobileMode: 'scroll',
      rowKey: { kind: 'path', value: 'sourceAdId' },
      columns: [
        { key: 'sourceAdId', label: '公开广告编号', kind: 'identifier', widthPreset: 'identifier' },
        { key: '价格', label: '价格', kind: 'numeric', widthPreset: 'compact' },
        { key: '最低成交额', label: '最低成交额', kind: 'numeric', widthPreset: 'standard' },
        { key: '最高成交额', label: '最高成交额', kind: 'numeric', widthPreset: 'standard' },
        { key: 'completedOrderCount', label: '完成订单', kind: 'numeric', widthPreset: 'compact' },
        { key: '完成率', label: '完成率', kind: 'numeric', widthPreset: 'compact' }
      ]
    })
  },
  financeLedger: {
    accounts: table({
      id: 'finance-ledger.accounts',
      feature: 'finance-ledger',
      role: 'primary',
      mobileMode: 'scroll',
      rowKey: { kind: 'path', value: 'id' },
      columns: [
        { key: '账户', label: '账户', kind: 'text', widthPreset: 'identifier', pin: 'start' },
        { key: '类型', label: '类型', kind: 'status', widthPreset: 'compact' },
        { key: '币种', label: '币种', kind: 'status', widthPreset: 'compact' },
        { key: '期初余额', label: '期初余额', kind: 'numeric', widthPreset: 'standard' },
        { key: '当前余额', label: '当前余额', kind: 'numeric', widthPreset: 'standard' },
        { key: '账面人民币', label: '账面人民币', kind: 'numeric', widthPreset: 'standard' },
        { key: '状态', label: '状态', kind: 'status', widthPreset: 'compact' },
        { key: 'actions', label: '操作', kind: 'actions', layout: 'single', pin: 'end' }
      ]
    }),
    supplierWallets: table({
      id: 'finance-ledger.supplier-wallets',
      feature: 'finance-ledger',
      role: 'secondary',
      mobileMode: 'scroll',
      rowKey: { kind: 'path', value: 'id' },
      columns: [
        { key: '供应商', label: '供应商', kind: 'text', widthPreset: 'identifier', pin: 'start' },
        { key: '币种', label: '币种', kind: 'status', widthPreset: 'compact' },
        { key: '期初余额', label: '期初余额', kind: 'numeric', widthPreset: 'standard' },
        { key: '当前余额', label: '当前余额', kind: 'numeric', widthPreset: 'standard' },
        { key: '账面人民币', label: '账面人民币', kind: 'numeric', widthPreset: 'standard' },
        { key: '初始化时间', label: '初始化时间', kind: 'date', widthPreset: 'dateTime' },
        { key: 'actions', label: '操作', kind: 'actions', layout: 'single', pin: 'end' }
      ]
    }),
    inflows: table({
      id: 'finance-ledger.inflows',
      feature: 'finance-ledger',
      role: 'secondary',
      mobileMode: 'scroll',
      rowKey: { kind: 'path', value: 'id' },
      columns: [
        { key: '发生时间', label: '发生时间', kind: 'date', widthPreset: 'dateTime', pin: 'start' },
        { key: '资金性质', label: '资金性质', kind: 'status', widthPreset: 'standard' },
        { key: '收入分类', label: '收入分类', kind: 'text', widthPreset: 'identifier' },
        { key: '收款账户', label: '收款账户', kind: 'text', widthPreset: 'wide' },
        { key: '原币金额', label: '原币金额', kind: 'numeric', widthPreset: 'standard' },
        { key: '交易汇率', label: '交易汇率', kind: 'numeric', widthPreset: 'standard' },
        { key: '人民币金额', label: '人民币金额', kind: 'numeric', widthPreset: 'standard' },
        { key: '付款方', label: '付款方／出资人', kind: 'text', widthPreset: 'wide' },
        { key: '业务流水号', label: '业务流水号', kind: 'identifier', widthPreset: 'wide' },
        { key: '操作人', label: '操作人', kind: 'text', widthPreset: 'standard' },
        { key: '备注', label: '备注', kind: 'text', widthPreset: 'longText' },
        { key: '状态', label: '状态', kind: 'status', widthPreset: 'compact' },
        { key: 'actions', label: '操作', kind: 'actions', layout: 'double', pin: 'end' }
      ]
    }),
    expenses: table({
      id: 'finance-ledger.expenses',
      feature: 'finance-ledger',
      role: 'secondary',
      mobileMode: 'scroll',
      rowKey: { kind: 'path', value: 'id' },
      columns: [
        { key: '发生时间', label: '发生时间', kind: 'date', widthPreset: 'dateTime', pin: 'start' },
        { key: '分类', label: '分类', kind: 'text', widthPreset: 'identifier' },
        { key: '付款账户', label: '付款账户', kind: 'text', widthPreset: 'wide' },
        { key: '原币金额', label: '原币金额', kind: 'numeric', widthPreset: 'standard' },
        { key: '交易汇率', label: '交易汇率', kind: 'numeric', widthPreset: 'standard' },
        { key: '人民币金额', label: '人民币金额', kind: 'numeric', widthPreset: 'standard' },
        { key: '收款方', label: '收款方', kind: 'text', widthPreset: 'wide' },
        { key: '操作人', label: '操作人', kind: 'text', widthPreset: 'standard' },
        { key: '备注', label: '备注', kind: 'text', widthPreset: 'longText' },
        { key: '状态', label: '状态', kind: 'status', widthPreset: 'compact' },
        { key: 'actions', label: '操作', kind: 'actions', layout: 'single', pin: 'end' }
      ]
    }),
    journals: table({
      id: 'finance-ledger.journals',
      feature: 'finance-ledger',
      role: 'secondary',
      mobileMode: 'scroll',
      rowKey: { kind: 'path', value: 'id' },
      columns: [
        {
          key: 'details',
          label: '明细',
          kind: 'control',
          control: 'expand',
          width: 52,
          pin: 'start'
        },
        { key: '流水号', label: '流水号', kind: 'identifier', widthPreset: 'wide', pin: 'start' },
        { key: '发生时间', label: '发生时间', kind: 'date', widthPreset: 'dateTime' },
        { key: '业务类型', label: '业务类型', kind: 'status', widthPreset: 'wide' },
        { key: 'summary', label: '摘要', kind: 'text', widthPreset: 'longText' },
        { key: '来源', label: '来源', kind: 'identifier', widthPreset: 'identifier' },
        { key: '状态', label: '状态', kind: 'status', widthPreset: 'compact' },
        { key: 'actions', label: '操作', kind: 'actions', layout: 'single', pin: 'end' }
      ]
    }),
    periods: table({
      id: 'finance-ledger.periods',
      feature: 'finance-ledger',
      role: 'secondary',
      mobileMode: 'scroll',
      rowKey: { kind: 'path', value: 'month' },
      columns: [
        { key: '月份', label: '月份', kind: 'identifier', widthPreset: 'identifier', pin: 'start' },
        { key: '状态', label: '状态', kind: 'status', widthPreset: 'compact' },
        { key: '关账时间', label: '关账时间', kind: 'date', widthPreset: 'dateTime' },
        { key: '重开时间', label: '重开时间', kind: 'date', widthPreset: 'dateTime' },
        { key: '重开原因', label: '重开原因', kind: 'text', widthPreset: 'longText' },
        { key: 'actions', label: '操作', kind: 'actions', layout: 'single', pin: 'end' }
      ]
    })
  },
  options: {
    main: table({
      id: 'options.main',
      feature: 'options',
      role: 'primary',
      mobileMode: 'scroll',
      rowKey: { kind: 'path', value: 'id' },
      columns: [
        { key: 'name', label: '选项名称', kind: 'text', widthPreset: 'identifier' },
        { key: 'remark', label: '备注', kind: 'text', widthPreset: 'identifier' },
        { key: '上级选项', label: '上级选项', kind: 'text', widthPreset: 'wide' },
        { key: '上级国家', label: '上级国家', kind: 'text', widthPreset: 'wide' },
        { key: '业务金额', label: '业务金额', kind: 'numeric', widthPreset: 'standard' },
        { key: '默认货币', label: '默认货币', kind: 'text', widthPreset: 'compact' },
        { key: '固定手续费', label: '固定手续费', kind: 'numeric', widthPreset: 'standard' },
        { key: '百分比手续费', label: '百分比手续费', kind: 'numeric', widthPreset: 'wide' },
        { key: 'sortOrder', label: '排序', kind: 'numeric', widthPreset: 'compact' },
        { key: '属性', label: '属性', kind: 'status', widthPreset: 'compact' },
        { key: 'status', label: '状态', kind: 'status', widthPreset: 'compact' },
        { key: 'updatedAt', label: '更新时间', kind: 'date', widthPreset: 'dateTime' },
        { key: 'actions', label: '操作', kind: 'actions', layout: 'double', pin: 'end' }
      ]
    })
  },
  orders: {
    main: table({
      id: 'orders.main',
      feature: 'orders',
      role: 'primary',
      mobileMode: 'cards',
      rowKey: { kind: 'path', value: 'id' },
      columns: [
        {
          key: 'orderNo',
          label: '订单',
          kind: 'identifier',
          widthPreset: 'identifier',
          pin: 'start'
        },
        { key: 'createdAt', label: '创建时间', kind: 'date', widthPreset: 'dateTime' },
        { key: '操作人', label: '操作人', kind: 'text', widthPreset: 'standard' },
        { key: '客户', label: '客户', kind: 'text', widthPreset: 'wide' },
        { key: '分类', label: '分类', kind: 'text', widthPreset: 'standard' },
        { key: '业务', label: '业务', kind: 'text', widthPreset: 'wide' },
        { key: '使用 ID', label: '使用 ID', kind: 'identifier', widthPreset: 'identifier' },
        {
          key: 'accountDisposition',
          label: 'ID 处理状态',
          kind: 'status',
          widthPreset: 'standard'
        },
        {
          key: 'accountCostAmount',
          label: 'ID成本',
          kind: 'numeric',
          widthPreset: 'standard'
        },
        { key: '客户网站账号', label: '客户网站账号', kind: 'identifier', widthPreset: 'wide' },
        { key: 'receivedAmount', label: '实收金额', kind: 'numeric', widthPreset: 'standard' },
        { key: 'profitAmount', label: '利润', kind: 'numeric', widthPreset: 'standard' },
        { key: '利润率', label: '利润率', kind: 'numeric', widthPreset: 'standard' },
        { key: 'openedAt', label: '开通时间', kind: 'date', widthPreset: 'dateTime' },
        { key: 'dueAt', label: '到期时间', kind: 'date', widthPreset: 'dateTime' },
        {
          key: 'status',
          label: '状态/下一步',
          kind: 'status',
          widthPreset: 'wide',
          pin: 'end',
          hideable: false
        },
        { key: 'actions', label: '操作', kind: 'actions', layout: 'double', pin: 'end' }
      ]
    })
  },
  profile: {
    sessions: table({
      id: 'profile.sessions',
      feature: 'profile',
      role: 'primary',
      mobileMode: 'cards',
      rowKey: { kind: 'path', value: 'id' },
      columns: [
        { key: 'userAgent', label: '客户端', kind: 'text', widthPreset: 'longText', pin: 'start' },
        { key: 'ip', label: 'IP', kind: 'identifier', widthPreset: 'identifier' },
        { key: '状态', label: '状态', kind: 'status', widthPreset: 'compact' },
        { key: 'lastActiveAt', label: '最近活动', kind: 'date', widthPreset: 'dateTime' },
        { key: 'expiresAt', label: '到期时间', kind: 'date', widthPreset: 'dateTime' },
        { key: 'actions', label: '操作', kind: 'actions', layout: 'double', pin: 'end' }
      ]
    })
  },
  renewals: {
    main: table({
      id: 'renewal-workbench.main',
      feature: 'renewal-workbench',
      role: 'primary',
      mobileMode: 'cards',
      rowKey: { kind: 'path', value: 'id' },
      columns: [
        { key: 'customer', label: '客户', kind: 'text', widthPreset: 'standard', pin: 'start' },
        { key: 'account', label: 'ID账号', kind: 'identifier', widthPreset: 'identifier' },
        { key: '国家', label: '国家', kind: 'text', widthPreset: 'compact' },
        { key: '客户网站账号', label: '客户网站账号', kind: 'identifier', widthPreset: 'wide' },
        { key: 'currentBalance', label: 'ID余额', kind: 'numeric', widthPreset: 'compact' },
        { key: 'service', label: '当前业务', kind: 'text', widthPreset: 'standard' },
        { key: 'openedAt', label: '开通时间', kind: 'date', widthPreset: 'dateTime' },
        { key: 'dueAt', label: '到期时间', kind: 'date', widthPreset: 'dateTime' },
        { key: '状态', label: '状态', kind: 'status', widthPreset: 'compact', pin: 'end' },
        { key: 'actions', label: '操作', kind: 'actions', layout: 'single', pin: 'end' }
      ]
    })
  },
  roles: {
    main: table({
      id: 'roles.main',
      feature: 'roles',
      role: 'primary',
      mobileMode: 'cards',
      rowKey: { kind: 'path', value: 'id' },
      columns: [
        { key: 'name', label: '角色名称', kind: 'text', widthPreset: 'wide', pin: 'start' },
        { key: 'code', label: '角色编码', kind: 'identifier', widthPreset: 'identifier' },
        { key: 'description', label: '角色说明', kind: 'text', widthPreset: 'wide' },
        { key: '权限数量', label: '权限数量', kind: 'numeric', widthPreset: 'compact' },
        { key: '成员数量', label: '成员数量', kind: 'numeric', widthPreset: 'compact' },
        { key: 'updatedAt', label: '更新时间', kind: 'date', widthPreset: 'dateTime' },
        { key: 'actions', label: '操作', kind: 'actions', layout: 'single', pin: 'end' }
      ]
    })
  },
  security: {
    loginLogs: table({
      id: 'security.login-logs',
      feature: 'security',
      role: 'primary',
      mobileMode: 'cards',
      rowKey: { kind: 'path', value: 'id' },
      columns: [
        { key: '用户', label: '用户', kind: 'text', widthPreset: 'wide', pin: 'start' },
        { key: 'status', label: '结果', kind: 'status', widthPreset: 'compact' },
        { key: 'abnormal', label: '风险', kind: 'status', widthPreset: 'compact' },
        { key: 'ip', label: 'IP', kind: 'identifier', widthPreset: 'identifier' },
        { key: 'failureReason', label: '失败原因', kind: 'text', widthPreset: 'longText' },
        { key: 'userAgent', label: '客户端', kind: 'text', widthPreset: 'longText' },
        { key: 'createdAt', label: '时间', kind: 'date', widthPreset: 'dateTime' }
      ]
    }),
    sessions: table({
      id: 'security.sessions',
      feature: 'security',
      role: 'secondary',
      mobileMode: 'cards',
      rowKey: { kind: 'path', value: 'id' },
      columns: [
        { key: '用户', label: '用户', kind: 'text', widthPreset: 'wide', pin: 'start' },
        { key: '状态', label: '状态', kind: 'status', widthPreset: 'compact' },
        { key: 'ip', label: 'IP', kind: 'identifier', widthPreset: 'identifier' },
        { key: 'userAgent', label: '客户端', kind: 'text', widthPreset: 'longText' },
        { key: 'lastActiveAt', label: '最近活动', kind: 'date', widthPreset: 'dateTime' },
        { key: 'expiresAt', label: '到期时间', kind: 'date', widthPreset: 'dateTime' },
        { key: 'actions', label: '操作', kind: 'actions', layout: 'double', pin: 'end' }
      ]
    }),
    mfaUsers: table({
      id: 'security.mfa-users',
      feature: 'security',
      role: 'secondary',
      mobileMode: 'cards',
      rowKey: { kind: 'path', value: 'id' },
      columns: [
        { key: 'username', label: '登录账号', kind: 'identifier', widthPreset: 'wide' },
        { key: 'displayName', label: '员工姓名', kind: 'text', widthPreset: 'wide' },
        { key: '角色', label: '角色', kind: 'text', widthPreset: 'wide' },
        { key: '账号状态', label: '账号状态', kind: 'status', widthPreset: 'compact' },
        { key: 'MFA', label: 'MFA', kind: 'status', widthPreset: 'compact' },
        { key: 'recoveryCodeCount', label: '恢复码', kind: 'numeric', widthPreset: 'compact' },
        { key: 'lastUsedAt', label: '最近使用', kind: 'date', widthPreset: 'dateTime' },
        { key: 'actions', label: '操作', kind: 'actions', layout: 'double', pin: 'end' }
      ]
    }),
    whitelist: table({
      id: 'security.whitelist',
      feature: 'security',
      role: 'secondary',
      mobileMode: 'cards',
      rowKey: { kind: 'path', value: 'id' },
      columns: [
        {
          key: 'ipOrCidr',
          label: 'IP 或 CIDR',
          kind: 'identifier',
          widthPreset: 'wide',
          pin: 'start'
        },
        { key: 'scope', label: '范围', kind: 'status', widthPreset: 'compact' },
        { key: 'enabled', label: '状态', kind: 'status', widthPreset: 'compact' },
        { key: 'remark', label: '说明', kind: 'text', widthPreset: 'longText' },
        { key: '创建人', label: '创建人', kind: 'text', widthPreset: 'wide' },
        { key: 'updatedAt', label: '更新时间', kind: 'date', widthPreset: 'dateTime' },
        { key: 'actions', label: '操作', kind: 'actions', layout: 'double', pin: 'end' }
      ]
    })
  },
  topupRecords: {
    giftCards: table({
      id: 'topup-records.gift-cards',
      feature: 'topup-records',
      role: 'primary',
      mobileMode: 'cards',
      rowKey: { kind: 'path', value: 'id' },
      columns: [
        { key: '序号', label: '序号', kind: 'index', widthPreset: 'index', pin: 'start' },
        {
          key: '礼品卡号',
          label: '礼品卡号',
          kind: 'identifier',
          widthPreset: 'identifier',
          pin: 'start'
        },
        { key: '卡片名称', label: '卡片名称', kind: 'text', widthPreset: 'standard' },
        { key: 'faceValue', label: '面值', kind: 'numeric', widthPreset: 'compact' },
        { key: 'exchangeRate', label: '卡片汇率', kind: 'numeric', widthPreset: 'compact' },
        {
          key: 'costAmount',
          label: '卡值（RMB）',
          kind: 'numeric',
          widthPreset: 'standard'
        },
        { key: '加入 ID', label: '加入 ID', kind: 'identifier', widthPreset: 'identifier' },
        { key: '国家', label: '国家', kind: 'text', widthPreset: 'compact' },
        { key: '供应商', label: '供应商', kind: 'text', widthPreset: 'standard' },
        { key: 'ID 加卡前余额', label: 'ID 加卡前余额', kind: 'numeric', widthPreset: 'standard' },
        { key: 'ID 加卡后余额', label: 'ID 加卡后余额', kind: 'numeric', widthPreset: 'standard' },
        { key: '操作人', label: '操作人', kind: 'text', widthPreset: 'standard' },
        { key: 'remark', label: '备注', kind: 'text', widthPreset: 'wide' },
        { key: 'creditedAt', label: '加卡时间', kind: 'date', widthPreset: 'dateTime' },
        { key: 'status', label: '状态', kind: 'status', widthPreset: 'compact' },
        { key: 'actions', label: '操作', kind: 'actions', layout: 'triple', pin: 'end' }
      ]
    }),
    balanceLedger: table({
      id: 'topup-records.balance-ledger',
      feature: 'topup-records',
      role: 'secondary',
      mobileMode: 'cards',
      rowKey: { kind: 'path', value: 'id' },
      columns: [
        { key: '序号', label: '序号', kind: 'index', widthPreset: 'index', pin: 'start' },
        { key: '变动类型', label: '变动类型', kind: 'text', widthPreset: 'standard', pin: 'start' },
        { key: '礼品卡', label: '礼品卡', kind: 'identifier', widthPreset: 'identifier' },
        { key: 'ID 账号', label: 'ID 账号', kind: 'identifier', widthPreset: 'identifier' },
        { key: '国家', label: '国家', kind: 'text', widthPreset: 'compact' },
        { key: 'balanceAmount', label: '余额变动', kind: 'numeric', widthPreset: 'standard' },
        { key: '变动前余额', label: '变动前余额', kind: 'numeric', widthPreset: 'standard' },
        { key: '变动后余额', label: '变动后余额', kind: 'numeric', widthPreset: 'standard' },
        { key: 'costAmount', label: '成本变动', kind: 'numeric', widthPreset: 'standard' },
        { key: '变动前成本', label: '变动前成本', kind: 'numeric', widthPreset: 'standard' },
        { key: '变动后成本', label: '变动后成本', kind: 'numeric', widthPreset: 'standard' },
        { key: '平均成本', label: '平均成本', kind: 'numeric', widthPreset: 'standard' },
        { key: '关联', label: '关联', kind: 'text', widthPreset: 'compact' },
        { key: '操作人', label: '操作人', kind: 'text', widthPreset: 'standard' },
        { key: 'createdAt', label: '变动时间', kind: 'date', widthPreset: 'dateTime' }
      ]
    }),
    supplierFunds: table({
      id: 'topup-records.supplier-funds',
      feature: 'topup-records',
      role: 'secondary',
      mobileMode: 'cards',
      rowKey: { kind: 'path', value: 'supplier.id' },
      columns: [
        { key: '供应商', label: '供应商', kind: 'text', widthPreset: 'identifier', pin: 'start' },
        { key: '资金状态', label: '资金状态', kind: 'status', widthPreset: 'compact' },
        {
          key: '当前人民币余额',
          label: '当前人民币余额',
          kind: 'numeric',
          widthPreset: 'standard'
        },
        { key: '累计有效付款', label: '累计有效付款', kind: 'numeric', widthPreset: 'standard' },
        { key: '累计加卡扣款', label: '累计加卡扣款', kind: 'numeric', widthPreset: 'standard' },
        { key: '期初及净调账', label: '期初及净调账', kind: 'numeric', widthPreset: 'standard' },
        { key: '最近付款', label: '最近付款', kind: 'date', widthPreset: 'dateTime' },
        { key: '最近加卡', label: '最近加卡', kind: 'date', widthPreset: 'dateTime' },
        { key: 'actions', label: '操作', kind: 'actions', layout: 'triple', pin: 'end' }
      ]
    }),
    supplierPayments: table({
      id: 'topup-records.supplier-payments',
      feature: 'topup-records',
      role: 'secondary',
      mobileMode: 'cards',
      rowKey: { kind: 'path', value: 'id' },
      columns: [
        { key: '供应商', label: '供应商', kind: 'text', widthPreset: 'identifier', pin: 'start' },
        { key: 'receivedUsdt', label: '到账 USDT', kind: 'numeric', widthPreset: 'standard' },
        { key: '手续费 USDT', label: '手续费 USDT', kind: 'numeric', widthPreset: 'standard' },
        {
          key: 'settlementRateCnyUsdt',
          label: '结算汇率',
          kind: 'numeric',
          widthPreset: 'standard'
        },
        { key: 'creditedCny', label: '折算人民币', kind: 'numeric', widthPreset: 'standard' },
        {
          key: '供应商余额快照',
          label: '供应商余额快照',
          kind: 'numeric',
          widthPreset: 'identifier'
        },
        { key: '网络和交易哈希', label: '网络和交易哈希', kind: 'text', widthPreset: 'longText' },
        { key: 'paidAt', label: '实际付款时间', kind: 'date', widthPreset: 'dateTime' },
        { key: 'createdAt', label: '系统入账时间', kind: 'date', widthPreset: 'dateTime' },
        { key: '状态', label: '状态', kind: 'status', widthPreset: 'compact' },
        { key: '备注', label: '备注', kind: 'text', widthPreset: 'wide' },
        { key: '操作人', label: '操作人', kind: 'text', widthPreset: 'standard' },
        { key: 'actions', label: '操作', kind: 'actions', layout: 'triple', pin: 'end' }
      ]
    }),
    supplierFundDetails: table({
      id: 'topup-records.supplier-fund-details',
      feature: 'topup-records',
      role: 'embedded',
      mobileMode: 'scroll',
      rowKey: { kind: 'path', value: 'id' },
      columns: [
        { key: '类型', label: '类型', kind: 'text', widthPreset: 'wide' },
        { key: '余额变动', label: '余额变动', kind: 'numeric', widthPreset: 'standard' },
        { key: '变动前', label: '变动前', kind: 'numeric', widthPreset: 'standard' },
        { key: '变动后', label: '变动后', kind: 'numeric', widthPreset: 'standard' },
        { key: '关联记录', label: '关联记录', kind: 'identifier', widthPreset: 'identifier' },
        { key: '原因', label: '原因', kind: 'text', widthPreset: 'identifier' },
        { key: '入账时间', label: '入账时间', kind: 'date', widthPreset: 'dateTime' }
      ]
    })
  },
  topups: {
    available: table({
      id: 'topup-workbench.available',
      feature: 'topup-workbench',
      role: 'primary',
      mobileMode: 'cards',
      rowKey: { kind: 'path', value: 'id' },
      columns: [
        {
          key: 'appleId',
          label: 'ID 账号',
          kind: 'identifier',
          widthPreset: 'identifier',
          pin: 'start'
        },
        { key: '国家', label: '国家', kind: 'text', widthPreset: 'compact' },
        { key: 'currentBalance', label: '余额', kind: 'numeric', widthPreset: 'compact' },
        { key: '平均成本', label: '平均成本', kind: 'numeric', widthPreset: 'standard' },
        { key: '加卡记录', label: '加卡记录', kind: 'text', widthPreset: 'standard' },
        { key: '余额流水', label: '余额流水', kind: 'text', widthPreset: 'standard' },
        { key: '最近加卡', label: '最近加卡', kind: 'date', widthPreset: 'dateTime' },
        { key: 'updatedAt', label: '更新时间', kind: 'date', widthPreset: 'dateTime' },
        { key: '当前业务', label: '当前业务', kind: 'text', widthPreset: 'identifier' },
        { key: 'ID 状态', label: 'ID 状态', kind: 'status', widthPreset: 'compact' },
        { key: 'actions', label: '操作', kind: 'actions', layout: 'single', pin: 'end' }
      ]
    }),
    sold: table({
      id: 'topup-workbench.sold',
      feature: 'topup-workbench',
      role: 'primary',
      mobileMode: 'cards',
      rowKey: { kind: 'path', value: 'id' },
      columns: [
        {
          key: 'appleId',
          label: 'ID 账号',
          kind: 'identifier',
          widthPreset: 'identifier',
          pin: 'start'
        },
        { key: '销售订单', label: '销售订单', kind: 'identifier', widthPreset: 'identifier' },
        { key: '归属客户', label: '归属客户', kind: 'text', widthPreset: 'standard' },
        { key: '国家', label: '国家', kind: 'text', widthPreset: 'compact' },
        { key: 'currentBalance', label: '余额', kind: 'numeric', widthPreset: 'compact' },
        { key: '平均成本', label: '平均成本', kind: 'numeric', widthPreset: 'standard' },
        { key: '加卡记录', label: '加卡记录', kind: 'text', widthPreset: 'standard' },
        { key: '余额流水', label: '余额流水', kind: 'text', widthPreset: 'standard' },
        { key: '最近加卡', label: '最近加卡', kind: 'date', widthPreset: 'dateTime' },
        { key: 'updatedAt', label: '更新时间', kind: 'date', widthPreset: 'dateTime' },
        { key: '当前业务', label: '当前业务', kind: 'text', widthPreset: 'identifier' },
        { key: 'ID 状态', label: 'ID 状态', kind: 'status', widthPreset: 'compact' },
        { key: 'actions', label: '操作', kind: 'actions', layout: 'single', pin: 'end' }
      ]
    })
  }
} as const;

export const v2TablesByFeature = {
  'renewal-workbench': [v2TableSchemas.renewals.main],
  'order-entry': [],
  'topup-workbench': [v2TableSchemas.topups.available, v2TableSchemas.topups.sold],
  accounts: [v2TableSchemas.accounts.main, v2TableSchemas.accounts.importErrors],
  orders: [v2TableSchemas.orders.main],
  customers: [v2TableSchemas.customers.main],
  'topup-records': [
    v2TableSchemas.topupRecords.giftCards,
    v2TableSchemas.topupRecords.balanceLedger,
    v2TableSchemas.topupRecords.supplierFunds,
    v2TableSchemas.topupRecords.supplierPayments,
    v2TableSchemas.topupRecords.supplierFundDetails
  ],
  'account-losses': [v2TableSchemas.accountLosses.main],
  'activation-records': [v2TableSchemas.activations.main],
  'exchange-rates': [
    v2TableSchemas.exchangeRates.purchaseQuotes,
    v2TableSchemas.exchangeRates.snapshots,
    v2TableSchemas.exchangeRates.manualChanges,
    v2TableSchemas.exchangeRates.offers
  ],
  options: [v2TableSchemas.options.main],
  dashboard: [v2TableSchemas.dashboard.activity],
  analytics: [
    v2TableSchemas.dataAnalytics.settlementPlatforms,
    v2TableSchemas.dataAnalytics.currencies,
    v2TableSchemas.dataAnalytics.supplierWallets,
    v2TableSchemas.dataAnalytics.journals
  ],
  'finance-ledger': [
    v2TableSchemas.financeLedger.accounts,
    v2TableSchemas.financeLedger.supplierWallets,
    v2TableSchemas.financeLedger.inflows,
    v2TableSchemas.financeLedger.expenses,
    v2TableSchemas.financeLedger.journals,
    v2TableSchemas.financeLedger.periods
  ],
  'finance-expenses': [v2TableSchemas.financeLedger.inflows, v2TableSchemas.financeLedger.expenses],
  'data-governance': [
    v2TableSchemas.dataGovernance.recycle,
    v2TableSchemas.dataGovernance.jobs,
    v2TableSchemas.dataGovernance.items,
    v2TableSchemas.dataGovernance.checkpoints
  ],
  'business-monitoring': [v2TableSchemas.businessMonitoring.main],
  'system-monitoring': [],
  branding: [],
  employees: [v2TableSchemas.employees.main],
  roles: [v2TableSchemas.roles.main],
  'audit-logs': [v2TableSchemas.auditLogs.operations, v2TableSchemas.auditLogs.sensitiveAccess],
  security: [
    v2TableSchemas.security.loginLogs,
    v2TableSchemas.security.sessions,
    v2TableSchemas.security.mfaUsers,
    v2TableSchemas.security.whitelist
  ],
  profile: [v2TableSchemas.profile.sessions]
} as const;

export const allV2TableSchemas = Object.values(v2TablesByFeature).flat();
