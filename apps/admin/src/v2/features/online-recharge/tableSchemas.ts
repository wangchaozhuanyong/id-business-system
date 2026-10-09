import { defineV2TableSchema, type V2TableDataColumnDefinition } from '@/v2/components/tableSystem';
import type { OnlineSection } from './contracts';
type Column = [key: string, label: string, kind?: V2TableDataColumnDefinition['kind']];
const columns: Partial<Record<OnlineSection, Column[]>> = {
  cards: [
    ['last4', '卡尾号', 'identifier'],
    ['expiryMonth', '有效月', 'numeric'],
    ['expiryYear', '有效年', 'numeric'],
    ['holderName', '持卡人'],
    ['status', '状态', 'status'],
    ['successCount', '成功订阅数', 'numeric'],
    ['declineCount', '明确拒付数', 'numeric'],
    ['addressId', '关联地址', 'identifier'],
    ['hasCvc', '临时安全码', 'status'],
    ['updatedAt', '更新时间', 'date']
  ],
  proxies: [
    ['displayHost', '代理地址', 'identifier'],
    ['protocol', '代理协议'],
    ['status', '状态', 'status'],
    ['country', '国家'],
    ['exitIp', '出口地址', 'identifier'],
    ['latencyMs', '延迟（毫秒）', 'numeric'],
    ['testMessage', '检测结果'],
    ['testedAt', '检测时间', 'date']
  ],
  addresses: [
    ['region', '资源池地区', 'status'],
    ['street', '街道'],
    ['firstName', '名字'],
    ['lastName', '姓氏'],
    ['city', '城市'],
    ['state', '州／省'],
    ['postalCode', '邮编', 'identifier'],
    ['country', '国家'],
    ['successCount', '绑定次数', 'numeric']
  ],
  cdks: [
    ['code', '兑换码', 'identifier'],
    ['plan', '套餐', 'status'],
    ['status', '状态', 'status'],
    ['dispatched', '出库状态', 'status'],
    ['taskId', '关联任务', 'identifier'],
    ['createdAt', '创建时间', 'date']
  ],
  jobs: [
    ['id', '任务编号', 'identifier'],
    ['email', '账号', 'identifier'],
    ['plan', '套餐', 'status'],
    ['provider', '通道', 'status'],
    ['status', '状态', 'status'],
    ['progress', '进度', 'numeric'],
    ['stage', '当前阶段'],
    ['cardLast4', '卡尾号', 'identifier'],
    ['createdAt', '创建时间', 'date']
  ],
  automation: [
    ['id', '任务编号', 'identifier'],
    ['email', '账号', 'identifier'],
    ['provider', '通道', 'status'],
    ['status', '状态', 'status'],
    ['progress', '进度', 'numeric'],
    ['stage', '当前阶段'],
    ['message', '执行消息'],
    ['updatedAt', '更新时间', 'date']
  ],
  sessions: [
    ['id', '任务编号', 'identifier'],
    ['email', '账号', 'identifier'],
    ['plan', '套餐', 'status'],
    ['status', '任务状态', 'status'],
    ['sessionMasked', '会话预览', 'identifier'],
    ['createdAt', '创建时间', 'date']
  ],
  renewal: [
    ['id', '任务编号', 'identifier'],
    ['email', '账号', 'identifier'],
    ['plan', '套餐', 'status'],
    ['subscriptionStatus', '订阅状态', 'status'],
    ['autoRenew', '自动续费', 'status'],
    ['expiresAt', '到期时间', 'date'],
    ['updatedAt', '更新时间', 'date']
  ],
  billing: [
    ['id', '账单编号', 'identifier'],
    ['taskId', '任务编号', 'identifier'],
    ['email', '账号', 'identifier'],
    ['cardLast4', '卡尾号', 'identifier'],
    ['plan', '套餐', 'status'],
    ['amount', '实际金额', 'numeric'],
    ['currency', '币种'],
    ['status', '状态', 'status'],
    ['createdAt', '记录时间', 'date']
  ],
  'browser-pool': [
    ['id', '槽位编号', 'identifier'],
    ['mode', '运行模式', 'status'],
    ['status', '连接状态', 'status'],
    ['taskId', '当前任务', 'identifier'],
    ['updatedAt', '更新时间', 'date']
  ],
  'runtime-logs': [
    ['createdAt', '记录时间', 'date'],
    ['taskId', '任务编号', 'identifier'],
    ['level', '级别', 'status'],
    ['stage', '阶段'],
    ['message', '日志内容']
  ],
  'login-logs': [
    ['createdAt', '记录时间', 'date'],
    ['userName', '操作人'],
    ['event', '安全事件'],
    ['ipMasked', '来源地址', 'identifier'],
    ['status', '结果', 'status']
  ]
};
export const onlineTableSchemas = Object.fromEntries(
  Object.entries(columns).map(([section, definitions]) => [
    section,
    defineV2TableSchema({
      id: `online-recharge-${section}.main`,
      feature: `online-recharge-${section}`,
      role: 'primary',
      mobileMode: 'scroll',
      rowKey: { kind: 'path', value: 'id' },
      columns: [
        ...(section === 'cdks'
          ? [
              {
                key: 'selection',
                label: '选择',
                kind: 'control' as const,
                control: 'selection' as const,
                width: 46 as const,
                pin: 'start' as const
              }
            ]
          : []),
        ...definitions.map(([key, label, kind = 'text'], index) => ({
          key,
          label,
          kind,
          widthPreset:
            kind === 'date'
              ? ('dateTime' as const)
              : kind === 'numeric' || kind === 'status'
                ? ('standard' as const)
                : key === 'message' || key === 'street'
                  ? ('longText' as const)
                  : ('wide' as const),
          ...(index === 0 ? { pin: 'start' as const } : {})
        })),
        { key: 'actions', label: '操作', kind: 'actions', layout: 'double', pin: 'end' }
      ]
    })
  ])
) as unknown as Record<OnlineSection, ReturnType<typeof defineV2TableSchema>>;
export const onlineTablesByFeature = {
  'online-recharge-overview': [],
  'online-recharge-config': [],
  'online-recharge-checkout-debug': [],
  'online-recharge-proxies': [onlineTableSchemas.proxies],
  'online-recharge-browser-pool': [onlineTableSchemas['browser-pool']],
  'online-recharge-addresses': [onlineTableSchemas.addresses],
  'online-recharge-cards': [onlineTableSchemas.cards],
  'online-recharge-cdks': [onlineTableSchemas.cdks],
  'online-recharge-sessions': [onlineTableSchemas.sessions],
  'online-recharge-renewal': [onlineTableSchemas.renewal],
  'online-recharge-jobs': [onlineTableSchemas.jobs],
  'online-recharge-automation': [onlineTableSchemas.automation],
  'online-recharge-billing': [onlineTableSchemas.billing],
  'online-recharge-runtime-logs': [onlineTableSchemas['runtime-logs']],
  'online-recharge-login-logs': [onlineTableSchemas['login-logs']]
} as const;
