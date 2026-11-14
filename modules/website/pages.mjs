// Page metadata is public. The server checks access and record ownership on each request.
const workspace = (definition) => Object.freeze({
  script: 'staff-workspaces.mjs',
  sharedBusinessData: false,
  ...definition,
  roles: Object.freeze(definition.roles),
  methods: Object.freeze(definition.methods || ['GET', 'POST'])
});

const customerService = workspace({
  id: 'staff-customers', route: 'staff/customers', label: '客户服务',
  description: '查看本人负责的客户和订单，录入新客户或提交续费申请。',
  navigation: '快速操作', after: 'workspace/recharge', roles: ['employee'],
  resource: 'staff/customer-service', scope: 'commerce'
});
const team = workspace({
  id: 'staff-team', route: 'staff/team', label: '小组工作',
  description: '查看直接分配到本组的员工及其订单、客户数量。',
  navigation: '管理快捷', after: 'recharge/start', roles: ['supervisor'],
  resource: 'staff/team', scope: 'renewal-handoffs', methods: ['GET']
});
const businessProxies = workspace({
  id: 'staff-business-proxies', route: 'staff/business-proxies', label: '业务 IP',
  description: '登记比特执行 IP 或自动代充代理。网站登录网络由超级管理员管理。',
  navigation: '管理快捷', after: 'staff/team', roles: ['supervisor'],
  resource: 'staff/business-proxies', scope: 'bitbrowser-proxies'
});
const registration = workspace({
  id: 'staff-registration', route: 'staff/registration', label: '注册工作台',
  description: '登记邮箱和平台账号，获取本账号录入邮箱的邮件验证码。',
  navigation: '邮箱管理', before: 'staff/authenticator', roles: ['registrar'],
  resource: 'staff/registration', scope: 'inventory'
});
export const financeCards = workspace({
  id: 'staff-finance-cards', route: 'staff/finance/cards', label: '自动代充银行卡',
  description: '与 ChatGPT 充值中的银行卡池共用资料。可导入银行卡、配置允许套餐或停用；影响取卡的操作须完成安全确认。',
  navigation: '线上代充', before: 'online-recharge/chatgpt', roles: ['finance', 'super'],
  resource: 'staff/finance/cards', scope: 'recharge-card-plans'
});
export const financeReconciliation = workspace({
  id: 'finance-reconciliation',
  route: 'staff/finance/reconciliation',
  label: '代充对账',
  description: '按北京时间查询系统记录的扣款账单，结合银行流水人工核对。扣款成功表示付款结果；订单成本和实收可在订单统计查看。',
  navigation: '线上代充',
  after: 'staff/finance/cards',
  roles: financeCards.roles,
  resource: 'staff/finance/reconciliation',
  scope: 'recharge-billing',
  methods: ['GET'],
  script: 'finance-reconciliation.mjs'
});

export const websitePages = Object.freeze([
  customerService, team, businessProxies, registration, financeCards, financeReconciliation
]);
