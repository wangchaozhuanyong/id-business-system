import type { OnlineAction, OnlineField, OnlineQuery, OnlineRow, OnlineSection } from './contracts';
import { planHelp, planOptions } from './labels';
import { sharedCardPlanOptions } from './shared-card-plans';
const allowedPlans: OnlineField = {
  key: 'allowedPlans',
  label: '适用套餐',
  type: 'select',
  multiple: true,
  options: sharedCardPlanOptions,
  initial: sharedCardPlanOptions.map((option) => option.value),
  required: true,
  help: '两种充值共用此限制；手选和智能分配都只能使用勾选套餐的银行卡。'
};
const plan: OnlineField = {
  key: 'plan',
  label: '套餐',
  type: 'select',
  options: planOptions,
  initial: 'plus',
  required: true,
  help: planHelp
};
const count: OnlineField = {
  key: 'count',
  label: '数量',
  type: 'number',
  min: 1,
  max: 500,
  initial: 10,
  required: true
};
const session: OnlineField = {
  key: 'session',
  label: '会话资料',
  type: 'textarea',
  required: true,
  transient: true,
  help: '填写完整的 Session JSON；只提交给对应任务。'
};
const reason: OnlineField = { key: 'reason', label: '查看原因', required: true };
const status: OnlineField = {
  key: 'status',
  label: '状态',
  type: 'select',
  options: [
    { value: 'active', label: '可用' },
    { value: 'disabled', label: '停用' }
  ],
  initial: 'active'
};
const addressFields: OnlineField[] = [
  { key: 'firstName', label: '名字' },
  { key: 'lastName', label: '姓氏' },
  {
    key: 'country',
    label: '国家',
    initial: 'US',
    required: true
  },
  { key: 'street', label: '街道', required: true },
  { key: 'city', label: '城市', required: true },
  { key: 'state', label: '州／省', required: true },
  { key: 'postalCode', label: '邮编', required: true }
];
export const sectionTitles: Record<OnlineSection, string> = {
  overview: '概览中心',
  config: '系统配置',
  proxies: '代理池',
  'browser-pool': '浏览器池',
  addresses: '免税地址',
  'checkout-debug': '支付链接调试',
  cards: '银行卡共享池',
  cdks: '兑换码管理',
  sessions: 'Session 管理',
  renewal: '续费管理',
  jobs: '任务管理',
  automation: '自动化任务',
  billing: '账单记录',
  'runtime-logs': '运行日志',
  'login-logs': '登录日志'
};
export const sectionDescriptions: Record<OnlineSection, string> = {
  overview: '查看线上代充任务、独立资源和执行器运行状态。',
  config: '保存原软件的执行、地区、供应商、通知和验证码配置。',
  proxies: '管理线上代充独立代理池，检测连通性并调整可用状态。',
  'browser-pool':
    '查看最近一次检测的浏览器槽位快照、连接状态和独立／池化运行模式；需要时重新检测。',
  addresses: '管理银行卡关联的免税地址，生成美国地址并清理未绑定记录。',
  'checkout-debug': '使用原套餐和地区生成支付链接，执行在付款前停止。',
  cards:
    '比特浏览器充值与线上代充共用，按适用套餐匹配；安全码仅在执行器内存临时保留，最长24小时，任务结束、失去租约或重启后提前清除。',
  cdks: '生成、导入、出库和查询兑换码；已被任务占用的兑换码受保护。',
  sessions:
    '使用最新会话资料单独查询订阅，不提交充值或付款；查看已保存会话需要填写原因并记录审计。',
  renewal: '查询订阅到期和续费状态，按原逻辑取消或恢复自动续费。',
  jobs: '按目标套餐自动识别首次开通或升级，查看进度、官网应付、原单核对及执行文件。',
  automation: '查看实际自动化任务及执行阶段；待核对任务不能重复发起付款。',
  billing: '查看独立线上代充账单，筛选金额、币种和卡片消费并导出。',
  'runtime-logs': '查看完整业务日志和错误详情；截图与录像请在对应任务中查看。',
  'login-logs': '使用现有用户系统的安全日志，查看线上代充权限相关事件。'
};
const remove: OnlineAction = {
  key: 'delete',
  label: '删除',
  danger: true,
  confirm: '确认删除此记录？运行中或待核对的关联资料由服务端保护。'
};
const detail: OnlineAction = { key: 'detail', label: '查看详情' };
const taskTop: OnlineAction[] = [
  {
    key: 'start',
    label: '管理员代提交',
    fields: [
      session,
      plan,
      {
        key: 'cardId',
        label: '银行卡',
        type: 'card-select',
        help: '留空时智能分配对应套餐的可用银行卡；使用兑换码时须与兑换码套餐一致。'
      },
      {
        key: 'paymentLimitCurrency',
        label: '限额币种',
        type: 'select',
        options: [
          { value: '', label: '不设置单次限额' },
          { value: 'PHP', label: '菲律宾比索（PHP）' },
          { value: 'CLP', label: '智利比索（CLP）' },
          { value: 'USD', label: '美元（USD）' }
        ]
      },
      {
        key: 'paymentLimitAmount',
        label: '付款上限',
        help: '可选，与限额币种一起填写。超过上限或官网币种不一致时停止付款。'
      },
      { key: 'code', label: '兑换码' }
    ]
  }
];
export const topActions: Partial<Record<OnlineSection, readonly OnlineAction[]>> = {
  cards: [
    {
      key: 'create',
      label: '添加银行卡',
      fields: [
        { key: 'number', label: '卡号', type: 'secret', transient: true, required: true },
        {
          key: 'expiryMonth',
          label: '有效月份',
          type: 'number',
          min: 1,
          max: 12,
          initial: 1,
          required: true
        },
        {
          key: 'expiryYear',
          label: '有效年份',
          type: 'number',
          min: 2000,
          max: 9999,
          initial: new Date().getFullYear(),
          required: true
        },
        { key: 'holderName', label: '账单姓名' },
        {
          key: 'cvc',
          label: '临时安全码',
          type: 'secret',
          transient: true,
          help: '仅线上代充执行器内存临时使用，最长24小时；任务结束、失去租约或重启后提前清除。比特浏览器充值仍逐笔输入。'
        },
        allowedPlans
      ]
    },
    {
      key: 'import',
      label: '导入银行卡',
      fields: [
        {
          key: 'text',
          label: '银行卡资料',
          type: 'textarea',
          required: true,
          transient: true,
          help: '每行：卡号|月/年|安全码|持卡人。安全码不保存；单次最多 500 条。'
        },
        allowedPlans
      ]
    }
  ],
  proxies: [
    {
      key: 'import',
      label: '导入代理',
      fields: [
        {
          key: 'text',
          label: '代理列表',
          type: 'textarea',
          required: true,
          transient: true,
          help: '每行一条，支持 HTTP／SOCKS5 直连、主机:端口:用户名:密码四段网关或 IPDEEP 动态提取链接；提取链接每任务读取一次。'
        }
      ]
    }
  ],
  addresses: [
    { key: 'create', label: '新增地址', fields: addressFields },
    { key: 'generate', label: '生成美国地址', fields: [{ ...count, max: 100 }] },
    {
      key: 'clear-unbound',
      label: '清理未绑定地址',
      danger: true,
      confirm: '确认清理未绑定地址？已关联银行卡的地址会保留。'
    }
  ],
  cdks: [
    {
      key: 'generate',
      label: '生成兑换码',
      fields: [
        { ...count, max: 100, help: '按原规则生成 KC- 开头的兑换码，每次最多 100 个。' },
        plan
      ]
    },
    {
      key: 'import',
      label: '导入兑换码',
      fields: [
        {
          key: 'text',
          label: '兑换码列表',
          type: 'textarea',
          required: true,
          help: '每行一个兑换码。'
        },
        plan
      ]
    },
    { key: 'copy', label: '批量复制并出库' },
    {
      key: 'batch-delete',
      label: '批量删除',
      danger: true,
      confirm: '确认删除选中的兑换码？已使用或已预约记录会保留。'
    },
    { key: 'export', label: '导出兑换码' }
  ],
  jobs: taskTop,
  automation: taskTop,
  sessions: [
    {
      key: 'subscription',
      label: '查询订阅',
      fields: [
        {
          ...session,
          help: '填写最新完整的 Session JSON，仅核验登录和订阅，不提交充值或付款；会话资料不进入页面草稿，关闭或离页后清除。'
        },
        {
          key: 'queryTransportMode',
          label: '查询诊断',
          type: 'select',
          options: [
            { value: '', label: '普通查询' },
            { value: 'transport_compare', label: '只读对照诊断' }
          ],
          help: '查询失败时可对照同一代理下的读取结果；诊断不付款，也不会代替本次订阅核验。'
        }
      ]
    }
  ],
  renewal: [
    { key: 'check', label: '批量查询续费', confirm: '确认查询当前筛选范围内的订阅续费状态？' }
  ],
  'browser-pool': [
    {
      key: 'mode',
      label: '切换运行模式',
      fields: [
        {
          key: 'mode',
          label: '运行模式',
          type: 'select',
          required: true,
          initial: 'pool',
          options: [
            { value: 'standalone', label: '独立模式' },
            { value: 'pool', label: '池化模式' }
          ]
        }
      ]
    },
    { key: 'test', label: '检测浏览器' },
    {
      key: 'reload',
      label: '重载浏览器池',
      confirm: '确认重载空闲浏览器槽位？执行中的任务会受保护。'
    }
  ],
  billing: [
    { key: 'export', label: '导出账单' },
    {
      key: 'clear-failed',
      label: '清理失败记录',
      danger: true,
      confirm: '确认清理明确失败的账单记录？待核对或已付款记录会保留。'
    }
  ],
  'runtime-logs': [
    { key: 'export', label: '导出日志' },
    {
      key: 'clear',
      label: '清理日志',
      danger: true,
      confirm: '确认清理历史运行日志？执行中任务的必要记录会保留。'
    }
  ]
};
export const rowActions: Partial<Record<OnlineSection, readonly OnlineAction[]>> = {
  cards: [
    { key: 'reveal', label: '复制卡号' },
    {
      key: 'cvc',
      label: '补充安全码',
      fields: [
        {
          key: 'cvc',
          label: '安全码',
          type: 'secret',
          required: true,
          transient: true,
          help: '仅在执行器内存保留，最长24小时；任务结束、失去租约或重启后提前清除。'
        }
      ]
    },
    {
      key: 'update',
      label: '编辑适用套餐',
      fields: [
        status,
        allowedPlans,
        {
          key: 'addressId',
          label: '账单地址编号',
          help: '线上代充复用此地址；留空时按支付地区分配。执行中的银行卡不能更改。'
        }
      ]
    },
    remove
  ],
  proxies: [
    { key: 'test', label: '检测连通性' },
    { key: 'update', label: '调整状态', fields: [status] },
    remove
  ],
  addresses: [{ key: 'update', label: '编辑地址', fields: addressFields }, remove],
  cdks: [
    { key: 'reveal', label: '复制兑换码' },
    { key: 'dispatch', label: '标记出库', confirm: '确认将此兑换码标记为已出库？' },
    detail,
    remove
  ],
  jobs: [
    detail,
    { key: 'artifacts', label: '截图与录像' },
    {
      key: 'recheck',
      label: '核对原单',
      confirm: '仅查询原订单和同账号订阅，不会再次提交付款；不能确认时仍保持待核对。确认核对原单？'
    },
    {
      key: 'cancel',
      label: '取消任务',
      confirm: '确认取消任务？已经提交付款的任务需要等待结果核对。'
    },
    remove
  ],
  automation: [detail, { key: 'artifacts', label: '截图与录像' }, remove],
  sessions: [
    { key: 'reveal', label: '查看会话', fields: [reason] },
    { key: 'export', label: '导出会话', fields: [reason] },
    { key: 'subscription', label: '查询订阅' }
  ],
  renewal: [
    { key: 'check', label: '查询续费' },
    {
      key: 'cancel',
      label: '取消自动续费',
      confirm: '确认取消此账号的自动续费？不会取消当前有效订阅。'
    },
    {
      key: 'enable',
      label: '恢复自动续费',
      confirm: '确认恢复此账号的自动续费？后续可能产生实际订阅扣款。'
    }
  ],
  billing: [detail, { key: 'summary', label: '卡片消费汇总' }, remove],
  'browser-pool': [{ key: 'test', label: '检测连接' }],
  'runtime-logs': [detail],
  'login-logs': [detail]
};
export function onlineActionAllowedForRow(
  section: OnlineSection,
  action: OnlineAction,
  row: OnlineRow
) {
  if (action.key === 'recheck')
    return section === 'jobs' && row.status === 'awaiting_review' && row.hasSession === true;
  return !(section === 'addresses' && action.key === 'update' && Number(row.successCount) > 0);
}
export function initialFields(fields: readonly OnlineField[] = []) {
  return Object.fromEntries(
    fields
      .filter((field) => !field.transient)
      .map((field) => [
        field.key,
        field.initial ?? (field.type === 'switch' ? false : field.type === 'number' ? 1 : '')
      ])
  );
}

export function onlineActionPayload(filters: OnlineQuery, values: Record<string, unknown>) {
  const selectedFilters = Object.fromEntries(
    Object.entries(filters).filter(([, value]) => value !== '' && value != null)
  );
  const payload = { ...selectedFilters, ...values };
  if (payload.queryTransportMode === '') delete payload.queryTransportMode;
  return payload;
}
