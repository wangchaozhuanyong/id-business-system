/* 独立离线设计原型：仅虚构内存数据；不连接 API、不读取真实资料、不执行充值。 */
'use strict';

window.IDDesignModules = [];

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value = '') =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]
  );
const icons = {
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  chart: '<path d="M4 3v17h17M8 15v-4M13 15V6M18 15V9"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  work: '<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V4h8v3M3 12h18M10 12v3h4v-3"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',
  users:
    '<circle cx="9" cy="8" r="3"/><path d="M3 21v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M17 15a5 5 0 0 1 4 5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  orders: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7h6M9 11h6M9 15h4"/>',
  bolt: '<path d="m13 2-9 12h7l-1 8 10-13h-7z"/>',
  database:
    '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
  monitor:
    '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4M7 11h3l2-4 2 6 2-2h2"/>',
  settings:
    '<path d="m9 3-1 3-3 1 1 3-2 2 2 2-1 3 3 1 1 3h6l1-3 3-1-1-3 2-2-2-2 1-3-3-1-1-3z"/><circle cx="12" cy="12" r="3"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5"/>',
  download: '<path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  columns: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/>',
  moon: '<path d="M20.5 14a9 9 0 0 1-10.5-10.5A9 9 0 1 0 20.5 14z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/>',
  card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/>',
  link: '<path d="m10 13 4-4m-6 7-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 0 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(2 -1)"/>',
  key: '<circle cx="8" cy="8" r="5"/><path d="m12 12 9 9m-3-3 3-3m-6 0 3-3"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  return: '<path d="m9 5-6 6 6 6M3 11h11a6 6 0 0 1 6 6v2"/>',
  play: '<path d="m8 4 12 8-12 8z"/>',
  external: '<path d="M13 5h6v6m0-6-9 9M10 5H5v14h14v-5"/>',
  chat: '<path d="M21 15a3 3 0 0 1-3 3H9l-6 4V5a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3z"/><path d="M7 7h10M7 12h7"/>'
};
function icon(name, extraClass = '') {
  return `<svg class="icon ${extraClass}" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.grid}</svg>`;
}
function button(label, action, kind = '', iconName = '', attributes = '') {
  return `<button class="button ${kind}" type="button" data-action="${action}" ${attributes}>${iconName ? icon(iconName) : ''}${escapeHtml(label)}</button>`;
}
function tag(label, kind = '') {
  return `<span class="tag ${kind}">${escapeHtml(label)}</span>`;
}
function textAction(label, action, attributes = '', kind = '', iconName = '') {
  return `<button type="button" class="text-button ${kind}" data-action="${action}" ${attributes}>${escapeHtml(label)}${iconName ? icon(iconName) : ''}</button>`;
}
let activeActionMenu = null;
let actionMenuSequence = 0;
const actionMenuInvokers = new WeakMap();
function closeActionMenu(restoreFocus = false) {
  const current = activeActionMenu;
  if (!current) return;
  activeActionMenu = null;
  window.removeEventListener('resize', current.position);
  window.removeEventListener('scroll', current.position, true);
  if (current.menu.matches(':popover-open')) current.menu.hidePopover();
  current.menu.remove();
  current.anchor.setAttribute('aria-expanded', 'false');
  current.anchor.removeAttribute('aria-controls');
  if (restoreFocus && current.anchor.isConnected) current.anchor.focus({ preventScroll: true });
}
function openActionMenu(anchor, actions, { label = '更多操作', onSelect } = {}) {
  anchor = actionMenuInvokers.get(anchor) || anchor;
  const toggle = activeActionMenu?.anchor === anchor;
  closeActionMenu();
  if (toggle || !anchor?.isConnected) return;
  const menu = document.createElement('div');
  menu.id = `row-action-menu-${++actionMenuSequence}`;
  menu.className = 'row-action-menu';
  menu.setAttribute('popover', 'auto');
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', label);
  menu.innerHTML = actions;
  // 复用原操作按钮及禁用条件，去掉中转面板的分组和说明。
  menu.replaceChildren(...$$('button[data-action]', menu));
  for (const button of $$('button', menu)) {
    actionMenuInvokers.set(button, anchor);
    button.setAttribute('role', 'menuitem');
    button.tabIndex = -1;
  }
  const position = () => {
    if (!anchor.isConnected || !anchor.checkVisibility()) return closeActionMenu();
    const trigger = anchor.getBoundingClientRect();
    const viewport = anchor.closest('.table-viewport, [data-pagination-rows]')?.getBoundingClientRect();
    if (viewport && (trigger.bottom <= viewport.top || trigger.top >= viewport.bottom ||
        trigger.right <= viewport.left || trigger.left >= viewport.right)) return closeActionMenu();
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(12, Math.min(trigger.right - bounds.width, innerWidth - bounds.width - 12))}px`;
    const below = trigger.bottom + 6;
    menu.style.top = `${below + bounds.height <= innerHeight - 12 ? below : Math.max(12, trigger.top - bounds.height - 6)}px`;
  };
  activeActionMenu = { anchor, menu, position };
  anchor.setAttribute('aria-haspopup', 'menu');
  anchor.setAttribute('aria-expanded', 'true');
  anchor.setAttribute('aria-controls', menu.id);
  (anchor.closest('dialog') || document.body).append(menu);
  menu.addEventListener('toggle', event => {
    if (event.newState === 'closed' && activeActionMenu?.menu === menu) closeActionMenu();
  });
  menu.addEventListener('click', event => {
    const choice = event.target.closest('button:not(:disabled)');
    if (!choice) return;
    closeActionMenu();
    if (onSelect) {
      event.stopPropagation();
      onSelect(choice);
    }
  });
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault();
      closeActionMenu(true);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = $$('button:not(:disabled)', menu);
    const index = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus({ preventScroll: true });
  });
  menu.showPopover();
  position();
  window.addEventListener('resize', position);
  window.addEventListener('scroll', position, { capture: true, passive: true });
  $('button:not(:disabled)', menu)?.focus({ preventScroll: true });
}
function options(values, selected) {
  return values
    .map((value) => {
      const [id, label] = Array.isArray(value) ? value : [value, value];
      return `<option value="${escapeHtml(id)}" ${String(id) === String(selected) ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    })
    .join('');
}
function field(label, name, control, required = false, help = '') {
  control = control.replace(
    /(<label class="checkbox-label"[^>]*>\s*<input\b[^>]*>)([\s\S]*?)(<\/label>)/g,
    (match, start, text, end) =>
      /^\s*<span\b/.test(text) ? match : `${start}<span>${text}</span>${end}`
  );
  const labelText = String(label);
  const labelHtml = required
    ? `${escapeHtml(labelText.slice(0, -1))}<span class="field-label-end">${escapeHtml(labelText.slice(-1))}<span class="required">*</span></span>`
    : escapeHtml(labelText);
  const helpHtml = titleInfo(labelText, help, `${name}-help`, true)
    .replace('class="title-help"', 'class="title-help field-title-help"');
  return `<div class="field"><label for="${name}">${labelHtml}</label>${helpHtml}<div class="field-control">${control}<div class="field-error" id="${name}-error" hidden></div></div></div>`;
}
function input(name, value = '', attributes = '') {
  return `<input id="${name}" name="${name}" value="${escapeHtml(value)}" ${attributes} />`;
}
function select(name, values, selected = '') {
  return `<select id="${name}" name="${name}">${options(values, selected)}</select>`;
}

const gptOrderSyncRoute = 'orders/gpt/recharge-sync';
const navigation = [
  ['网站总览', 'grid', [['网站总览', 'overview']]],
  [
    '快速操作',
    'work',
    [
      ['GPT 提交订单', 'workspace/order/gpt'],
      ['Claude 提交订单', 'workspace/order/claude'],
      ['Gemini 提交订单', 'workspace/order/gemini'],
      ['Grok 提交订单', 'workspace/order/grok'],
      ['续费管理', 'workspace/renewals'],
      ['客户录入', 'customers/new'],
      ['充值码提取', 'workspace/recharge-codes'],
      ['订单补全', 'workspace/order-completion'],
      ['兑换开通', 'workspace/recharge']
    ]
  ],
  [
    '管理快捷',
    'bolt',
    [
      ['账号提取', 'workspace/account-extract'],
      ['邮箱提取', 'workspace/mail-extract'],
      ['提取与归还', 'workspace/extractions'],
      ['比特登录', 'recharge/start']
    ]
  ],
  [
    '邮箱管理',
    'mail',
    [
      ['谷歌邮箱', 'mailboxes/google'],
      ['苹果隐藏邮箱', 'mailboxes/relay'],
      ['微软邮箱', 'mailboxes/microsoft']
    ]
  ],
  [
    '账号管理',
    'key',
    [
      ['GPT 账号', 'accounts/gpt'],
      ['Claude 账号', 'accounts/claude'],
      ['苹果 ID 余额', 'accounts/apple-balances'],
      ['Gemini 账号', 'accounts/gemini'],
      ['Grok 账号', 'accounts/grok']
    ]
  ],
  [
    '客户资料',
    'users',
    [
      ['客户数据', 'customers/list'],
      ['租户数据', 'customers/tenants']
    ]
  ],
  [
    '订单管理',
    'orders',
    [
      ['GPT 订单', 'orders/gpt'],
      ['Claude Pro 订单', 'orders/pro'],
      ['Claude Max 订单', 'orders/max'],
      ['Claude 专属', 'orders/exclusive'],
      ['Gemini 订单', 'orders/gemini'],
      ['Grok 订单', 'orders/grok']
    ]
  ],
  ['订阅管理', 'orders', [
    ['GPT 订阅管理', 'subscriptions/gpt'],
    ['Claude 订阅管理', 'subscriptions/claude'],
    ['Gemini 订阅管理', 'subscriptions/gemini'],
    ['Grok 订阅管理', 'subscriptions/grok']
  ]],
  [
    '线上代充',
    'card',
    [
      ['ChatGPT 充值', 'online-recharge/chatgpt'],
      ['Claude 充值', 'online-recharge/claude', true]
    ]
  ],
  ['数据管理', 'database', [
    ['订单统计', 'orders/statistics'],
    ['银行卡管理', 'data-management/bank-cards'],
    ['客户流失', 'workspace/customer-loss'],
    ['员工数据统计', 'data-management/employee-statistics']
  ]],
  ['数据中心', 'database', [['数据中心', 'data', true]]],
  ['插件管理', 'grid', [
    ['邮箱查询与邮箱池', 'plugins/mailboxes'],
    ['网站监控', 'plugins/websites'],
    ['谷歌表格同步', 'plugins/sheets']
  ]],
  ['监控中心', 'monitor', [['监控中心', 'monitor', true]]],
  [
    '系统设置',
    'settings',
    [
      ['员工与权限', 'settings/accounts'],
      ['邮箱分类', 'settings/mail-types'],
      ['费用规则', 'settings/costs'],
      ['代付国家', 'settings/payment-countries'],
      ['汇率采集', 'settings/exchange-rates'],
      ['登录日志', 'settings/login-logs'],
      ['监控与通知', 'settings/monitoring'],
      ['操作记录', 'settings/audit']
    ]
  ]
];
const mailTypes = [
  ['google', '谷歌邮箱'],
  ['apple', '苹果 ID'],
  ['relay', '苹果隐藏邮箱']
];
const accountTypes = [
  ['gpt', 'GPT 账号'],
  ['claude', 'Claude 账号']
];
const state = {
  route: '',
  actor: window.IDLocalData?.actor?.() || { id: 'demo-lin', name: '林管理员', role: 'admin' },
  previewMode: 'normal',
  mailTab: 'available',
  claudeTab: 'active',
  page: 1,
  query: '',
  country: '',
  status: '',
  pageSize: window.IDPagination.defaultPageSize,
  collapsed: false,
  expanded: new Set(['快速操作', '邮箱管理']),
  selections: new Map(),
  columns: new Map(),
  drafts: new Map(),
  mailUndo: new Map(),
  extractionIds: [],
  extractionByKind: { mail: [], account: [] },
  viewDrafts: new Map(),
  extractionKind: 'mail',
  batches: [],
  extractionDraft: { type: 'google', quantity: '3', purpose: '注册 Claude', notes: '' },
  tasks: [],
  rentals: [],
  demoOrders: [],
  toolsTab: '个人工具',
  personalToolQuery: '',
  tool: '',
  drawerContext: ''
};
const mailboxes = Array.from({ length: 32 }, (_, index) => ({
  id: `mail-${index + 1}`,
  type: index < 20 ? 'google' : index < 26 ? 'apple' : 'relay',
  email: `${['studio', 'service', 'account', 'workspace', 'design', 'team'][index % 6]}.${String(index + 1).padStart(2, '0')}@example.test`,
  password: `Demo-Only-${String(index + 1).padStart(2, '0')}!`,
  totp: '演示密钥（无效）',
  auxiliary: 'recovery@example.test',
  phone: index % 4 === 0 ? '' : '演示电话 01',
  country: ['马来西亚', '美国', '日本', '新加坡'][index % 4],
  health: index === 17 ? 'dead' : index === 18 ? 'unlocking' : 'normal',
  used: [5, 8, 9, 14, 23].includes(index),
  status: index === 12 ? '冻结' : '正常',
  source: ['自己注册', '线上购买', '客户提供'][index % 3],
  registered: `2026-10-${String(26 - (index % 12)).padStart(2, '0')}T${index % 2 ? '10:30' : '09:20'}`,
  device: '演示设备 A',
  notes: index % 2 ? '业务备用邮箱' : '常规库存',
  notes2: '',
  appPassword: 'Demo-App-Only',
  version: 1,
  usedAt: '2026-11-03 09:10',
  purpose: '注册 GPT',
  history: []
}));
const accounts = Array.from({ length: 12 }, (_, index) => ({
  id: `gpt-${index + 1}`,
  type: index < 8 ? 'gpt' : 'claude',
  email: `account.${String(index + 1).padStart(2, '0')}@example.test`,
  password: 'Demo-Account-Only!',
  country: index % 2 ? '美国' : '马来西亚',
  used: false,
  health: 'normal',
  source: '自己注册',
  status: '正常',
  registered: '2026-10-29T09:20',
  device: '演示设备 A',
  notes: '',
  notes2: '',
  history: [],
  version: 1
}));
const subscriptions = Array.from({ length: 13 }, (_, index) => ({
  id: `claude-${index + 1}`,
  email: `claude.${String(index + 1).padStart(2, '0')}@example.test`,
  type: index % 2 ? '谷歌邮箱' : '苹果隐藏邮箱',
  plan: ['Max 5x', 'Max 20x', 'Pro'][index % 3],
  tenant: ['陈先生', '林女士', '周先生'][index % 3],
  owner: ['林负责人', '陈负责人'][index % 2],
  verifier: index % 3 ? '何认证人' : '未填写',
  kyc: index % 3 ? 'KYC 认证' : '未认证',
  phone: '演示电话 02',
  payment: index % 2 ? '苹果内购' : '银行卡',
  paymentId: index % 2 ? 'apple.demo@example.test' : '062847',
  start: '2026-10-08 14:30',
  expiry: index < 3 ? '2026-11-05 14:30' : '2026-11-07 14:30',
  status: index === 11 ? 'frozen' : index === 12 ? 'abandoned' : 'active',
  contacts:
    '演示微信：demo_customer\n演示电话：演示电话 02\nWhatsApp：演示联系方式\nTelegram：@demo_example',
  history: [{ title: '首次开通', detail: '2026-10-08 14:30 · 演示订单，套餐及资料已登记' }]
}));
const demoNow = Date.parse('2026-11-03T10:30:00+08:00');
const productPlans = {
  GPT: ['Go', 'Plus', 'Pro 5x', 'Pro 20x', 'Pro 50x'],
  'Claude Pro': ['Pro'],
  'Claude Max': ['Max 5x', 'Max 20x']
};
function accountAge(row) {
  const date = Date.parse(`${row.registered}:00+08:00`);
  return Number.isFinite(date) ? Math.max(0, Math.floor((demoNow - date) / 3600000)) : 0;
}
function canReturn(row) {
  return !state.tasks.some((task) => task.accountId === row.id);
}
const personalTools = [
  'ip购买网址',
  'ai信息网',
  'gpt拿货',
  '虚拟卡购买',
  '美国虚拟卡购买',
  '装修网站管理后台',
  '谷歌邮箱购买',
  '购物网站后台',
  '佬友',
  '苹果ID登录地址指纹浏览器登录'
].map((name, index) => ({ id: `shortcut-${index + 1}`, name, url: '' }));
const localToolbox = window.IDLocalToolbox;
localToolbox?.setDefaultShortcuts(personalTools);
const columnDefinitions = {};
const tableRecords = new Map();
let pendingConfirm = null;
const actionToast = $('#toast');
let toastTimer, toastRevision = 0, toastExpiresAt = 0, toastRemaining = 0;
function dismissFeedback() {
  clearTimeout(toastTimer);
  if (actionToast.matches(':popover-open')) actionToast.hidePopover();
  actionToast.hidden = true;
}
function positionFeedback() {
  if (actionToast.hidden) return;
  // A body-level notice is both covered and inert while a modal dialog is open.
  // Keep the live region inside the active modal, and paint it in the top layer.
  const host = $$('dialog[open]').at(-1) || document.body;
  if (actionToast.parentElement !== host) host.append(actionToast);
  if (actionToast.showPopover && !actionToast.matches(':popover-open')) {
    try { actionToast.showPopover(); } catch { /* A notice must not fail a completed operation. */ }
  }
}
function resumeFeedbackTimer() {
  clearTimeout(toastTimer);
  if (actionToast.hidden || !toastRemaining) return;
  toastExpiresAt = Date.now() + toastRemaining;
  toastTimer = setTimeout(dismissFeedback, toastRemaining);
}
function notify(message, { kind = 'info', duration } = {}) {
  const text = String(message ?? '').trim();
  if (!text) return toastRevision;
  toastRevision++;
  kind = ['success', 'error', 'warning', 'info', 'loading'].includes(kind) ? kind : 'info';
  clearTimeout(toastTimer);
  if (actionToast.matches(':popover-open')) actionToast.hidePopover();
  actionToast.dataset.kind = kind;
  actionToast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  actionToast.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
  actionToast.innerHTML = icon(kind === 'success' ? 'check' : kind === 'loading' ? 'clock' : 'info') +
    `<span data-feedback-message>${escapeHtml(text)}</span><button type="button" class="toast-dismiss" aria-label="关闭提示">${icon('close')}</button>`;
  actionToast.querySelector('button').addEventListener('click', dismissFeedback);
  actionToast.hidden = false;
  positionFeedback();
  toastRemaining = duration ?? (kind === 'loading' ? 0 : kind === 'error' || kind === 'warning' ? 8000 : 3800);
  resumeFeedbackTimer();
  if (kind === 'success' || kind === 'error') window.IDInteractionSound?.play(kind);
  return toastRevision;
}
actionToast.addEventListener('pointerenter', () => {
  clearTimeout(toastTimer);
  if (toastRemaining) toastRemaining = Math.max(1, toastExpiresAt - Date.now());
});
actionToast.addEventListener('pointerleave', resumeFeedbackTimer);
actionToast.addEventListener('focusin', () => clearTimeout(toastTimer));
actionToast.addEventListener('focusout', resumeFeedbackTimer);
for (const dialog of $$('dialog')) {
  new MutationObserver(positionFeedback).observe(dialog, { childList: true, attributes: true, attributeFilter: ['open'] });
}
const pendingActionFeedback = new WeakMap();
function beginActionFeedback(node, pending = '正在处理…') {
  const route = state.route, actorId = state.actor.id, context = state.drawerContext;
  const before = toastRevision;
  const current = () => state.route === route && state.actor.id === actorId && state.drawerContext === context;
  const disabled = node?.disabled, busy = node?.getAttribute('aria-busy');
  if (node) { node.disabled = true; node.setAttribute('aria-busy', 'true'); }
  let notice;
  const quiet = () => toastRevision === before || toastRevision === notice;
  const timer = setTimeout(() => { if (current() && quiet()) notice = notify(pending, { kind: 'loading' }); }, 350);
  const finish = () => {
    clearTimeout(timer);
    if (notice !== undefined && notice === toastRevision) dismissFeedback();
    if (node) {
      node.disabled = disabled;
      if (busy === null) node.removeAttribute('aria-busy'); else node.setAttribute('aria-busy', busy);
    }
  };
  return { current, quiet, finish };
}
async function withActionFeedback(node, operation, { pending, success, failure } = {}) {
  if (node && pendingActionFeedback.has(node)) return pendingActionFeedback.get(node);
  const feedback = beginActionFeedback(node, pending);
  const task = Promise.resolve().then(operation).then(result => {
    if (feedback.current() && feedback.quiet() && result !== undefined) {
      if (result === false && failure) notify(failure, { kind: 'error' });
      else if (result !== false && success) notify(success, { kind: 'success' });
    }
    return result;
  }, error => {
    if (!failure) throw error;
    if (feedback.current() && feedback.quiet() && error?.name !== 'AbortError') notify(error?.message || failure, { kind: 'error' });
    return false;
  }).finally(() => {
    feedback.finish();
    if (node) pendingActionFeedback.delete(node);
  });
  if (node) pendingActionFeedback.set(node, task);
  return task;
}
function completeAction(callback, message = '操作已保存') {
  const before = toastRevision;
  callback();
  if (before === toastRevision) notify(message, { kind: 'success' });
}
function getSelection(scope) {
  if (!state.selections.has(scope)) state.selections.set(scope, new Set());
  return state.selections.get(scope);
}
function setError(name, message, root = document) {
  const node = $(`#${name}-error`, root);
  if (node) {
    node.textContent = message;
    node.hidden = !message;
  }
  const control = $(`#${name}`, root);
  if (control) {
    control.setAttribute('aria-invalid', String(Boolean(message)));
    control.setAttribute('aria-describedby', `${name}-error`);
  }
}
function readForm(form) {
  return Object.fromEntries(new FormData(form).entries());
}
function readOptionList(raw) {
  let values;
  if (Array.isArray(raw)) values = raw;
  else {
    if (raw !== null && raw !== undefined && typeof raw !== 'string')
      throw new Error('项目列表格式无效');
    const text = String(raw ?? '').trim();
    values = text.startsWith('[') ? JSON.parse(text) : text.split(/[\r\n,、]+/);
  }
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string'))
    throw new Error('项目列表格式无效');
  return values.map((value) => value.trim()).filter(Boolean);
}
function optionListEditor({
  id,
  label,
  itemLabel = '项目',
  values = [],
  minItems = 1,
  choices = null,
  protectedValues = [],
  disabled = false,
  draft = {}
}) {
  const items = readOptionList(draft[id] ?? values);
  const pending = String(draft[`${id}-pending`] ?? '');
  const index = String(draft[`${id}-editing`] ?? '');
  const editing =
    /^\d+$/.test(index) &&
    Number(index) < items.length &&
    !protectedValues.includes(items[Number(index)]);
  const config = { id, label, itemLabel, minItems, choices, protectedValues, disabled };
  const available = choices?.filter(
    (value) => !items.includes(value) || (editing && value === items[Number(index)])
  );
  const control = choices
    ? `<select id="${escapeHtml(id)}-pending" name="${escapeHtml(id)}-pending" data-option-input ${disabled ? 'disabled' : ''}>${options([['', `请选择${itemLabel}`], ...available], pending)}</select>`
    : `<input id="${escapeHtml(id)}-pending" name="${escapeHtml(id)}-pending" data-option-input value="${escapeHtml(pending)}" maxlength="100" autocomplete="off" placeholder="请输入${escapeHtml(itemLabel)}" ${disabled ? 'disabled' : ''} />`;
  return `<section class="option-editor" data-option-editor data-option-config="${escapeHtml(JSON.stringify(config))}"><div class="option-editor-heading"><h3>${escapeHtml(label)}</h3><span class="footnote">已添加 ${items.length} 项</span></div><input type="hidden" id="${escapeHtml(id)}" name="${escapeHtml(id)}" value="${escapeHtml(JSON.stringify(items))}" /><input type="hidden" name="${escapeHtml(id)}-editing" value="${editing ? index : ''}" />${field(`${editing ? '编辑' : '新增'}${itemLabel}`, `${id}-pending`, `<div class="option-entry-controls">${control}${button(editing ? '保存修改' : '添加', 'option-add', 'primary', editing ? 'check' : 'plus', disabled || (choices && !available.length) ? 'disabled' : '')}</div>${editing ? `<div class="option-edit-cancel">${textAction('取消编辑', 'option-cancel')}</div>` : ''}`)}<p id="${escapeHtml(id)}-error" class="field-error" role="alert"></p><ul class="option-list">${
    items.length
      ? items
          .map((value, i) => {
            const protectedItem = protectedValues.includes(value);
            return `<li class="option-item ${editing && Number(index) === i ? 'is-editing' : ''}"><span class="option-item-value">${escapeHtml(value)}${protectedItem ? '<small class="footnote">保留项</small>' : ''}</span><div class="action-links">${textAction('编辑', 'option-edit', `data-index="${i}" aria-label="编辑${escapeHtml(itemLabel)} ${escapeHtml(value)}" ${disabled || protectedItem ? 'disabled' : ''}`)}${textAction('移除', 'option-remove', `data-index="${i}" aria-label="移除${escapeHtml(itemLabel)} ${escapeHtml(value)}" ${disabled || protectedItem || items.length <= minItems ? 'disabled' : ''}`, 'danger')}</div></li>`;
          })
          .join('')
      : '<li class="option-list-empty">尚未添加项目</li>'
  }</ul></section>`;
}
function optionListPending(form) {
  for (const editor of form.querySelectorAll('[data-option-editor]')) {
    const input = $('[data-option-input]', editor);
    const editing = $('input[name$="-editing"]', editor)?.value;
    if (input.value.trim() || (editing !== '' && editing !== undefined)) {
      input.focus();
      return true;
    }
  }
  return false;
}
function changeOptionList(action, node) {
  const editor = node.closest('[data-option-editor]');
  if (!editor) return;
  const config = JSON.parse(editor.dataset.optionConfig);
  if (config.disabled) return;
  const input = $('[data-option-input]', editor);
  const items = readOptionList($(`input[name="${config.id}"]`, editor).value);
  let pending = input.value;
  let editing = $('input[name$="-editing"]', editor).value;
  const selected = Number(node.dataset.index);
  if (action === 'option-add') {
    const value = pending.trim();
    const invalidEdit =
      editing !== '' &&
      (!/^\d+$/.test(editing) ||
        Number(editing) >= items.length ||
        config.protectedValues.includes(items[Number(editing)]));
    const error = invalidEdit
      ? '该项目不可修改，请取消编辑后重试'
      : !value
        ? `请填写${config.itemLabel}`
        : /[\r\n]/.test(value)
          ? '请一次添加一个项目'
          : config.choices && !config.choices.includes(value)
            ? '请选择已有项目'
            : items.some(
                  (item, i) => String(i) !== editing && item.toLowerCase() === value.toLowerCase()
                )
              ? '这个项目已经存在'
              : '';
    const message = $(`#${config.id}-error`, editor);
    message.textContent = error;
    input.setAttribute('aria-invalid', String(Boolean(error)));
    input.setAttribute('aria-describedby', `${config.id}-error`);
    if (error) {
      input.focus();
      return;
    }
    if (editing !== '') items[Number(editing)] = value;
    else items.push(value);
    pending = '';
    editing = '';
  } else if (action === 'option-edit') {
    if (!items[selected] || config.protectedValues.includes(items[selected])) return;
    if (pending.trim() && editing !== String(selected)) {
      notify('请先添加当前输入，或取消编辑后再选择其他项目');
      input.focus();
      return;
    }
    editing = String(selected);
    pending = items[selected];
  } else if (action === 'option-remove') {
    if (
      !items[selected] ||
      items.length <= config.minItems ||
      config.protectedValues.includes(items[selected])
    )
      return;
    items.splice(selected, 1);
    if (editing !== '') {
      if (Number(editing) === selected) {
        editing = '';
        pending = '';
      } else if (Number(editing) > selected) editing = String(Number(editing) - 1);
    }
  } else if (action === 'option-cancel') {
    editing = '';
    pending = '';
  } else return;
  editor.outerHTML = optionListEditor({
    ...config,
    values: items,
    draft: { [`${config.id}-pending`]: pending, [`${config.id}-editing`]: editing }
  });
  for (const module of window.IDDesignModules) module.preserveDraft?.();
  if (state.drawerContext) preserveDrawerDraft();
  const current = document.getElementById(`${config.id}-pending`);
  if (action !== 'option-remove') current?.focus();
}
function readDraft(form) {
  const values = readForm(form);
  for (const control of form.elements) {
    if (control.name && control.type === 'checkbox' && !control.checked)
      values[control.name] = '';
    if (
      control.hasAttribute('data-no-draft') ||
      control.autocomplete === 'one-time-code' ||
      control.type === 'file' ||
      /(?:^|-)(?:session|cvv|cvc|otp|payment-authorization)(?:$|-)/i.test(control.name)
    )
      delete values[control.name];
  }
  return values;
}
const activeRegionReads = new WeakMap();
function finishRegionRead(region) {
  activeRegionReads.get(region)?.finish();
}
function beginRegionRead(region, status, { loadingText = '', refreshButton } = {}) {
  finishRegionRead(region);
  const dialog = region.closest('dialog');
  const label = document.createElement('span');
  label.className = 'design-progress-label';
  const current = () => activeRegionReads.get(region) === read && region.isConnected &&
    (!dialog || dialog.open);
  const setLoadingText = (text) => {
    loadingText = text;
    if (current() && !status.hidden) label.textContent = text;
  };
  const finish = () => {
    clearTimeout(timer);
    if (activeRegionReads.get(region) !== read) return;
    activeRegionReads.delete(region);
    region.setAttribute('aria-busy', 'false');
    status.textContent = '';
    status.hidden = true;
    delete status.dataset.regionLoading;
    if (refreshButton) refreshButton.disabled = wasDisabled;
  };
  const wasDisabled = refreshButton?.disabled;
  const read = { region, current, setLoadingText, finish };
  activeRegionReads.set(region, read);
  region.classList.add('design-async-region');
  region.setAttribute('aria-busy', 'true');
  status.hidden = true;
  status.replaceChildren(label);
  status.dataset.regionLoading = '';
  status.className = 'design-region-progress';
  if (refreshButton) refreshButton.disabled = true;
  const timer = setTimeout(() => {
    if (!current()) return;
    label.textContent = loadingText;
    status.hidden = false;
  }, 120);
  return read;
}
function confirmAction(title, message, callback, label = '确认操作') {
  pendingConfirm = callback;
  $('#confirm-dialog').innerHTML =
    `<h2 id="confirm-title">${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p><div class="confirm-actions">${button('取消', 'confirm-cancel')}${button(label, 'confirm-accept', 'primary')}</div>`;
  $('#confirm-dialog').showModal();
}
function openDrawer(title, description, body, footer = '', context = '', layout = {}) {
  const drawer = $('#drawer');
  const tabScroll = captureTabScroll(drawer);
  if (drawer.open) {
    preserveDrawerDraft();
    drawer.dispatchEvent(new Event('id-view-deactivate'));
    drawer.close();
  }
  state.drawerContext = context;
  drawer.dataset.layout = layout.kind || '';
  drawer.dataset.tool = layout.tool || '';
  drawer.dataset.section = layout.section || '';
  const heading = layout.tabs
    ? `<h2 class="toolbox-accessible-title" id="drawer-title">${escapeHtml(title)}</h2>${layout.tabs}`
    : `<div class="drawer-title-row"><h2 id="drawer-title">${escapeHtml(title)}</h2>${titleInfo(title, description, 'drawer-description')}</div>`;
  drawer.innerHTML = `<header class="drawer-header">${heading}<button class="icon-button" data-action="drawer-close" aria-label="关闭抽屉">${icon('close')}</button></header><div class="drawer-body"${layout.tabs ? ' id="toolbox-content" role="tabpanel" aria-labelledby="toolbox-active-tab"' : ''}>${body}</div>${footer ? `<footer class="drawer-footer">${footer}</footer>` : ''}`;
  normalizeDrawerActions(drawer);
  drawer.showModal();
  restoreTabScroll(drawer, tabScroll);
}
function tabScrollKey(tabs, index) {
  return tabs.getAttribute('aria-label') || tabs.id ||
    `${tabs.querySelector('[data-action]')?.dataset.action || 'tabs'}:${index}`;
}
function captureTabScroll(root) {
  return new Map($$('.tabs', root).map((tabs, index) => [tabScrollKey(tabs, index), tabs.scrollLeft]));
}
function restoreTabScroll(root, previous = new Map()) {
  $$('.tabs', root).forEach((tabs, index) => {
    tabs.scrollLeft = previous.get(tabScrollKey(tabs, index)) || 0;
    const active = tabs.querySelector('.tab.active, [role="tab"][aria-selected="true"], [aria-current="page"]');
    if (!active) return;
    const container = tabs.getBoundingClientRect();
    const bounds = active.getBoundingClientRect();
    if (bounds.left < container.left) tabs.scrollLeft -= container.left - bounds.left;
    else if (bounds.right > container.right) tabs.scrollLeft += bounds.right - container.right;
  });
}
function normalizeDrawerActions(drawer) {
  const body = $('.drawer-body', drawer);
  if (!body) return;
  for (const item of $$('.guide-item', body)) {
    if (item.classList.contains('action-group') || $('form, table, input, select, textarea', item))
      continue;
    const heading = $(':scope > h3', item) || $(':scope > .section-title-row:has(h3)', item);
    const controls = $(':scope > .toolbar, :scope > .form-footer', item);
    if (!heading || !controls || !$('button', controls)) continue;
    const content = document.createElement('div');
    content.className = 'action-group-content';
    for (const child of [...item.childNodes]) if (child !== heading) content.append(child);
    heading.classList.add('action-group-heading');
    item.classList.add('action-group');
    item.append(content);
  }
  for (const group of $$('.guide-list', body))
    if (
      group.children.length &&
      [...group.children].every((item) => item.classList.contains('action-group'))
    )
      group.classList.add('action-menu');
  for (const controls of $$(':scope > .toolbar', body))
    if ($('button', controls) && !$('form, input, select, textarea', controls))
      controls.classList.add('drawer-action-bar');
}
function preserveDrawerDraft() {
  for (const module of window.IDDesignModules) module.preserveDraft?.();
  const form = $('form', $('#drawer'));
  if (form && state.drawerContext) state.drafts.set(state.drawerContext, readDraft(form));
}
function closeDrawer() {
  const toolEntry = $('#drawer').dataset.layout === 'workspace-tools'
    ? $$('.topbar-tools button').find((button) => button.dataset.tab === state.toolsTab) : null;
  preserveDrawerDraft();
  $('#drawer').dispatchEvent(new Event('id-view-deactivate'));
  $('#drawer').close();
  state.drawerContext = '';
  toolEntry?.focus({ preventScroll: true });
}
function dismissDrawer() {
  if ($('#drawer [data-protect-drawer-dismiss][aria-busy="true"]')) return;
  if ($('#drawer').dataset.layout === 'online-tool') {
    const tool = $('#drawer').dataset.tool;
    showTools('在线工具');
    $$('.online-tool-open', $('#drawer')).find((button) => button.dataset.name === tool)?.focus();
  } else if ($('#drawer').dataset.layout === 'personal-tool-manager') showTools('个人工具');
  else if ($('#drawer').dataset.layout === 'toolbox-phrase-detail') showTools('话术文案');
  else closeDrawer();
}
async function copyText(value, success = '内容已复制', { current = () => true } = {}) {
  if (!current()) return false;
  const text = String(value ?? '');
  if (!text) { notify('暂无可复制内容', { kind: 'warning' }); return false; }
  try {
    await withActionFeedback(null, () => navigator.clipboard.writeText(text), { pending: '正在复制…' });
    if (!current()) return false;
    notify(success, { kind: 'success' });
    return true;
  } catch {
    if (!current()) return false;
    openDrawer(
      '复制内容',
      '当前浏览器无法直接写入剪贴板，可选中下方内容复制。',
      `<textarea class="copy-block" aria-label="待复制内容" readonly>${escapeHtml(text)}</textarea>`,
      button('关闭', 'drawer-close')
    );
    const area = $('textarea', $('#drawer'));
    area.focus();
    area.select();
    notify('复制失败，请选中下方内容手动复制', { kind: 'error' });
    return false;
  }
}
function titleInfo(title, description, id, trustedHtml = false) {
  return description
    ? `<details class="title-help"><summary aria-label="查看${escapeHtml(title)}说明" aria-controls="${id}">${icon('info')}</summary><div class="title-description" id="${id}" role="note">${trustedHtml ? description : escapeHtml(description)}</div></details>`
    : '';
}
function header(title, description, actions = '', label = '') {
  return `<div class="page-header"><div class="page-heading"><h1 id="page-title-heading">${escapeHtml(title)}</h1>${titleInfo(title, [description, label].filter(Boolean).join(' · '), 'page-description')}</div><div class="page-header-actions">${actions}</div></div>`;
}
function gptOrderTabs() {
  if (!permittedRoute(gptOrderSyncRoute)) return '';
  const views = [['orders/gpt', '订单列表'], [gptOrderSyncRoute, '代充订单同步']];
  const links = views.map(([route, label]) => {
    const active = state.route === route;
    return `<a class="tab${active ? ' active' : ''}" href="#/${route}"${active ? ' aria-current="page"' : ''}>${label}</a>`;
  }).join('');
  return `<nav class="tabs" data-route-tabs aria-label="GPT 订单视图">${links}</nav>`;
}
function compactListToolbars(region) {
  const simple = /^(workspace\/(customer-loss|renewals|extractions)|customers\/(list|tenants)|orders\/(gpt|pro|max|exclusive|statistics)|settings\/(accounts|login-logs|exchange-rates))$/.test(state.route);
  const relay = state.route === 'mailboxes/relay' && ['parents', 'imports'].includes($('.panel > .tabs .tab.active', region)?.dataset.tab);
  if (state.route === 'settings/login-logs') {
    const tabs = $(':scope > .tabs', region), panel = tabs?.nextElementSibling;
    if (panel?.matches('.panel') && $(':scope > .toolbar', panel)) panel.prepend(tabs);
  }
  if (simple || relay) for (const panel of $$('.panel', region)) {
    const header = $(':scope > .tabs:not([data-route-tabs]), :scope > .content-toolbar', panel);
    const controls = header?.nextElementSibling;
    if (!controls?.matches('.toolbar')) continue;
    const tabs = header.matches('.tabs') ? header : $(':scope > .tabs', header);
    if (!tabs) continue;
    const row = document.createElement('div');
    row.className = 'list-controls';
    header.before(row);
    if (header !== tabs) {
      let right = $(':scope > .toolbar-right', controls);
      if (!right) { right = document.createElement('div'); right.className = 'toolbar-right'; controls.append(right); }
      for (const actions of $$(':scope > .page-actions', header)) right.append(...actions.childNodes);
    }
    row.append(tabs, controls);
    if (header !== tabs) header.remove();
  }
  if (/^(mailboxes\/(google|relay)|accounts\/(gpt|claude))$/.test(state.route))
    for (const controls of $$('.panel > .toolbar', region)) controls.classList.add('list-filters');
  const pool = $('#ops-mailbox-pool', region), heading = pool && $('.panel-heading', pool);
  const filters = pool && $('#ops-mailbox-pool-search-form', pool);
  if (heading && filters && !heading.closest('.list-controls')) {
    const row = document.createElement('div'); row.className = 'list-controls list-controls--filters';
    heading.before(row);
    row.append($('.section-title-row', heading), filters, $('.mailbox-pool-actions', heading));
    heading.remove();
  }
}
function mountPageContext(region = $('#main')) {
  const source = $('.page-header', region);
  const title = $('#page-title');
  title.replaceChildren();
  if (!source) { compactListToolbars(region); return; }
  title.append($('.page-heading', source));
  const actions = $('.page-header-actions', source);
  if (actions.innerHTML.trim()) {
    let target = $('[data-page-actions]', region) ||
      $('.panel > .toolbar > .toolbar-right', region) ||
      $('.panel > .tabs', region) ||
      $('.form-panel .form-footer', region);
    actions.className = 'toolbar-right page-actions';
    if (!target) {
      target = document.createElement('div');
      target.className = 'toolbar page-actions-fallback';
      ($('.panel', region) || region).append(target);
    }
    if (target.dataset.pageActions === 'tabs' || target.matches('.tabs')) {
      const row = document.createElement('div');
      row.className = 'content-toolbar';
      target.before(row);
      row.append(target, actions);
    } else if (target.dataset.pageActions === 'before-submit') {
      target.insertBefore(actions, $('[type="submit"]', target));
    } else {
      target.append(...Array.from(actions.childNodes));
      target.classList.add('page-actions-host');
    }
  }
  source.remove();
  compactListToolbars(region);
}
function summary(items) {
  return `<div class="summary-strip">${items.map(([label, count, note, accent]) => `<div class="summary-item ${accent ? 'accent' : ''}"><div class="summary-label">${escapeHtml(label)}</div><div class="summary-number">${escapeHtml(count)}<small>${escapeHtml(note || '条')}</small></div></div>`).join('')}</div>`;
}
function empty(title, description) {
  return `<div class="empty-state">${icon('database')}<h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p></div>`;
}
function table(columns, rows, scope = '', tableId = 'default', emptyState) {
  columnDefinitions[tableId] = columns;
  tableRecords.set(tableId, rows);
  const hiddenColumns = state.columns.get(tableId) || new Set();
  const visible = columns.filter(
    (column) => fixedTableColumn(column) || !hiddenColumns.has(column.id)
  );
  const emptyContent = rows.length ? '' : empty(
    emptyState?.title ?? '暂无符合条件的记录',
    emptyState?.description ??
      (window.IDLocalData ? '可调整搜索或筛选条件。' : '调整搜索和筛选条件，或新增一条演示资料。')
  );
  const check = scope
    ? `<th class="check-cell"><input type="checkbox" aria-label="选择当前页" data-select-all="${scope}" ${rows.length && rows.every((row) => getSelection(scope).has(row.id)) ? 'checked' : ''} ${rows.length ? '' : 'disabled'} /></th>`
    : '';
  const headers = visible.map((column) => {
    const label = escapeHtml(column.label);
    const help = column.headerHelp && titleInfo(column.label, column.headerHelp,
      `column-help-${encodeURIComponent(tableId)}-${encodeURIComponent(column.id)}`);
    const content = help ? `<div class="title-with-help"><span>${label}</span>${help}</div>` : label;
    return `<th class="${column.action ? 'table-actions' : ''}" scope="col"${help ? ` aria-label="${label}"` : ''}>${content}</th>`;
  }).join('');
  return `<div class="table-viewport ${['邮箱库存', '账号库存', 'Claude专属'].includes(tableId) ? 'stable-table' : ''}" tabindex="0" role="region" aria-label="${escapeHtml(tableId)}数据表，可横向滚动"><table data-table="${tableId}"><thead><tr>${check}${headers}</tr></thead><tbody>${rows.length ? rows.map((row) => `<tr data-row-id="${row.id}">${scope ? `<td class="check-cell"><input type="checkbox" aria-label="选择 ${escapeHtml(row.email || row.id)}" data-select="${scope}" data-id="${row.id}" ${getSelection(scope).has(row.id) ? 'checked' : ''} /></td>` : ''}${visible.map((column) => `<td class="${column.class || ''} ${column.action ? 'table-actions' : ''}" data-column="${column.id}">${renderTableCell(column, row, tableId)}</td>`).join('')}</tr>`).join('') : `<tr${emptyState ? ' data-table-empty-guidance' : ''}><td colspan="${visible.length + (scope ? 1 : 0)}">${emptyContent}</td></tr>`}</tbody></table></div>`;
}
function fixedTableColumn(column) {
  return column.action || ['email', 'orderNo', 'name'].includes(column.id);
}
// Long credential columns retain their explicit full-content action only.
const tableHoverColumns = new Set([
  'auxiliary', 'device', 'extractionNotes', 'importId', 'note', 'notes', 'notes2', 'orderNos',
  'reason', 'services', 'tags', 'usageEvidence'
]);
function renderTableCell(column, row, tableId) {
  const value = row[column.id];
  const content = column.render ? column.render(row) : escapeHtml(value ?? '—');
  if (!column.long || value === undefined || value === null || value === '') return content;
  const preview = tableHoverColumns.has(column.id) ? ' data-table-value-preview' : '';
  return `<button class="table-value-button" type="button" data-action="table-cell-view" data-table-id="${escapeHtml(tableId)}" data-column="${escapeHtml(column.id)}" data-row-id="${escapeHtml(row.id)}" aria-label="查看${escapeHtml(column.label)}完整内容"${preview}><span class="table-value-ellipsis">${content}</span>${icon('info')}</button>`;
}
function pagination(total, { page = state.page, pageSize = state.pageSize, disabled = false } = {}) {
  return window.IDPagination.render({ id: 'main-list', page, pageSize, total, disabled });
}
document.addEventListener('id-pagination-change', (event) => {
  const { id, page, pageSize } = event.detail;
  if (id !== 'main-list' || !activePageRegion().contains(event.target)) return;
  state.page = page;
  state.pageSize = pageSize;
  render();
});
function pageRows(rows) {
  state.page = Math.min(state.page, Math.max(1, Math.ceil(rows.length / state.pageSize)));
  return rows.slice((state.page - 1) * state.pageSize, state.page * state.pageSize);
}
function matchesNav(route, base) {
  if (route === 'workspace/order' && base === 'workspace/order/gpt') return true;
  return route === base || route.startsWith(base + '/');
}
function permittedRoute(route) {
  if (route === 'settings/monitoring' && window.IDLocalData?.authRequired) return state.actor?.role === 'super';
  if (!window.IDLocalData?.authRequired || state.actor?.role !== 'employee') return true;
  return /^(overview$|plugins\/(mailboxes|websites)$|workspace\/(recharge-codes|my-recharge-codes|order-completion)$|mailboxes\/(google|microsoft)$|accounts\/(gpt|claude|gemini|grok)$|orders\/(gpt|pro|max|exclusive|gemini|grok)$)/.test(
    route
  );
}
const designTableFrames = new Map();
function tableScrollKey(table) {
  const rows = table.tBodies[0]?.rows;
  return JSON.stringify([table.dataset.table, rows?.[0]?.dataset.rowId, rows?.[rows.length - 1]?.dataset.rowId]);
}
function stabilizeDesignTables() {
  for (const pager of $$('[data-pagination="main-list"]', activePageRegion())) {
    let viewport = pager.previousElementSibling;
    while (viewport && !viewport.classList.contains('table-viewport'))
      viewport = viewport.previousElementSibling;
    if (!viewport) continue;
    const tableId = $('table', viewport)?.dataset.table;
    const pageSize = Number(pager.dataset.pageSize);
    const key = `${tableId}:${pageSize}`;
    const rows = Math.max(
      designTableFrames.get(key) || 1,
      Math.min(Number(pager.dataset.total), pageSize)
    );
    designTableFrames.set(key, rows);
    viewport.classList.add('stable-table');
    viewport.dataset.frameRows = String(rows);
    viewport.style.setProperty('--table-page-rows', String(rows));
  }
}
function renderSidebar() {
  const previousScroll = $('.sidebar-navigation')?.scrollTop || 0;
  const allowedNavigation = navigation
    .map(([label, iconName, children]) => [
      label,
      iconName,
      children.filter((child) => permittedRoute(child[1]))
    ])
    .filter((group) => group[2].length > 0);
  const currentGroup = allowedNavigation.find((group) =>
    group[2].some((item) => matchesNav(state.route, item[1]))
  );
  const renewalCount = permittedRoute('workspace/renewals')
    ? window.IDDesignAPI.modules.commerce?.renewalReminderCount?.() || 0 : 0;
  $('#sidebar').innerHTML =
    `<a class="brand" href="#/mailboxes/google" aria-label="ID 业务管理首页"><span class="brand-mark">ID</span><span class="brand-name">业务管理系统</span></a><nav class="sidebar-navigation" tabindex="0" aria-label="业务模块导航">${allowedNavigation
      .map(([group, iconName, children]) => {
        const direct = children.length === 1;
        const active = currentGroup?.[0] === group;
        return `<div class="nav-group" data-tone="${({ mail: 'cyan', key: 'violet', users: 'teal', user: 'teal', orders: 'blue', bolt: 'violet', database: 'blue', monitor: 'teal', settings: 'blue', work: 'violet' })[iconName] || 'blue'}">${direct ? `<a class="nav-heading ${active ? 'active-direct' : ''}" href="#/${children[0][1]}" title="${group}" ${active ? 'aria-current="page"' : ''}>${icon(iconName)}<span class="nav-text">${group}</span></a>` : `<button class="nav-heading ${active ? 'active-parent' : ''}" data-action="nav-group" data-group="${group}" aria-expanded="${state.expanded.has(group)}" title="${group}">${icon(iconName)}<span class="nav-text">${group}</span>${icon(state.expanded.has(group) ? 'down' : 'chevron', 'chevron')}</button>${state.expanded.has(group) ? `<div class="nav-children">${children.map(([title, route, placeholder]) => `<a class="nav-child ${matchesNav(state.route, route) ? 'active' : ''}" href="#/${route}" ${matchesNav(state.route, route) ? 'aria-current="page"' : ''}>${title}${route === 'workspace/renewals' ? `<small id="renewal-reminder-count" aria-label="待处理提醒" ${renewalCount ? '' : 'hidden'}>${renewalCount}</small>` : placeholder ? '<small>占位</small>' : ''}</a>`).join('')}</div>` : ''}`}</div>`;
      })
      .join(
        ''
      )}</nav><div class="sidebar-bottom"><i class="dot"></i><span>${window.IDLocalData ? '独立新版 · 业务管理' : '新版页面设计 · 第一阶段'}</span></div>`;
  $('.sidebar-navigation').scrollTop = previousScroll;
  const pageTitle = $('#page-title h1')?.textContent?.trim() || '';
  $('#breadcrumbs').innerHTML =
    currentGroup && currentGroup[0] !== pageTitle
      ? `<span>${escapeHtml(currentGroup[0])}</span>${icon('chevron')}`
      : '';
}
function renderMailbox() {
  const type = state.route.split('/')[1] || 'google';
  const isAccount = state.route.startsWith('accounts/');
  const data = isAccount ? accounts : mailboxes;
  const title =
    (isAccount ? accountTypes : mailTypes).find((entry) => entry[0] === type)?.[1] || '邮箱库存';
  const all = data.filter((row) => row.type === type);
  const counts = {
    available: all.filter((row) => !row.used && row.health === 'normal').length,
    used: all.filter((row) => row.used && row.health === 'normal').length,
    dead: all.filter((row) => row.health === 'dead').length,
    unlocking: all.filter((row) => row.health === 'unlocking').length
  };
  const filtered = all.filter(
    (row) =>
      (state.mailTab === 'available'
        ? !row.used && row.health === 'normal'
        : state.mailTab === 'used'
          ? row.used && row.health === 'normal'
          : row.health === state.mailTab) &&
      (!state.query ||
        `${row.email} ${row.notes} ${row.auxiliary || ''}`
          .toLowerCase()
          .includes(state.query.toLowerCase())) &&
      (!state.country || row.country === state.country) &&
      (!state.status || row.status === state.status)
  );
  const columns = [
    {
      id: 'email',
      label: isAccount ? '账号 / 邮箱' : '邮箱账号',
      class: 'email-cell',
      render: (row) =>
        `<span class="provider-mark">${type === 'google' ? 'G' : type === 'apple' || type === 'relay' ? 'A' : isAccount && type === 'gpt' ? 'G' : 'C'}</span>${escapeHtml(row.email)}`
    },
    { id: 'password', label: isAccount ? '账号密码' : '邮箱密码', class: 'mono' },
    { id: 'country', label: '国家地区' },
    {
      id: 'status',
      label: '账号状态',
      render: (row) => tag(row.status, row.status === '正常' ? 'success' : 'warning')
    },
    { id: 'source', label: '来源渠道' },
    {
      id: 'registered',
      label: '注册时间',
      render: (row) => escapeHtml(row.registered.replace('T', ' '))
    },
    ...(type === 'claude'
      ? [
          {
            id: 'age',
            label: '养号状态',
            render: (row) =>
              tag(`${accountAge(row)} 小时`, accountAge(row) >= 72 ? 'success' : 'warning')
          },
          {
            id: 'availability',
            label: '是否可用',
            render: (row) =>
              tag(
                accountAge(row) >= 72 ? '可使用' : '养号中',
                accountAge(row) >= 72 ? 'success' : 'warning'
              )
          },
          { id: 'kyc', label: '验证状态', render: () => tag('未认证') }
        ]
      : []),
    ...(state.mailTab === 'used'
      ? [
          { id: 'purpose', label: '提取用途' },
          { id: 'usedAt', label: '提取时间' },
          { id: 'extractionNotes', label: '提取备注' }
        ]
      : []),
    { id: 'phone', label: '绑定电话' },
    { id: 'device', label: '登录设备' },
    { id: 'totp', label: '2FA 密钥', class: 'mono' },
    { id: 'auxiliary', label: '辅助邮箱' },
    { id: 'appPassword', label: '应用专用密码', class: 'mono' },
    { id: 'notes', label: '备注 1' },
    { id: 'notes2', label: '备注 2' },
    {
      id: 'actions',
      label: '操作',
      action: true,
      render: (row) =>
        `<div class="action-links">${textAction('修改', 'mail-edit', `data-id="${row.id}"`)}${textAction('复制', 'mail-copy', `data-id="${row.id}"`)}${textAction('更多操作', 'mail-more', `data-id="${row.id}" aria-haspopup="menu" aria-expanded="false"`, 'secondary', 'down')}</div>`
    }
  ];
  const tableId = isAccount ? '账号库存' : '邮箱库存';
  return (
    header(
      title,
      isAccount
        ? '集中管理账号资料、使用情况与注册记录。'
        : '管理邮箱资料与库存流转，让每一次提取都有据可查。',
      button('本表设置', 'table-settings', '', 'settings') +
        button('新增账号', 'mail-add', 'primary', 'plus').replace(
          '新增账号',
          isAccount ? '新增账号' : '新增邮箱'
        ),
      '库存管理'
    ) +
    summary([
      ['库存总数', all.length, '条资料'],
      [
        '可提取',
        all.filter((row) => !row.used && row.health === 'normal' && row.status === '正常').length,
        '条可用',
        true
      ],
      ['已使用', counts.used, '条记录'],
      ['待处理', counts.dead + counts.unlocking, '条资料']
    ]) +
    `<section class="panel"><div class="tabs" role="tablist" aria-label="库存分类">${[
      ['available', '库存'],
      ['used', '已使用'],
      ['dead', '死号'],
      ['unlocking', '解封中']
    ]
      .map(
        ([id, label]) =>
          `<button class="tab ${state.mailTab === id ? 'active' : ''}" role="tab" aria-selected="${state.mailTab === id}" data-action="mail-tab" data-tab="${id}">${label}<span class="tab-count">${counts[id]}</span></button>`
      )
      .join(
        ''
      )}</div><div class="toolbar"><div class="toolbar-left"><div class="search-field">${icon('search')}<input id="list-search" aria-label="搜索资料" placeholder="搜索邮箱、备注或辅助邮箱" value="${escapeHtml(state.query)}" /></div><select id="country-filter" aria-label="筛选国家">${options([['', '全部国家'], '马来西亚', '美国', '日本', '新加坡'], state.country)}</select><select id="status-filter" aria-label="筛选账号状态">${options([['', '全部状态'], '正常', '冻结'], state.status)}</select></div><div class="toolbar-right">${button('列设置', 'column-settings', '', 'columns', `data-table-id="${tableId}"`)}${button('批量导入', 'mail-import', '', 'upload')}</div></div>${getSelection('inventory').size ? `<div class="selection-bar">已选择 ${getSelection('inventory').size} 条${textAction('复制所选', 'mail-copy-selected')}${state.mailTab === 'used' ? textAction('归还所选', 'mail-return-selected') : ''}</div>` : ''}${table(columns, pageRows(filtered), 'inventory', tableId)}${pagination(filtered.length)}</section>`
  );
}
function extractionRows() {
  const data = state.extractionKind === 'account' ? accounts : mailboxes;
  return state.extractionByKind[state.extractionKind]
    .map((id) => data.find((row) => row.id === id))
    .filter(Boolean);
}
function renderExtraction() {
  const isAccount = state.route === 'workspace/account-extract';
  state.extractionKind = isAccount ? 'account' : 'mail';
  const types = isAccount ? accountTypes : mailTypes;
  const draftKey = `extraction:${state.extractionKind}`;
  const draft = state.drafts.get(draftKey) || { ...state.extractionDraft, type: types[0][0] };
  const data = isAccount ? accounts : mailboxes;
  const rows = extractionRows();
  const noun = isAccount ? '账号' : '邮箱';
  return (
    header(
      `${noun}提取`,
      `按类型和用途领取${noun}，未使用的资料可逐条归还。`,
      button(
        '查看库存',
        'goto',
        '',
        'database',
        `data-route="${isAccount ? 'accounts/gpt' : 'mailboxes/google'}"`
      )
    ) +
    `<div class="two-column"><section class="panel form-panel"><div class="steps"><div class="step current"><span class="step-circle">1</span>选择资料</div><div class="step-line"></div><div class="step"><span class="step-circle">2</span>确认提取</div><div class="step-line"></div><div class="step ${rows.length ? 'current' : ''}"><span class="step-circle">3</span>复制与归还</div></div><form id="extraction-form" novalidate><div class="form-section"><div class="section-heading"><span class="section-number">01</span><h2>提取内容</h2></div>${field(`${noun}类型`, 'extract-type', select('extract-type', types, draft.type), true)}${field('提取数量', 'extract-quantity', input('extract-quantity', draft.quantity, 'type="number" min="1" max="100" step="1"'), true, '仅提取正常、未使用且未被其他任务占用的资料。')}</div><div class="form-section"><div class="section-heading"><span class="section-number">02</span><h2>用途与备注</h2></div>${field('提取用途', 'extract-purpose', select('extract-purpose', ['注册 Claude', '注册 GPT', '业务备用', '其他'], draft.purpose), true)}${field('用途说明', 'extract-other', input('extract-other', draft.other || '', 'placeholder="选择其他时填写具体用途"'))}${field('备注', 'extract-notes', `<textarea id="extract-notes" name="extract-notes" rows="3" placeholder="记录本批次的使用说明，便于后续追溯">${escapeHtml(draft.notes || '')}</textarea>`)}</div><div class="form-footer"><span class="footnote">提取前会再次确认类型、用途和数量。</span><button class="button primary" type="submit">${icon('download')}确认提取</button></div></form></section><aside class="stack"><section class="panel side-panel"><h2>当前可用库存</h2>${types.map(([id, label]) => `<div class="inventory-type"><span class="type-label"><span class="provider-mark">${id === 'google' || id === 'gpt' ? 'G' : id === 'claude' ? 'C' : 'A'}</span>${label}</span><strong>${data.filter((row) => row.type === id && !row.used && row.health === 'normal' && row.status === '正常').length}</strong></div>`).join('')}</section><div class="side-note"><strong>提取后仍可归还</strong>选中需要归还的资料，选择“未使用”“死号”或“解封中”。本次操作记录会保留。<br />本页仅演示库存操作。</div></aside></div>` +
    `<section class="panel result-panel"><div class="panel-heading"><h2>本次提取结果 ${rows.length ? tag(`${rows.length} 条`, 'success') : ''}</h2><div class="toolbar-right">${button('复制所选', 'extract-copy', '', 'copy', rows.length ? '' : 'disabled')}${button('归还所选', 'extract-return', '', 'return', rows.length ? '' : 'disabled')}</div></div>${
      rows.length
        ? table(
            [
              { id: 'email', label: `${noun}账号`, class: 'email-cell' },
              { id: 'password', label: '密码', class: 'mono' },
              { id: 'purpose', label: '用途' },
              { id: 'usedAt', label: '提取时间' },
              { id: 'extractionNotes', label: '提取备注' },
              {
                id: 'used',
                label: '使用状态',
                render: (row) =>
                  tag(
                    row.health === 'dead'
                      ? '死号'
                      : row.health === 'unlocking'
                        ? '解封中'
                        : row.used
                          ? '已提取'
                          : '已归还',
                    row.used ? 'blue' : 'success'
                  )
              },
              {
                id: 'actions',
                label: '操作',
                action: true,
                render: (row) =>
                  `<div class="action-links">${textAction('复制', 'record-copy', `data-id="${row.id}"`)}${row.used ? textAction('归还', 'record-return', `data-id="${row.id}"`) : '<span class="text-secondary">已归还</span>'}</div>`
              }
            ],
            rows,
            'extraction',
            '提取结果'
          )
        : empty('提取结果将在这里显示', '提取后支持复制资料，以及按条选择归还。')
    }</section>`
  );
}
function renderClaude() {
  const counts = {
    active: subscriptions.filter((row) => row.status === 'active').length,
    frozen: subscriptions.filter((row) => row.status === 'frozen').length,
    abandoned: subscriptions.filter((row) => row.status === 'abandoned').length,
    rental: state.rentals.length
  };
  const rows = subscriptions.filter(
    (row) =>
      row.status === state.claudeTab &&
      (!state.query || `${row.email} ${row.tenant} ${row.owner}`.includes(state.query)) &&
      (!state.status || row.plan === state.status)
  );
  const columns = [
    { id: 'email', label: '邮箱账号', class: 'email-cell' },
    { id: 'type', label: '邮箱分类' },
    {
      id: 'plan',
      label: '开通套餐',
      render: (row) => tag(row.plan, row.plan === 'Pro' ? '' : 'blue')
    },
    {
      id: 'contacts',
      label: '客户联系方式',
      render: (row) => textAction('查看联系资料', 'claude-contact', `data-id="${row.id}"`)
    },
    { id: 'expiry', label: '到期时间' },
    {
      id: 'remaining',
      label: '订单状态',
      render: (row) =>
        tag(
          `${Math.ceil((Date.parse(row.expiry.replace(' ', 'T') + ':00+08:00') - demoNow) / 86400000)} 天后到期`,
          row.expiry.includes('11-05') ? 'warning' : 'success'
        )
    },
    {
      id: 'kyc',
      label: '验证状态',
      render: (row) => tag(row.kyc, row.kyc === '未认证' ? '' : 'success')
    },
    { id: 'tenant', label: '租户姓名' },
    { id: 'owner', label: '归属人' },
    { id: 'verifier', label: '认证人' },
    { id: 'phone', label: '电话号码' },
    { id: 'payment', label: '支付方式' },
    { id: 'paymentId', label: '卡号 / ID' },
    { id: 'start', label: '订阅时间' },
    {
      id: 'actions',
      label: '操作',
      action: true,
      render: (row) =>
        `<div class="action-links">${textAction('续费', 'claude-renew', `data-id="${row.id}"`)}${textAction('记录', 'claude-history', `data-id="${row.id}"`)}${textAction('更多操作', 'claude-more', `data-id="${row.id}" aria-haspopup="menu" aria-expanded="false"`, 'secondary', 'down')}</div>`
    }
  ];
  if (!state.columns.has('Claude专属'))
    state.columns.set(
      'Claude专属',
      new Set(['verifier', 'phone', 'payment', 'paymentId', 'start'])
    );
  return (
    header(
      'Claude 专属',
      '从开通、续费到付租，集中处理每个账号的订阅周期。',
      button('列设置', 'column-settings', '', 'columns', 'data-table-id="Claude专属"') +
        button('录入 Claude 订单', 'goto', 'primary', 'plus', 'data-route="workspace/order/claude"'),
      '订阅运营'
    ) +
    summary([
      ['管理中', counts.active, '个账号', true],
      ['即将到期', 3, '个账号'],
      ['KYC 已认证', subscriptions.filter((row) => row.kyc !== '未认证').length, '个账号'],
      ['待付租批次', state.rentals.filter((row) => !row.paid).length, '个批次']
    ]) +
    `<section class="panel"><div class="tabs" role="tablist" aria-label="Claude 运营状态">${[
      ['active', '使用中'],
      ['frozen', '冻结'],
      ['abandoned', '弃用'],
      ['rental', '付租批次']
    ]
      .map(
        ([id, label]) =>
          `<button role="tab" aria-selected="${state.claudeTab === id}" class="tab ${state.claudeTab === id ? 'active' : ''}" data-action="claude-tab" data-tab="${id}">${label}<span class="tab-count">${counts[id]}</span></button>`
      )
      .join(
        ''
      )}</div>${state.claudeTab === 'rental' ? renderRentals() : `<div class="toolbar"><div class="toolbar-left"><div class="search-field">${icon('search')}<input id="list-search" aria-label="搜索 Claude 账号" placeholder="搜索邮箱、租户或归属人" value="${escapeHtml(state.query)}" /></div><select id="status-filter" aria-label="筛选套餐">${options([['', '全部套餐'], 'Pro', 'Max 5x', 'Max 20x'], state.status)}</select></div><div class="toolbar-right">${button('生成付租批次', 'rental-create', '', 'orders', getSelection('claude').size ? '' : 'disabled')}${button('运营设置', 'claude-settings', '', 'settings')}</div></div>${getSelection('claude').size ? `<div class="selection-bar">已选择 ${getSelection('claude').size} 个账号${textAction('清除选择', 'clear-selection', 'data-scope="claude"')}</div>` : ''}${table(columns, pageRows(rows), 'claude', 'Claude专属')}${pagination(rows.length)}`}</section>`
  );
}
function renderRentals() {
  return state.rentals.length
    ? table(
        [
          { id: 'id', label: '付租批次' },
          { id: 'count', label: '账号数量' },
          { id: 'tenants', label: '租户姓名' },
          {
            id: 'paid',
            label: '付款状态',
            render: (row) => tag(row.paid ? '付款完毕' : '待付款', row.paid ? 'success' : 'warning')
          },
          { id: 'notes', label: '备注' },
          {
            id: 'actions',
            label: '操作',
            action: true,
            render: (row) =>
              `<div class="action-links">${textAction('复制明细', 'rental-copy', `data-id="${row.id}"`)}${!row.paid ? textAction('标记付款', 'rental-paid', `data-id="${row.id}"`) : textAction('查看备注', 'rental-note', `data-id="${row.id}"`)}</div>`
          }
        ],
        state.rentals,
        '',
        '付租批次'
      )
    : empty('还没有付租批次', '在“使用中”选中账号后，可生成批次并复制待付款明细。');
}
function orderFields(values = {}) {
  return `<input type="hidden" name="sourceOrderId" value="${escapeHtml(values.sourceOrderId || '')}" /><div class="form-section"><div class="section-heading"><span class="section-number">01</span><h2>订单资料</h2></div>${field('产品类型', 'order-product', select('order-product', ['GPT', 'Claude Pro', 'Claude Max'], values.product || 'Claude Max'), true)}${field('客户资料', 'order-customer', input('order-customer', values.customer || '', 'placeholder="搜索或填写演示客户名称"'), true)}${field('邮箱账号', 'order-email', input('order-email', values.email || '', 'placeholder="account@example.test"'), true)}${field('开通套餐', 'order-plan', select('order-plan', productPlans[values.product || 'Claude Max'], values.plan || 'Max 5x'), true)}${field('业务类型', 'order-kind', select('order-kind', ['成品', '续费'], values.kind || '成品'))}</div><div class="form-section"><div class="section-heading"><span class="section-number">02</span><h2>收款与订阅周期</h2></div>${field('支付方式', 'order-payment', select('order-payment', ['银行卡', '苹果内购'], values.payment || '银行卡'), true)}${field('代付金额', 'order-paid', `<div class="field-row">${input('order-paid', '', 'inputmode="decimal" placeholder="填写实际代付金额"')}${select('order-paid-currency', ['MYR', 'USD', 'IDR', 'PHP', 'CLP'], 'MYR')}</div>`, true)}${field('售卖金额', 'order-sale', `<div class="field-row">${input('order-sale', '', 'inputmode="decimal" placeholder="填写实际收到金额"')}${select('order-sale-currency', ['CNY', 'MYR'], 'CNY')}</div>`, true)}${field('订阅时间', 'order-start', input('order-start', values.start || '2026-11-03T14:30', 'type="datetime-local"'), true)}${field('到期时间', 'order-expiry', input('order-expiry', values.expiry || addCalendarMonth(values.start || '2026-11-03T14:30'), 'type="datetime-local"'), true, values.kind === '续费' ? '续费在原到期时间基础上增加一个自然月，可按实际账单修正。' : '默认下个自然月同日同一时刻，可按实际账单修正。')}</div><div class="form-section"><div class="section-heading"><span class="section-number">03</span><h2>人员与备注</h2></div>${field('租户', 'order-tenant', input('order-tenant', values.tenant || '', 'placeholder="选择或录入付租对象"'))}${field('归属人', 'order-owner', input('order-owner', values.owner || '', 'placeholder="选择业务归属人员"'))}${field('认证人', 'order-verifier', input('order-verifier', '', 'placeholder="选择或录入 KYC 认证人"'))}${field('备注', 'order-notes', `<textarea id="order-notes" name="order-notes" rows="2">${escapeHtml(values.notes || '')}</textarea>`)}</div>`;
}
function renderOrder() {
  const draft = state.drafts.get('order-page') || {};
  return (
    header('提交订单', '统一录入客户、订阅资料与实际收支，保存前核对订单明细。', '', '订单工作台') +
    `<div class="two-column"><section class="panel form-panel"><form id="order-form" novalidate>${orderFields(draft)}<div class="form-footer"><span class="footnote">切页返回保留本次演示输入。</span><button type="submit" class="button primary">核对订单</button></div></form></section><aside class="stack"><section class="panel side-panel"><h2>费用口径</h2><dl class="definition-list"><dt>Claude 银行卡手续费</dt><dd>100 MYR / 单</dd><dt>账号成本</dt><dd>50 MYR / 单</dd><dt>谷歌邮箱成本</dt><dd>15 CNY / 单</dd><dt>苹果邮箱成本</dt><dd>25 CNY / 单</dd><dt>微软邮箱成本</dt><dd>5 CNY / 单</dd></dl><div class="side-note">包含续费在内，每笔订单均计入对应费用。最终成本以订单采用的配置和汇率快照为准。</div></section><div class="inline-notice">${icon('info')}<span>原型未连接汇率，利润显示为待核算，不使用示例报价充当实际利润。</span></div></aside></div>`
  );
}
function renderOrders() {
  const product =
    state.route === 'orders/pro'
      ? 'Claude Pro'
      : state.route === 'orders/max'
        ? 'Claude Max'
        : 'GPT';
  const rows = state.demoOrders.filter((row) => (row.product || 'GPT') === product);
  return (
    header(
      `${product} 订单`,
      '充值任务成功后进入待补全列表，补充客户与实际收款资料。',
      button('提交订单', 'goto', 'primary', 'plus', `data-route="workspace/order/${product === 'GPT' ? 'gpt' : 'claude'}"`)
    ) +
    `<section class="panel"><div class="tabs"><button class="tab active">全部订单 <span class="tab-count">${rows.length}</span></button></div>${
      rows.length
        ? table(
            [
              { id: 'id', label: '订单编号' },
              { id: 'email', label: '账号 / 邮箱', class: 'email-cell' },
              { id: 'plan', label: '开通套餐' },
              {
                id: 'status',
                label: '资料完整性',
                render: (row) => tag(row.status, row.status === '待补全' ? 'warning' : 'success')
              },
              { id: 'profit', label: '利润' },
              {
                id: 'actions',
                label: '操作',
                action: true,
                render: (row) => textAction('补充资料', 'order-complete', `data-id="${row.id}"`)
              }
            ],
            rows,
            '',
            'GPT订单'
          )
        : empty('暂无演示订单', '可以先创建演示充值任务，再模拟成功以查看待补全订单。')
    }</section>`
  );
}
function renderPlaceholder() {
  const group = navigation.find((entry) => entry[2].some((item) => item[1] === state.route));
  const item = group?.[2].find((entry) => entry[1] === state.route);
  const placeholder = item?.[2];
  return (
    header(
      item?.[0] || '页面预览',
      placeholder
        ? '此模块按当前规划保留位置，暂不接入业务。'
        : '本页保留新导航位置，后续按统一组件和模块顺序开发。',
      button('查看设计说明', 'design-guide', '', 'info')
    ) +
    `<section class="panel">${empty(placeholder ? '模块占位' : '已纳入后续开发', placeholder ? '本阶段优先完成已确定的业务页面。' : '第一批重点查看：邮箱管理、邮箱提取、Claude 专属、比特充值及订单表单。')}<div class="toolbar" data-page-actions>${button('查看邮箱管理', 'goto', '', 'mail', 'data-route="mailboxes/google"')}${button('查看 Claude 专属', 'goto', '', 'orders', 'data-route="orders/exclusive"')}</div></section>`
  );
}
function preserveMainDraft() {
  for (const module of window.IDDesignModules) module.preserveDraft?.();
  const form = $('form', $('#main'));
  if (!form) return;
  if (form.id === 'extraction-form') {
    const v = readForm(form);
    state.drafts.set(`extraction:${state.extractionKind}`, {
      type: v['extract-type'],
      quantity: v['extract-quantity'],
      purpose: v['extract-purpose'],
      other: v['extract-other'],
      notes: v['extract-notes']
    });
  }
  if (form.id === 'order-form') {
    const v = readForm(form);
    state.drafts.set('order-page', {
      sourceOrderId: v.sourceOrderId,
      product: v['order-product'],
      customer: v['order-customer'],
      email: v['order-email'],
      plan: v['order-plan'],
      kind: v['order-kind'],
      payment: v['order-payment'],
      start: v['order-start'],
      expiry: v['order-expiry'],
      tenant: v['order-tenant'],
      owner: v['order-owner'],
      notes: v['order-notes'],
      raw: v
    });
  }
}
let pendingPageScroll = null;
let layoutRenderVersion = 0;
const retainedPageRegions = new Map();
let mountedPage;
function activePageRegion() {
  return $('#main > [data-page-region]:not([hidden])') || $('#main');
}
function clearPageRegions() {
  mountedPage?.module?.deactivate?.(mountedPage.region);
  for (const module of window.IDDesignModules) module.clearPageState?.();
  mountedPage?.region.remove();
  for (const region of retainedPageRegions.values()) region.remove();
  retainedPageRegions.clear();
  mountedPage = undefined;
  delete $('#main').dataset.layoutRoute;
  window.IDLocalData?.queries?.clear();
}
function restorePageScroll(top) {
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - innerHeight);
  window.scrollTo({ top: Math.min(top, maxScroll), behavior: 'instant' });
}
function restorePendingPageScroll() {
  if (pendingPageScroll?.route === state.route) restorePageScroll(pendingPageScroll.top);
}
// A sidebar closing, a late font or a data region can change the available
// height after the first paint. Keep the navigation target until user input;
// a resize may complete a previously clamped restoration without taking over
// subsequent manual scrolling.
new ResizeObserver(restorePendingPageScroll).observe($('#main'));
for (const eventName of ['wheel', 'touchstart', 'pointerdown', 'keydown'])
  window.addEventListener(eventName, () => {
    pendingPageScroll = null;
    layoutRenderVersion++;
  }, { passive: true });
function render() {
  closeActionMenu();
  const renderVersion = ++layoutRenderVersion;
  const main = $('#main');
  const sameRoute = main.dataset.layoutRoute === state.route;
  const tabScroll = sameRoute ? captureTabScroll(activePageRegion()) : new Map();
  const tableScroll = new Map();
  if (sameRoute) {
    for (const table of $$('.table-viewport > table[data-table]', activePageRegion())) {
      const viewport = table.parentElement;
      if (viewport.scrollTop || viewport.scrollLeft)
        tableScroll.set(tableScrollKey(table), { top: viewport.scrollTop, left: viewport.scrollLeft });
    }
  }
  if (!sameRoute)
    pendingPageScroll = { route: state.route, top: state.viewDrafts.get(state.route)?.scrollY || 0 };
  const scrollTarget = pendingPageScroll?.route === state.route
    ? pendingPageScroll.top : window.scrollY;
  let content;
  const allowed = permittedRoute(state.route);
  const extension = allowed && window.IDDesignModules.find((module) => module.matches(state.route));
  if (!allowed)
    content =
      header('访问受限', '') +
      `<section class="panel">${empty('当前账号无权打开此页面', '可从左侧导航查看已授权的库存与订单。')}</section>`;
  else if (extension) content = extension.render();
  else if (
    (state.route.startsWith('mailboxes/') && !state.route.endsWith('microsoft')) ||
    ['accounts/gpt', 'accounts/claude'].includes(state.route)
  )
    content = renderMailbox();
  else if (['workspace/mail-extract', 'workspace/account-extract'].includes(state.route))
    content = renderExtraction();
  else if (state.route === 'orders/exclusive') content = renderClaude();
  else if (state.route === 'workspace/order') content = renderOrder();
  else if (['orders/gpt', 'orders/pro', 'orders/max'].includes(state.route))
    content = renderOrders();
  else if (state.route === 'workspace/mail-submit')
    content =
      header(
        '邮箱提交',
        '新增邮箱或批量导入，预检后入库。域名只作类型建议，Apple ID 使用其他邮箱时可手动指定资料类型。'
      ) +
      `<section class="panel form-panel"><div class="submission-grid"><div class="guide-item"><div class="section-title-row"><h3>单条录入</h3>${titleInfo('单条录入', '填写邮箱及必要资料，支持无绑定电话的明确确认。', 'mail-single-description')}</div><div class="toolbar">${button('录入邮箱', 'mail-add', 'primary', 'plus')}</div></div><div class="guide-item"><div class="section-title-row"><h3>批量导入</h3>${titleInfo('批量导入', '粘贴文本或选择 CSV，检查格式、重复邮箱和错误行。', 'mail-batch-description')}</div><div class="toolbar">${button('批量导入', 'mail-import', '', 'upload')}</div></div></div></section>`;
  else content = renderPlaceholder();
  // Ordinary pages restore data/drafts. Only explicitly registered embedded
  // runtimes keep a connected region: detaching an iframe reloads its document.
  const retain = allowed && extension?.retainPage?.(state.route) === true;
  let region = retain && retainedPageRegions.get(state.route);
  if (mountedPage && mountedPage.region !== region) {
    mountedPage.module?.deactivate?.(mountedPage.region);
    if (mountedPage.retained) {
      mountedPage.region.hidden = true;
      mountedPage.region.inert = true;
    } else mountedPage.region.remove();
  }
  if (!region) {
    region = document.createElement('div');
    region.dataset.pageRegion = state.route;
    region.className = 'design-page-region design-async-region';
    region.innerHTML = content;
    main.append(region);
    if (retain) retainedPageRegions.set(state.route, region);
  } else {
    const template = document.createElement('template');
    template.innerHTML = content;
    const heading = template.content.querySelector('.page-header');
    if (heading) region.prepend(heading);
  }
  region.hidden = false;
  region.inert = false;
  mountedPage = { region, module: extension, retained: retain };
  main.dataset.layoutRoute = state.route;
  mountPageContext(region);
  renderSidebar();
  stabilizeDesignTables();
  if (state.route === 'workspace/order') {
    const raw = state.drafts.get('order-page')?.raw;
    if (raw)
      Object.entries(raw).forEach(([name, value]) => {
        const control = document.getElementById(name);
        if (control) control.value = value;
      });
  }
  if (['normal', 'refresh', 'refresh-error'].includes(state.previewMode))
    extension?.afterRender?.({ routeChanged: !sameRoute });
  window.IDChangeSync?.resume();
  applyDesignPreviewState();
  restoreTabScroll(region, tabScroll);
  if (tableScroll.size) {
    for (const table of $$('.table-viewport > table[data-table]', region)) {
      const scroll = tableScroll.get(tableScrollKey(table));
      if (scroll) table.parentElement.scrollTo({ ...scroll, behavior: 'instant' });
    }
  }
  requestAnimationFrame(() => {
    if (renderVersion !== layoutRenderVersion) return;
    restorePageScroll(scrollTarget);
  });
  $('#nav-toggle').setAttribute(
    'aria-expanded',
    String(
      window.innerWidth <= 900 ? document.body.classList.contains('nav-open') : !state.collapsed
    )
  );
}
function navigate(event) {
  let next = location.hash.replace(/^#\/?/, '') || 'mailboxes/google';
  const currentHash = '#/' + state.route;
  if (
    window.IDDesignAPI.modules.operations?.blockRechargeNavigation({
      quiet: location.hash === currentHash
    })
  ) {
    if (location.hash !== currentHash) history.replaceState(null, '', currentHash);
    return;
  }
  const entryRouteAliases = {
    'workspace/account-submit': 'workspace/account-extract',
    'workspace/mail-submit': 'workspace/mail-extract',
    'workspace/my-recharge-codes': 'workspace/recharge-codes',
    'data-management/claude-google-subscriptions': 'subscriptions/claude'
  };
  if (entryRouteAliases[next]) {
    next = entryRouteAliases[next];
    history.replaceState(null, '', '#/' + next);
  }
  if (next === 'settings/customer-tags') {
    next = 'customers/list';
    history.replaceState(null, '', '#/' + next);
  }
  if (next === 'mailboxes/apple') {
    next = 'accounts/apple-balances';
    history.replaceState(null, '', '#/' + next);
  }
  if (next === 'orders/recharge-sync') {
    next = gptOrderSyncRoute;
    history.replaceState(null, '', '#/' + next);
  }
  if (
    !navigation.some((group) => group[2].some((item) => item[1] === next)) &&
    !window.IDDesignModules.some((module) => module.matches(next))
  ) {
    location.hash = '/mailboxes/google';
    return;
  }
  // A hash navigation can emit both popstate and hashchange.
  if (event && state.route === next && mountedPage?.region.isConnected &&
      mountedPage.region.dataset.pageRegion === next) return;
  preserveMainDraft();
  if (state.route !== next) {
    if (state.route)
      state.viewDrafts.set(state.route, {
        page: state.page,
        pageSize: state.pageSize,
        query: state.query,
        country: state.country,
        status: state.status,
        mailTab: state.mailTab,
        claudeTab: state.claudeTab,
        scrollY: window.scrollY
      });
    state.route = next;
    state.previewMode = 'normal';
    Object.assign(
      state,
      { page: 1, pageSize: window.IDPagination.defaultPageSize, query: '', country: '', status: '', mailTab: 'available', claudeTab: 'active' },
      state.viewDrafts.get(next) || {}
    );
    state.selections.clear();
    const group = navigation.find((entry) => entry[2].some((item) => matchesNav(next, item[1])));
    if (group) state.expanded.add(group[0]);
  }
  document.body.classList.remove('nav-open');
  $('#sidebar-shade').hidden = true;
  if ($('#drawer').open) closeDrawer();
  render();
}
function findRecord(id) {
  return [...mailboxes, ...accounts].find((row) => row.id === id);
}
function editMailbox(id = '') {
  const original = id ? findRecord(id) : null;
  const context = `mail:${id || `new:${state.route}`}`;
  const data =
    state.drafts.get(context) ||
    (original
      ? {
          ...original,
          noPhone: original.phone ? '' : 'on',
          expectedVersion: String(original.version)
        }
      : {
          type: state.route.split('/')[1] || 'google',
          status: '正常',
          source: '自己注册',
          registered: '2026-11-03T10:30'
        });
  const account = state.route.startsWith('accounts/');
  const types = account ? accountTypes : mailTypes;
  const type =
    data['mail-type'] || (types.some(([key]) => key === data.type) ? data.type : types[0][0]);
  const value = (key) => data[`mail-${key}`] ?? data[key] ?? '';
  const phoneNeeded = ['google', 'apple'].includes(type);
  const title = original ? '修改资料' : account ? '新增账号' : '新增邮箱';
  let fields = `<input type="hidden" name="recordId" value="${escapeHtml(id)}" /><input type="hidden" name="expectedVersion" value="${escapeHtml(data.expectedVersion || original?.version || '')}" />`;
  fields += field(
    '资料类型',
    'mail-type',
    original
      ? input('mail-type-label', types.find(([key]) => key === type)?.[1] || type, 'readonly') +
          `<input type="hidden" name="mail-type" value="${type}" />`
      : select('mail-type', types, type),
    true
  );
  fields += field(
    account ? '账号邮箱' : '邮箱账号',
    'mail-email',
    input(
      'mail-email',
      value('email'),
      `${original ? 'readonly' : 'placeholder="name@example.test"'} autocomplete="off"`
    ),
    true,
    original ? '账号标识固定，其他资料可以修改。' : '原型仅使用演示邮箱，请勿填写真实登录资料。'
  );
  fields += field(
    account ? '账号密码' : '邮箱密码',
    'mail-password',
    input('mail-password', value('password'), 'autocomplete="off"'),
    !account && type !== 'relay'
  );
  if (phoneNeeded)
    fields += field(
      '绑定电话',
      'mail-phone',
      `${input('mail-phone', value('phone'), 'placeholder="填写绑定电话"')}<label class="checkbox-label"><input type="checkbox" name="noPhone" id="no-phone" ${data.noPhone ? 'checked' : ''} />确认未绑定电话号码</label>`
    );
  fields += field(
    '国家地区',
    'mail-country',
    select(
      'mail-country',
      [['', '请选择国家'], '马来西亚', '美国', '日本', '新加坡'],
      value('country')
    ),
    ['apple', 'claude'].includes(type)
  );
  if (type === 'claude') {
    fields += field(
      '注册城市',
      'mail-city',
      input('mail-city', value('city'), 'placeholder="填写演示注册城市"'),
      true
    );
    fields += field(
      '注册代理',
      'mail-proxy',
      input('mail-proxy', value('proxy'), 'placeholder="协议://账号:密码@主机:端口"'),
      false,
      '填写演示链接，不连接代理；正式实现拆分显示协议、主机、端口及账号密码。'
    );
    fields += field(
      '养号状态',
      'mail-age',
      input('mail-age', original ? `${accountAge(original)} 小时` : '0 小时', 'readonly'),
      false,
      '按注册时间计算，72 小时后可使用。演示时钟固定为 2026-11-03 10:30。'
    );
  }
  fields += field(
    '账号状态',
    'mail-status',
    select('mail-status', ['正常', '冻结', '封控中'], value('status') || '正常'),
    true
  );
  fields += field(
    '来源渠道',
    'mail-source',
    select('mail-source', ['自己注册', '线上购买', '客户提供'], value('source') || '自己注册'),
    true
  );
  fields += field(
    '注册时间',
    'mail-registered',
    input('mail-registered', value('registered'), 'type="datetime-local"')
  );
  if (type === 'apple') {
    for (const key of ['security1', 'security2', 'security3'])
      fields += field(
        `密保 ${key.slice(-1)}`,
        `mail-${key}`,
        input(`mail-${key}`, value(key), 'placeholder="填写演示密保资料"')
      );
    fields += field(
      '密保生日',
      'mail-birthday',
      input('mail-birthday', value('birthday'), 'type="date"')
    );
  }
  if (type !== 'apple' && type !== 'relay')
    fields += field(
      '2FA 密钥',
      'mail-totp',
      input('mail-totp', value('totp'), 'autocomplete="off"')
    );
  if (type === 'google')
    fields += field('辅助邮箱', 'mail-auxiliary', input('mail-auxiliary', value('auxiliary')));
  if (!account)
    fields += field(
      '应用专用密码',
      'mail-appPassword',
      input('mail-appPassword', value('appPassword'), 'autocomplete="off"')
    );
  fields +=
    field('登录设备', 'mail-device', input('mail-device', value('device'))) +
    field('备注 1', 'mail-notes', input('mail-notes', value('notes'))) +
    field('备注 2', 'mail-notes2', input('mail-notes2', value('notes2')));
  openDrawer(
    title,
    `${original ? '修改后保留操作记录，支持撤回最近一次修改。' : '新增资料将在当前原型内存中展示。'} 关闭或取消保留演示草稿。`,
    `<form id="mail-form" novalidate>${fields}</form>`,
    `<span class="footnote">仅演示资料，不会保存到数据库</span>${button('取消', 'drawer-close')}<button class="button primary" type="submit" form="mail-form">核对并保存</button>`,
    context
  );
}
function saveMailbox(form) {
  const values = readForm(form),
    type = values['mail-type'];
  let firstError;
  const required = { 'mail-email': '请填写邮箱账号' };
  if (['google', 'apple'].includes(type)) required['mail-password'] = '请填写邮箱密码';
  if (['apple', 'claude'].includes(type)) required['mail-country'] = '请选择国家地区';
  if (type === 'claude') required['mail-city'] = '请填写注册城市';
  Object.entries(required).forEach(([name, message]) => {
    const error = !String(values[name] || '').trim() ? message : '';
    setError(name, error);
    if (error && !firstError) firstError = name;
  });
  if (values['mail-email'] && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values['mail-email'].trim())) {
    setError('mail-email', '邮箱格式不正确，请检查 @ 和域名');
    firstError ||= 'mail-email';
  }
  const phoneError =
    ['google', 'apple'].includes(type) && !values['mail-phone']?.trim() && !values.noPhone;
  setError('mail-phone', phoneError ? '填写绑定电话，或明确勾选未绑定电话号码' : '');
  if (phoneError) firstError ||= 'mail-phone';
  if (
    [...mailboxes, ...accounts].some(
      (row) =>
        row.email.toLowerCase() === values['mail-email'].trim().toLowerCase() &&
        row.id !== values.recordId &&
        row.type === type
    )
  ) {
    setError('mail-email', '此类型中已存在相同邮箱，请核对');
    firstError ||= 'mail-email';
  }
  if (firstError) {
    document.getElementById(firstError).focus();
    return;
  }
  const original = values.recordId ? findRecord(values.recordId) : null;
  if (original && String(original.version) !== values.expectedVersion) {
    notify('资料版本已变化，请重新核对后修改');
    return;
  }
  confirmAction(
    original ? '确认修改资料' : '确认新增资料',
    `将${original ? '修改' : '新增'} ${values['mail-email']} 的演示资料。本操作只影响当前原型。`,
    () => {
      const updated = { type, email: values['mail-email'].trim() };
      for (const key of [
        'password',
        'phone',
        'country',
        'city',
        'proxy',
        'status',
        'source',
        'registered',
        'totp',
        'auxiliary',
        'appPassword',
        'device',
        'notes',
        'notes2',
        'security1',
        'security2',
        'security3',
        'birthday'
      ])
        if (values[`mail-${key}`] !== undefined) updated[key] = values[`mail-${key}`];
      if (original) {
        state.mailUndo.set(original.id, {
          snapshot: structuredClone(original),
          version: original.version + 1
        });
        Object.assign(original, updated, { version: original.version + 1 });
        original.history.push({ action: '修改资料' });
      } else {
        const target = ['gpt', 'claude'].includes(type) ? accounts : mailboxes;
        target.unshift({
          ...updated,
          id: `demo-${Date.now()}`,
          used: false,
          health: 'normal',
          version: 1,
          history: [],
          password: updated.password || ''
        });
      }
      state.drafts.delete(state.drawerContext);
      $('#drawer').close();
      state.drawerContext = '';
      render();
      notify('演示资料已更新');
    },
    '确认保存'
  );
}
function returnRecords(ids) {
  const rows = ids.map(findRecord).filter((row) => row?.used);
  if (rows.some((row) => !canReturn(row))) {
    notify('资料已关联充值任务或付款记录，不能归还，请先核对原任务');
    return;
  }
  if (!rows.length) {
    notify('请选择仍处于已提取状态的资料');
    return;
  }
  openDrawer(
    '归还资料',
    `已选择 ${rows.length} 条。归还后保留提取历史，并进入对应库存视图。`,
    `<div class="inline-notice">${icon('return')}<span>${rows.map((row) => escapeHtml(row.email)).join('、')}</span></div><form id="return-form"><input type="hidden" name="ids" value="${escapeHtml(rows.map((row) => row.id).join(','))}" />${field('归还理由', 'return-reason', select('return-reason', ['未使用', '死号', '解封中']), true)}${field('归还备注', 'return-notes', `<textarea id="return-notes" name="return-notes" rows="3" placeholder="选填，记录归还情况"></textarea>`)}</form>`,
    button('取消', 'drawer-close') +
      '<button class="button primary" type="submit" form="return-form">核对归还</button>'
  );
}
function showMailboxMore(id, node) {
  const row = findRecord(id);
  const undo = state.mailUndo.get(id);
  openActionMenu(node, `<div class="guide-list"><div class="guide-item"><h3>库存流转</h3><p>当前资料${row.used ? '已使用' : '未使用'}，操作前将再次确认。</p><div class="toolbar">${row.health !== 'normal' ? button('恢复资料', 'mail-transition', '', 'return', `data-id="${id}" data-health="normal"`) : button('移入死号', 'mail-transition', 'danger', '', `data-id="${id}" data-health="dead"`) + button('移入解封中', 'mail-transition', '', '', `data-id="${id}" data-health="unlocking"`)}${row.used ? button('归还', 'record-return', '', 'return', `data-id="${id}"`) : ''}</div></div><div class="guide-item"><h3>修改撤回</h3><p>${undo ? '可以撤回最近一次修改，版本变化时将阻止覆盖。' : '本原型尚未修改该资料，暂无可撤回记录。'}</p><div class="form-footer">${button('撤回最近修改', 'mail-undo', '', 'return', `data-id="${id}" ${undo ? '' : 'disabled'}`)}</div></div>${row.health === 'dead' ? `<div class="guide-item"><h3>永久删除</h3><p>本原型演示删除确认。实际系统需先检查订单、任务及资料引用。</p><div class="form-footer">${button('删除演示资料', 'mail-delete', 'danger', '', `data-id="${id}"`)}</div></div>` : ''}</div>`);
}
function showColumns(tableId) {
  const columns = columnDefinitions[tableId];
  if (!columns) {
    notify('请先打开需要设置的数据表');
    return;
  }
  const hidden = state.columns.get(tableId) || new Set();
  openDrawer(
    '列设置',
    '默认显示全部业务字段。可按需隐藏，关键标识与操作列固定；偏好仅保留在当前原型标签页，刷新重置。',
    `<p id="column-settings-count" class="footnote">显示 ${columns.filter((column) => fixedTableColumn(column) || !hidden.has(column.id)).length} / ${columns.length} 列</p><div class="settings-list">${columns.map((column) => `<div class="setting-row"><label for="column-${column.id}">${escapeHtml(column.label)}${fixedTableColumn(column) ? '（固定）' : ''}</label><input type="checkbox" id="column-${column.id}" data-column-toggle="${escapeHtml(tableId)}" data-column="${column.id}" ${fixedTableColumn(column) || !hidden.has(column.id) ? 'checked' : ''} ${fixedTableColumn(column) ? 'disabled' : ''} /></div>`).join('')}</div>`,
    button('恢复全部列', 'columns-reset', '', 'return', `data-table-id="${escapeHtml(tableId)}"`) +
      button('完成', 'drawer-close')
  );
}
function updateColumnCount(tableId) {
  const columns = columnDefinitions[tableId] || [];
  const hidden = state.columns.get(tableId) || new Set();
  const count = $('#column-settings-count');
  if (count)
    count.textContent = `显示 ${columns.filter((column) => fixedTableColumn(column) || !hidden.has(column.id)).length} / ${columns.length} 列`;
}
function showTableCell(tableId, columnId, rowId) {
  const column = columnDefinitions[tableId]?.find((entry) => entry.id === columnId);
  const row = tableRecords.get(tableId)?.find((entry) => String(entry.id) === rowId);
  if (!column?.long || !row) return;
  openDrawer(
    `${column.label}完整内容`,
    '单行表格中的完整资料，可选中或复制。',
    `<textarea id="table-cell-full-value" class="copy-block" aria-label="${escapeHtml(column.label)}完整内容" readonly>${escapeHtml(row[column.id] ?? '')}</textarea>`,
    button('关闭', 'drawer-close') + button('复制完整内容', 'table-cell-copy', 'primary', 'copy')
  );
}
function showImport() {
  openDrawer(
    '批量导入邮箱',
    '先检查格式和重复资料，再确认加入演示库存。',
    `<form id="import-form" novalidate>${field('邮箱类型', 'import-type', select('import-type', mailTypes, 'google'), true)}${field('来源渠道', 'import-source', select('import-source', ['自己注册', '线上购买', '客户提供']), true)}${field('CSV 文件', 'import-file', '<input id="import-file" type="file" accept=".csv,text/csv" />', false, '只在当前页面读取文件内容，不上传。')}${field('导入内容', 'import-content', '<textarea id="import-content" name="import-content" class="copy-block" rows="7" placeholder="邮箱,密码,绑定电话\ndemo.01@example.test,Demo-Only!,\ndemo.02@example.test,Demo-Only!,演示电话"></textarea>', true, '每行：邮箱、密码、绑定电话。支持逗号分隔和带引号字段。')}<label class="checkbox-label"><input id="import-no-phone" name="import-no-phone" type="checkbox" />确认无电话号码的资料均未绑定电话</label></form><div id="import-preview"></div>`,
    button('取消', 'drawer-close') +
      '<button class="button primary" type="submit" form="import-form">检查导入内容</button>',
    'mail-import'
  );
  const draft = state.drafts.get('mail-import');
  if (draft) {
    $('#import-content').value = draft['import-content'] || '';
    $('#import-type').value = draft['import-type'] || 'google';
    $('#import-source').value = draft['import-source'] || '自己注册';
    $('#import-no-phone').checked = Boolean(draft['import-no-phone']);
  }
}
function parseCsv(text, { trimCells = true } = {}) {
  const rows = [];
  let row = [],
    value = '',
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        value += '"';
        i++;
      } else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(trimCells ? value.trim() : value);
      value = '';
    } else if (char === '\n' && !quoted) {
      row.push(trimCells ? value.trim() : value);
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
      value = '';
    } else if (char !== '\r' || (!trimCells && quoted)) value += char;
  }
  if (quoted) throw new Error('CSV 引号未闭合，请检查内容');
  row.push(trimCells ? value.trim() : value);
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows;
}
function validateImport(form) {
  const v = readForm(form);
  let rows;
  try {
    rows = parseCsv(v['import-content'] || '');
  } catch (error) {
    setError('import-content', error.message);
    return;
  }
  if (!rows.length) {
    setError('import-content', '请先输入导入内容');
    return;
  }
  const seen = new Set(
    mailboxes.filter((row) => row.type === v['import-type']).map((row) => row.email.toLowerCase())
  );
  const checked = rows.map(([email, password, phone = ''], index) => {
    let error = '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) error = '邮箱格式错误';
    else if (!password) error = '缺少密码';
    else if (seen.has(email.toLowerCase())) error = '邮箱重复';
    else if (!phone && !v['import-no-phone']) error = '需确认未绑定电话';
    seen.add((email || '').toLowerCase());
    return { id: `import-${index}`, line: index + 1, email, password, phone, error };
  });
  const invalid = checked.filter((row) => row.error);
  $('#import-preview').innerHTML =
    `<div class="form-section"><div class="section-heading"><h2>预览检查：${checked.length} 条，${invalid.length} 条需修正</h2></div>${table(
      [
        { id: 'line', label: '行号' },
        { id: 'email', label: '邮箱账号' },
        {
          id: 'error',
          label: '检查结果',
          render: (row) => tag(row.error || '可以导入', row.error ? 'danger' : 'success')
        }
      ],
      checked,
      '',
      '导入预览'
    )}</div>`;
  if (invalid.length) {
    setError('import-content', '请修正错误行后重新检查，本次不会部分导入');
    return;
  }
  setError('import-content', '');
  confirmAction(
    '确认批量导入',
    `已检查 ${checked.length} 条邮箱。将全部加入当前演示库存，刷新页面后重置。`,
    () => {
      checked.forEach((row, index) =>
        mailboxes.unshift({
          ...row,
          id: `imported-${Date.now()}-${index}`,
          type: v['import-type'],
          country: '马来西亚',
          status: '正常',
          health: 'normal',
          used: false,
          source: v['import-source'],
          registered: '2026-11-03T10:30',
          device: '',
          notes: '',
          notes2: '',
          version: 1,
          history: []
        })
      );
      state.drafts.delete('mail-import');
      $('#drawer').close();
      state.drawerContext = '';
      render();
      notify(`已导入 ${checked.length} 条演示邮箱`);
    },
    '确认导入'
  );
}
function submitExtraction(form) {
  preserveMainDraft();
  const v = readForm(form);
  const quantity = Number(v['extract-quantity']);
  const data = state.extractionKind === 'account' ? accounts : mailboxes;
  const available = data.filter(
    (row) =>
      row.type === v['extract-type'] &&
      !row.used &&
      row.health === 'normal' &&
      row.status === '正常'
  );
  let message = '';
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100)
    message = '请输入 1–100 之间的整数';
  else if (quantity > available.length)
    message = `库存不足，当前只有 ${available.length} 条可提取资料`;
  setError('extract-quantity', message);
  const otherError =
    v['extract-purpose'] === '其他' && !v['extract-other'].trim() ? '请填写具体用途' : '';
  setError('extract-other', otherError);
  if (message || otherError) {
    document.getElementById(message ? 'extract-quantity' : 'extract-other').focus();
    return;
  }
  const purpose = v['extract-purpose'] === '其他' ? v['extract-other'] : v['extract-purpose'];
  confirmAction(
    '确认提取资料',
    `将提取 ${quantity} 条${(state.extractionKind === 'account' ? accountTypes : mailTypes).find((entry) => entry[0] === v['extract-type'])?.[1]}，用途为“${purpose}”。`,
    () => {
      const picked = available.slice(0, quantity);
      picked.forEach((row) => {
        row.used = true;
        row.purpose = purpose;
        row.usedAt = '2026-11-03 10:30';
        row.version++;
        row.extractionNotes = v['extract-notes'];
        row.history.push({ action: '提取', purpose, notes: v['extract-notes'] });
      });
      state.extractionIds = picked.map((row) => row.id);
      state.extractionByKind[state.extractionKind] = [...state.extractionIds];
      state.batches.push({ ids: [...state.extractionIds], purpose });
      state.selections.set('extraction', new Set(state.extractionIds));
      render();
      notify(`已提取 ${quantity} 条演示资料`);
    }
  );
}
function submitReturn(form) {
  const v = readForm(form);
  const rows = v.ids
    .split(',')
    .map(findRecord)
    .filter((row) => row?.used);
  if (rows.some((row) => !canReturn(row))) {
    notify('资料已关联充值任务或付款记录，不能归还');
    return;
  }
  confirmAction(
    '确认归还资料',
    `归还 ${rows.length} 条资料，理由为“${v['return-reason']}”。历史提取记录将保留。`,
    () => {
      if (rows.some((row) => !canReturn(row))) {
        notify('领用或业务状态已变化，停止归还');
        return;
      }
      rows.forEach((row) => {
        row.used = false;
        row.health =
          v['return-reason'] === '死号'
            ? 'dead'
            : v['return-reason'] === '解封中'
              ? 'unlocking'
              : 'normal';
        row.version++;
        row.history.push({ action: '归还', reason: v['return-reason'], notes: v['return-notes'] });
      });
      $('#drawer').close();
      state.drawerContext = '';
      getSelection('inventory').clear();
      getSelection('extraction').clear();
      render();
      notify('所选演示资料已归还');
    },
    '确认归还'
  );
}
function personalToolRows() {
  return window.IDLocalData ? localToolbox?.current()?.data.shortcuts || [] : personalTools;
}
function personalToolTiles() {
  const query = state.personalToolQuery.trim().toLowerCase();
  const items = personalToolRows().filter((tool) =>
    `${tool.name} ${tool.url}`.toLowerCase().includes(query)
  );
  if (!items.length)
    return empty('暂无符合条件的个人工具', '调整搜索词，或在“管理工具”中新增网址。');
  return `<div class="tool-grid personal-tool-grid">${items
    .map((tool) => {
      const content = `<span class="personal-tool-mark" aria-hidden="true">${escapeHtml(tool.name.slice(0, 1))}</span><strong title="${escapeHtml(tool.name)}">${escapeHtml(tool.name)}</strong>${tool.url ? icon('external') : '<span class="tool-pending">待接入</span>'}`;
      return tool.url
        ? `<a class="tool-tile personal-tool-tile" href="${escapeHtml(tool.url)}" target="_blank" rel="noopener noreferrer" aria-label="打开${escapeHtml(tool.name)}">${content}</a>`
        : `<button class="tool-tile personal-tool-tile" data-action="personal-tool-edit" data-id="${escapeHtml(tool.id)}" aria-label="配置${escapeHtml(tool.name)}网址">${content}</button>`;
    })
    .join('')}</div>`;
}
function openToolboxPanel(tab, body, footer = '') {
  openDrawer(tab, '', body, footer, '', { kind: 'workspace-tools' });
}
function onlineToolItems() {
  return [
    ['key', '计算 2FA 验证码', '临时计算验证码，或管理当前账号的常用验证器。'],
    ['play', '抖音解析', '粘贴公开作品链接，解析后选择视频、原声或图片。'],
  ];
}
function showTools(tab = state.toolsTab) {
  state.toolsTab = tab;
  state.tool = '';
  if (tab === '话术文案' && window.IDDesignAPI.modules.operations) {
    window.IDDesignAPI.modules.operations.showPhrases();
    return;
  }
  const online = onlineToolItems();
  const copy = [
    ['chat', '客户咨询回复', '您好，请问需要开通哪个套餐？'],
    ['chat', '续费提醒', '您的订阅即将到期，如需续费请联系。']
  ];
  if (window.IDLocalData && tab === '个人工具' && !localToolbox?.current()) {
    const error = localToolbox?.error();
    openToolboxPanel(tab,
        `<div id="personal-tool-load" role="status">${
          error || !localToolbox
            ? empty('个人工具读取失败', error || '请刷新本机页面。') +
              (localToolbox ? button('重新读取', 'personal-tool-retry') : '')
            : '<div class="inline-notice">正在读取个人工具…</div>'
        }</div>`
    );
    const pending = $('#personal-tool-load');
    if (localToolbox && !error)
      void localToolbox
        .load()
        .finally(() => {
          if (pending.isConnected && $('#drawer').open) showTools(tab);
        })
        .catch(() => {});
    return;
  }
  const body =
    tab === '个人工具'
      ? `<div class="toolbox-search search-field">${icon('search')}<input id="personal-tool-search" aria-label="搜索个人工具" placeholder="搜索个人工具" value="${escapeHtml(state.personalToolQuery)}" /></div><div id="personal-tool-results">${personalToolTiles()}</div>`
      : `<div class="form-section"><div class="tool-grid ${tab === '在线工具' ? 'online-tool-list' : ''}">${(tab === '在线工具' ? online : copy)
          .map(([iconName, title, caption, planned]) =>
            tab === '在线工具'
              ? `<div class="tool-tile online-tool-tile${planned ? ' tool-planned' : ''}"><button class="online-tool-open" data-action="tool-open" data-name="${title}" data-caption="${escapeHtml(caption)}">${icon(iconName)}<strong>${title}</strong>${planned ? '<span class="tag">待开发</span>' : ''}</button>${icon('chevron', 'online-tool-arrow')}</div>`
              : `<button class="tool-tile" data-action="tool-open" data-name="${title}" data-caption="${escapeHtml(caption)}">${icon(iconName)}<span><strong>${title}</strong><small>${caption}</small></span></button>`
          )
          .join('')}</div></div>`;
  const footer =
    tab === '个人工具'
      ? button('管理工具', 'personal-tool-manage', '', 'settings')
      : '';
  openToolboxPanel(tab, body, footer);
}
function showPersonalToolManager(editor = '', context = '') {
  const rows = personalToolRows();
  const list = rows.map((tool, index) => {
    const attrs = `data-id="${escapeHtml(tool.id)}"`;
    return `<li class="personal-manager-row"><span class="personal-tool-mark" aria-hidden="true">${escapeHtml(tool.name.slice(0, 1))}</span><div class="personal-manager-name"><strong>${escapeHtml(tool.name)}</strong><small>${tool.url ? escapeHtml(tool.url) : '待接入'}</small></div><div class="action-links">${textAction('上移', 'personal-tool-move', `${attrs} data-offset="-1" ${index === 0 ? 'disabled' : ''}`)}${textAction('下移', 'personal-tool-move', `${attrs} data-offset="1" ${index === rows.length - 1 ? 'disabled' : ''}`)}${textAction('修改', 'personal-tool-edit', attrs)}${textAction('删除', 'personal-tool-remove', attrs, 'danger')}</div></li>`;
  }).join('');
  openDrawer(
    '快捷网址设置',
    '当前账号的常用网址和显示顺序。',
    `<div class="personal-manager-toolbar"><div><strong>我的快捷网址</strong> <span>${rows.length} / 20</span></div>${button('新增网址', 'personal-tool-add', 'primary', 'plus', rows.length >= 20 ? 'disabled' : '')}</div>${editor}${rows.length ? `<ul class="personal-manager-list" aria-label="快捷网址列表">${list}</ul>` : empty('还没有快捷网址', '点击新增网址，设置第一个常用入口。')}`,
    '',
    context,
    { kind: 'personal-tool-manager' }
  );
}
function editPersonalTool(id = '') {
  const tool = personalToolRows().find((item) => item.id === id);
  if (id && !tool) return notify('这个个人工具已移除。');
  const context = `personal-tool:${id || 'new'}`;
  const draft = state.drafts.get(context) || {};
  const version = localToolbox?.current()?.version;
  const localFields = localToolbox
    ? `<input type="hidden" name="shortcut-version" value="${escapeHtml(draft['shortcut-version'] ?? version)}" /><input type="hidden" name="shortcut-new-id" value="${escapeHtml(draft['shortcut-new-id'] || (id ? '' : crypto.randomUUID()))}" /><div id="shortcut-save-error" class="inline-notice warning" role="alert" hidden></div><div id="shortcut-review" hidden>${button('重新核对当前资料', 'personal-tool-review')}</div>`
    : '';
  showPersonalToolManager(
    `<section class="guide-item personal-tool-editor"><h3>${tool ? '修改快捷网址' : '新增快捷网址'}</h3><form id="personal-tool-form" novalidate><input type="hidden" name="shortcut-id" value="${escapeHtml(id)}" />${field('网址名称', 'shortcut-name', input('shortcut-name', draft['shortcut-name'] ?? tool?.name ?? '', 'maxlength="60" placeholder="例如：工作邮箱"'), true)}${field('网址', 'shortcut-url', input('shortcut-url', draft['shortcut-url'] ?? tool?.url ?? '', 'maxlength="2048" placeholder="https://example.com" autocomplete="off"'), true, tool && !tool.url ? '待接入。填写常用网址后，即可从个人工具打开。' : '')}${localFields}<div class="form-footer">${button('取消', 'personal-tool-manage')}<button class="button primary" form="personal-tool-form" type="submit">${tool ? '保存' : '添加'}</button></div></form></section>`,
    context
  );
}
function savePersonalTool(form) {
  const values = readForm(form),
    id = values['shortcut-id'];
  const name = values['shortcut-name'].trim(),
    url = values['shortcut-url'].trim();
  let message = '';
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
      message = '请填写不包含账号密码的 HTTP 或 HTTPS 网址';
  } catch {
    message = '请填写完整网址，例如 https://example.com';
  }
  const nameError = !name || name.length > 60 ? '请输入 1–60 字的网址名称' : '';
  if (url.length > 2048) message = '网址不能超过 2048 字';
  setError('shortcut-name', nameError);
  setError('shortcut-url', message);
  if (nameError || message) {
    document.getElementById(nameError ? 'shortcut-name' : 'shortcut-url').focus();
    return;
  }
  if (
    !id &&
    personalToolRows().length >= 20 &&
    !personalToolRows().some((row) => row.id === values['shortcut-new-id'])
  ) {
    notify('个人工具已达到 20 个上限');
    return;
  }
  confirmAction(
    id ? '确认修改个人工具' : '确认新增个人工具',
    `${name} · ${url}`,
    async () => {
      const rowId = id || values['shortcut-new-id'] || `shortcut-demo-${Date.now()}`;
      const context = state.drawerContext;
      await changePersonalTools(
        Number(values['shortcut-version']),
        (rows) => {
          const tool = rows.find((item) => item.id === rowId);
          if (tool) Object.assign(tool, { name, url });
          else if (id) throw new Error('这个个人工具已移除。');
          else rows.push({ id: rowId, name, url });
        },
        id ? '更新个人工具' : '新增个人工具',
        () => {
          $('#drawer').close();
          state.drafts.delete(context);
          state.drawerContext = '';
          showPersonalToolManager();
        }
      );
    },
    '确认保存'
  );
}
async function changePersonalTools(version, change, action, done = showPersonalToolManager) {
  const drawer = $('#drawer');
  const panel = $('.drawer-body', drawer);
  const form = $('#personal-tool-form', drawer);
  const submit = form && $('button[form="personal-tool-form"]', drawer);
  if (submit) submit.disabled = true;
  try {
    if (localToolbox) await localToolbox.save('shortcuts', version, change, action);
    else change(personalTools);
    if (drawer.open && panel.isConnected) done();
    notify(localToolbox ? '个人工具已保存' : '个人工具演示资料已保存');
  } catch (error) {
    if (drawer.open && panel.isConnected) {
      const notice = $('#shortcut-save-error', panel);
      if (notice) {
        notice.textContent = error.message;
        notice.hidden = false;
        $('#shortcut-review', panel).hidden = error.status !== 409;
      } else if (error.status === 409) showPersonalToolManager();
    }
    notify(error.message);
  } finally {
    if (submit) submit.disabled = false;
  }
}
async function reviewPersonalTool(form) {
  if (!localToolbox || !form) return;
  try {
    await localToolbox.load({ refresh: true });
  } catch (error) {
    notify(error.message);
    return;
  }
  if (!form.isConnected || !$('#drawer').open) return;
  const values = readForm(form);
  const row = personalToolRows().find(
    (tool) => tool.id === (values['shortcut-id'] || values['shortcut-new-id'])
  );
  if (values['shortcut-id'] && !row) return notify('这个个人工具已移除。');
  const version = localToolbox.current().version;
  confirmAction(
    '核对当前个人工具',
    row
      ? `当前保存的资料为「${row.name}」 · ${row.url || '未填写网址'}。继续编辑会保留你刚才的输入。`
      : '当前没有这条记录。继续编辑会保留你刚才的输入。',
    () => {
      form.elements.namedItem('shortcut-version').value = version;
      $('#shortcut-save-error', form).hidden = true;
      $('#shortcut-review', form).hidden = true;
      preserveDrawerDraft();
    },
    '继续编辑'
  );
}
function showClaudeMore(id, node) {
  const row = subscriptions.find((entry) => entry.id === id);
  openActionMenu(node, `<div class="property-list"><div class="property-row"><span>租户</span><strong>${row.tenant}</strong></div><div class="property-row"><span>归属人</span><strong>${row.owner}</strong></div><div class="property-row"><span>认证人</span><strong>${row.verifier}</strong></div></div><div class="guide-list"><div class="guide-item"><h3>运营状态</h3><p>状态变化会保留历史订单和操作记录。</p><div class="toolbar">${row.status === 'active' ? button('冻结账号', 'claude-transition', '', '', `data-id="${id}" data-status="frozen"`) + button('弃用账号', 'claude-transition', 'danger', '', `data-id="${id}" data-status="abandoned"`) : button('恢复使用', 'claude-transition', '', '', `data-id="${id}" data-status="active"`)}</div></div><div class="guide-item"><h3>付租</h3><p>先生成待付款批次，实际付款后再标记完成。</p><div class="form-footer">${button('生成付租批次', 'rental-single', '', 'orders', `data-id="${id}"`)}</div></div></div>`);
}
function addCalendarMonth(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}:\d{2})$/.exec(value || '');
  if (!match) return '';
  const [, y, m, d, time] = match;
  const [year, month, day] = [y, m, d].map(Number);
  const start = new Date(`${y}-${m}-${d}T${time}:00Z`);
  if (!Number.isFinite(start.getTime()) || start.toISOString().slice(0, 16) !== `${y}-${m}-${d}T${time}`)
    return '';
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const maxDay = new Date(Date.UTC(nextYear, nextMonth, 0)).getUTCDate();
  const target = new Date(Date.UTC(nextYear, nextMonth - 1, Math.min(day, maxDay)));
  return `${target.toISOString().slice(0, 10)}T${time}`;
}
function openRenew(id) {
  const row = subscriptions.find((entry) => entry.id === id);
  openDrawer(
    '续费订单',
    `${row.email} · 原到期 ${row.expiry}。将创建新的续费记录。`,
    `<form id="renew-form" novalidate><input type="hidden" name="subscriptionId" value="${id}" />${orderFields({ product: row.plan === 'Pro' ? 'Claude Pro' : 'Claude Max', customer: row.tenant, email: row.email, plan: row.plan, kind: '续费', payment: row.payment, start: '2026-11-03T14:30', expiry: addCalendarMonth(row.expiry), tenant: row.tenant, owner: row.owner })}</form>`,
    `<span class="footnote">演示续费不产生真实订阅变更</span>${button('取消', 'drawer-close')}<button class="button primary" form="renew-form" type="submit">核对续费订单</button>`,
    `renew:${id}`
  );
  const draft = state.drafts.get(`renew:${id}`);
  if (draft)
    Object.entries(draft).forEach(([name, value]) => {
      const control = document.getElementById(name);
      if (control) control.value = value;
    });
}
function rentalCreate(ids) {
  const rows = subscriptions.filter((row) => ids.includes(row.id));
  if (!rows.length) return;
  confirmAction(
    '生成付租批次',
    `将为 ${rows.length} 个账号生成待付款批次。此操作不代表已实际付款。`,
    () => {
      state.rentals.push({
        id: `RENT-DEMO-${String(state.rentals.length + 1).padStart(3, '0')}`,
        count: rows.length,
        ids: rows.map((row) => row.id),
        tenants: [...new Set(rows.map((row) => row.tenant))].join('、'),
        paid: false,
        notes: '待线下核对并付款'
      });
      if ($('#drawer').open) closeDrawer();
      state.claudeTab = 'rental';
      getSelection('claude').clear();
      render();
      notify('演示待付租批次已生成');
    }
  );
}
function saveOrder(form, renewal = false) {
  const v = readForm(form);
  let invalid;
  [
    'order-customer',
    'order-email',
    'order-paid',
    'order-sale',
    'order-start',
    'order-expiry'
  ].forEach((name) => {
    const message = !v[name]?.trim() ? '请填写此项资料' : '';
    setError(name, message);
    if (message) invalid ||= name;
  });
  for (const name of ['order-paid', 'order-sale']) {
    if (v[name] && !/^\d+(?:\.\d{1,4})?$/.test(v[name])) {
      setError(name, '请输入非负金额，最多四位小数');
      invalid ||= name;
    }
  }
  if (!productPlans[v['order-product']]?.includes(v['order-plan'])) {
    setError('order-plan', '套餐与产品不匹配');
    invalid ||= 'order-plan';
  }
  if (v['order-start'] && v['order-expiry'] && v['order-expiry'] <= v['order-start']) {
    setError('order-expiry', '到期时间必须晚于订阅时间');
    invalid ||= 'order-expiry';
  }
  if (invalid) {
    document.getElementById(invalid).focus();
    return;
  }
  confirmAction(
    renewal ? '确认创建续费订单' : '确认登记演示订单',
    `${v['order-email']} · ${v['order-plan']}，到期 ${v['order-expiry'].replace('T', ' ')}。原型不执行付款，利润待实际汇率核算。`,
    () => {
      const sourceId = v.sourceOrderId;
      const sourceOrder = state.demoOrders.find((order) => order.id === sourceId);
      const savedOrder = {
        id: sourceOrder?.id || `ORDER-DEMO-${state.demoOrders.length + 1}`,
        product: v['order-product'],
        email: v['order-email'],
        plan: v['order-plan'],
        status: '演示已登记',
        profit: '待核算'
      };
      if (sourceOrder) Object.assign(sourceOrder, savedOrder);
      else state.demoOrders.push(savedOrder);
      if (renewal) {
        const row = subscriptions.find((entry) => entry.id === v.subscriptionId);
        row.expiry = v['order-expiry'].replace('T', ' ');
        row.history.push({ title: '续费', detail: `演示续费至 ${row.expiry}，历史订单保留` });
        state.drafts.delete(state.drawerContext);
        $('#drawer').close();
        state.drawerContext = '';
      } else {
        state.drafts.delete('order-page');
        form.reset();
      }
      render();
      notify(renewal ? '演示续费订单已登记' : '演示订单已登记，利润仍待核算');
    }
  );
}
document.addEventListener('pointerover', (event) => {
  const target = event.target.closest('[data-table-value-preview]');
  if (!target || target.contains(event.relatedTarget)) return;
  const text = target.querySelector('.table-value-ellipsis') || target;
  // Use the displayed text so previews respect the column's formatting and masking.
  if (text.scrollWidth > text.clientWidth) target.title = text.textContent.trim();
  else target.removeAttribute('title');
});

document.addEventListener('click', async (event) => {
  const navigationLink = event.target.closest('a[href^="#/"]');
  if (navigationLink && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    const destination = navigationLink.getAttribute('href');
    designGo(destination);
    return;
  }
  const node = event.target.closest('[data-action]');
  if (!node || node.disabled) return;
  const action = node.dataset.action,
    id = node.dataset.id;
  if (action.startsWith('option-')) {
    changeOptionList(action, node);
    return;
  }
  for (const module of window.IDDesignModules) {
    if (module.onClick && (await module.onClick(action, node))) return;
  }
  if (action === 'preview-states') {
    showDesignPreviewStates();
    return;
  }
  if (action === 'preview-mode') {
    preserveMainDraft();
    state.previewMode = node.dataset.mode;
    closeDrawer();
    render();
    return;
  }
  if (action === 'preview-retry') {
    state.previewMode = 'normal';
    render();
    return;
  }
  if (action === 'goto') {
    designGo(node.dataset.route);
    return;
  }
  if (action === 'confirm-cancel') {
    pendingConfirm = null;
    $('#confirm-dialog').close();
    return;
  }
  if (action === 'confirm-accept') {
    const callback = pendingConfirm;
    pendingConfirm = null;
    $('#confirm-dialog').close();
    callback?.();
    return;
  }
  if (action === 'drawer-close') {
    dismissDrawer();
    return;
  }
  if (action === 'nav-group') {
    const group = node.dataset.group;
    if (state.expanded.has(group)) state.expanded.delete(group);
    else state.expanded.add(group);
    renderSidebar();
    return;
  }
  if (action === 'mail-tab') {
    state.mailTab = node.dataset.tab;
    state.page = 1;
    getSelection('inventory').clear();
    render();
    return;
  }
  if (action === 'mail-add') {
    editMailbox();
    return;
  }
  if (action === 'mail-edit') {
    editMailbox(id);
    return;
  }
  if (action === 'mail-more') {
    showMailboxMore(id, node);
    return;
  }
  if (action === 'mail-copy' || action === 'record-copy') {
    const row = findRecord(id);
    await copyText(`${row.email}\t${row.password}`);
    return;
  }
  if (action === 'mail-copy-selected') {
    const rows = [...getSelection('inventory')].map(findRecord).filter(Boolean);
    await copyText(rows.map((row) => `${row.email}\t${row.password}`).join('\n'));
    return;
  }
  if (action === 'mail-return-selected') {
    returnRecords([...getSelection('inventory')]);
    return;
  }
  if (action === 'record-return') {
    returnRecords([id]);
    return;
  }
  if (action === 'mail-transition') {
    const row = findRecord(id);
    const health = node.dataset.health;
    confirmAction(
      '确认变更账号状态',
      `将 ${row.email} ${health === 'dead' ? '移入死号' : health === 'unlocking' ? '移入解封中' : '恢复到原资料视图'}，使用关系和历史保留。`,
      () => {
        row.health = health;
        row.version++;
        row.history.push({ action: '账号状态变化', health });
        closeDrawer();
        render();
        notify('演示账号状态已更新');
      }
    );
    return;
  }
  if (action === 'mail-undo') {
    const row = findRecord(id);
    const undo = state.mailUndo.get(id);
    if (!undo || row.version !== undo.version) {
      notify('当前版本不支持撤回，请重新核对资料');
      return;
    }
    confirmAction('撤回最近修改', '仅恢复本次修改前的资料值，保留操作记录。', () => {
      const version = row.version + 1;
      const history = [...row.history, { action: '撤回修改' }];
      Object.assign(row, undo.snapshot, { version, history });
      state.mailUndo.delete(id);
      closeDrawer();
      render();
      notify('最近一次演示修改已撤回');
    });
    return;
  }
  if (action === 'mail-delete') {
    const row = findRecord(id);
    if (row.used || row.history.some((entry) => entry.action === '提取')) {
      notify('该演示资料存在使用记录，不能永久删除');
      return;
    }
    confirmAction(
      '永久删除 1 条演示资料',
      `${row.email} 将从本原型内存移除。当前未执行真实数据库删除。`,
      () => {
        const data = mailboxes.includes(row) ? mailboxes : accounts;
        data.splice(data.indexOf(row), 1);
        closeDrawer();
        render();
        notify('演示资料已删除，刷新原型可重置');
      },
      '确认删除'
    );
    return;
  }
  if (action === 'mail-import') {
    showImport();
    return;
  }
  if (action === 'column-settings') {
    showColumns(node.dataset.tableId);
    return;
  }
  if (action === 'columns-reset') {
    const tableId = node.dataset.tableId;
    state.columns.delete(tableId);
    render();
    $$('[data-column-toggle]', $('#drawer')).forEach((control) => {
      control.checked = true;
    });
    updateColumnCount(tableId);
    return;
  }
  if (action === 'table-cell-view') {
    showTableCell(node.dataset.tableId, node.dataset.column, node.dataset.rowId);
    return;
  }
  if (action === 'table-cell-copy') {
    void copyText($('#table-cell-full-value').value);
    return;
  }
  if (action === 'table-settings') {
    openDrawer(
      '本表设置',
      '配置只作用于当前数据表，邮箱分类由系统统一管理。',
      `<div class="guide-list"><div class="guide-item"><h3>国家地区</h3><p>马来西亚、美国、日本、新加坡</p></div><div class="guide-item"><h3>来源渠道</h3><p>自己注册、线上购买、客户提供</p></div><div class="guide-item"><h3>配置范围</h3><p>本原型展示设置结构；正式开发再接入配置保存与审计。</p></div></div>`,
      button('关闭', 'drawer-close')
    );
    return;
  }
  if (action === 'extract-copy') {
    const rows = extractionRows().filter((row) => getSelection('extraction').has(row.id));
    if (!rows.length) notify('请先选择资料');
    else await copyText(rows.map((row) => `${row.email}\t${row.password}`).join('\n'));
    return;
  }
  if (action === 'extract-return') {
    returnRecords([...getSelection('extraction')]);
    return;
  }
  if (action === 'claude-tab') {
    state.claudeTab = node.dataset.tab;
    state.page = 1;
    state.query = '';
    getSelection('claude').clear();
    render();
    return;
  }
  if (action === 'claude-contact') {
    const row = subscriptions.find((entry) => entry.id === id);
    openDrawer(
      '客户联系资料',
      `${row.email} · 仅演示资料`,
      `<div class="property-list">${row.contacts
        .split('\n')
        .map((line) => {
          const split = line.indexOf('：');
          return `<div class="property-row"><span>${escapeHtml(line.slice(0, split))}</span><strong>${escapeHtml(line.slice(split + 1))}</strong>${textAction('复制', 'copy-value', `data-value="${escapeHtml(line.slice(split + 1))}"`)}</div>`;
        })
        .join(
          ''
        )}</div><div class="inline-notice">${icon('info')}<span>正式系统的 WhatsApp 和 Telegram 支持跳转联系；原型不打开真实联系人。</span></div>`,
      button('关闭', 'drawer-close')
    );
    return;
  }
  if (action === 'copy-value') {
    await copyText(node.dataset.value);
    return;
  }
  if (action === 'claude-more') {
    showClaudeMore(id, node);
    return;
  }
  if (action === 'claude-history') {
    const row = subscriptions.find((entry) => entry.id === id);
    openDrawer(
      '操作记录',
      row.email,
      `<ul class="timeline">${[...row.history]
        .reverse()
        .map(
          (entry) =>
            `<li><div><strong>${escapeHtml(entry.title)}</strong><p>${escapeHtml(entry.detail)}</p></div></li>`
        )
        .join('')}</ul>`,
      button('关闭', 'drawer-close')
    );
    return;
  }
  if (action === 'claude-transition') {
    const row = subscriptions.find((entry) => entry.id === id);
    const status = node.dataset.status;
    const label = { active: '恢复使用', frozen: '冻结', abandoned: '弃用' }[status];
    confirmAction(`确认${label}账号`, `${row.email} 的历史订单、费用和订阅记录将保留。`, () => {
      row.status = status;
      row.history.push({ title: label, detail: '2026-11-03 10:30 · 演示状态变更，无实际订阅操作' });
      closeDrawer();
      render();
      notify('演示运营状态已更新');
    });
    return;
  }
  if (action === 'claude-renew') {
    openRenew(id);
    return;
  }
  if (action === 'claude-settings') {
    openDrawer(
      'Claude 运营设置',
      '按表配置显示内容和运营规则。',
      `${field('养号阈值', 'claude-hours', input('claude-hours', '72', 'type="number" min="1"'), false, '小时。原型仅展示输入样式，未保存业务配置。')}<div class="side-note">套餐为 Pro、Max 5x、Max 20x。租户、归属人和认证人分别记录。</div>`,
      button('关闭', 'drawer-close')
    );
    return;
  }
  if (action === 'clear-selection') {
    getSelection(node.dataset.scope).clear();
    render();
    return;
  }
  if (action === 'rental-create') {
    rentalCreate([...getSelection('claude')]);
    return;
  }
  if (action === 'rental-single') {
    rentalCreate([id]);
    return;
  }
  if (action === 'rental-copy') {
    const batch = state.rentals.find((entry) => entry.id === id);
    await copyText(
      `${batch.id}\n${subscriptions
        .filter((row) => batch.ids.includes(row.id))
        .map((row) => `${row.tenant}\t${row.email}\t${row.plan}\t${row.expiry}`)
        .join('\n')}`
    );
    return;
  }
  if (action === 'rental-paid') {
    openDrawer(
      '标记付款完毕',
      '仅登记线下付款结果，不执行任何转账。',
      `<form id="rental-form"><input type="hidden" name="batchId" value="${id}" />${field('付款备注', 'rental-notes', '<textarea id="rental-notes" name="rental-notes" rows="4" placeholder="记录线下付款情况"></textarea>', true)}</form>`,
      button('取消', 'drawer-close') +
        '<button class="button primary" type="submit" form="rental-form">核对付款登记</button>'
    );
    return;
  }
  if (action === 'rental-note') {
    const batch = state.rentals.find((entry) => entry.id === id);
    openDrawer(
      '付租批次备注',
      batch.id,
      `<p>${escapeHtml(batch.notes)}</p>`,
      button('关闭', 'drawer-close')
    );
    return;
  }
  if (action === 'order-complete') {
    const order = state.demoOrders.find((entry) => entry.id === id);
    state.drafts.set('order-page', {
      product: 'GPT',
      email: order.email,
      plan: order.plan,
      sourceOrderId: order.id
    });
    location.hash = '/workspace/order/gpt';
    return;
  }
  if (action === 'personal-tool-manage') {
    showPersonalToolManager();
    return;
  }
  if (action === 'personal-tool-retry') {
    const panel = $('#personal-tool-load');
    void withActionFeedback(node, async () => { await localToolbox.load({ refresh: true }); return true; },
        { pending: '正在读取个人工具…', success: '个人工具已重新读取', failure: '个人工具读取失败，请重试' })
      .finally(() => {
        if (panel?.isConnected && $('#drawer').open) showTools('个人工具');
      })
      .catch(() => {});
    showTools('个人工具');
    return;
  }
  if (action === 'personal-tool-review') {
    await reviewPersonalTool($('#personal-tool-form'));
    return;
  }
  if (action === 'personal-tool-back') {
    showTools('个人工具');
    return;
  }
  if (action === 'personal-tool-add') {
    editPersonalTool();
    return;
  }
  if (action === 'personal-tool-edit') {
    editPersonalTool(id);
    return;
  }
  if (action === 'personal-tool-move') {
    const rows = personalToolRows(),
      index = rows.findIndex((tool) => tool.id === id),
      offset = Number(node.dataset.offset);
    if (index < 0 || index + offset < 0 || index + offset >= rows.length) return;
    const version = localToolbox?.current()?.version;
    confirmAction(
      '调整工具顺序',
      `将“${rows[index].name}”${offset < 0 ? '上移' : '下移'}一位。`,
      () => {
        void changePersonalTools(
          version,
          (next) => {
            const [tool] = next.splice(index, 1);
            next.splice(index + offset, 0, tool);
          },
          '调整个人工具顺序'
        );
      }
    );
    return;
  }
  if (action === 'personal-tool-remove') {
    const tool = personalToolRows().find((item) => item.id === id);
    if (!tool) return;
    const version = localToolbox?.current()?.version;
    confirmAction('删除个人工具', `移除个人入口“${tool.name}”。`, () => {
      void changePersonalTools(
        version,
        (rows) => {
          const index = rows.findIndex((row) => row.id === id);
          if (index < 0) throw new Error('这个个人工具已移除。');
          rows.splice(index, 1);
        },
        '移除个人工具'
      );
    });
    return;
  }
  if (action === 'tools-open') {
    showTools(node.dataset.tab);
    return;
  }
  if (action === 'tool-open') {
    if (state.toolsTab === '话术文案') {
      await copyText(node.dataset.caption);
      return;
    }
    openDrawer(
      node.dataset.name,
      [node.dataset.caption, '当前为页面结构预览。'].filter(Boolean).join(' '),
      `<div class="inline-notice">${icon('info')}<span>演示原型未连接此工具，不会读取真实资料或执行外部操作。</span></div>`,
      button('返回在线工具', 'tools-back')
    );
    return;
  }
  if (action === 'tools-back') {
    showTools();
    return;
  }
  if (action === 'design-guide') {
    openDrawer(
      '设计交付说明',
      '先完成页面设计与操作路径，再进入真实业务开发。',
      '<div class="guide-list"><div class="guide-item"><h3>页面与流程</h3><p>库存、提取归还与批次、客户租户、订单和续费退款、Claude 运营、比特任务资源及设置。明确占位的页面保留位置。</p></div><div class="guide-item"><h3>演示边界</h3><p>全部资料为虚构内存数据。刷新重置，不连接 API、数据库、支付、邮箱或外部同步。</p></div><div class="guide-item"><h3>正式开发</h3><p>先确认页面，再按统一组件、库存、客户订单、Claude 运营、统计与比特接入、迁移核验的顺序实施。</p></div></div>',
      button('关闭', 'drawer-close')
    );
  }
});

document.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  for (const module of window.IDDesignModules) {
    if (module.onSubmit && (await module.onSubmit(form))) return;
  }
  if (form.id === 'personal-tool-form') savePersonalTool(form);
  else if (form.id === 'mail-form') saveMailbox(form);
  else if (form.id === 'extraction-form') submitExtraction(form);
  else if (form.id === 'return-form') submitReturn(form);
  else if (form.id === 'import-form') validateImport(form);
  else if (form.id === 'order-form') {
    preserveMainDraft();
    saveOrder(form);
  } else if (form.id === 'renew-form') saveOrder(form, true);
  else if (form.id === 'rental-form') {
    const v = readForm(form);
    if (!v['rental-notes'].trim()) {
      setError('rental-notes', '请填写付款备注');
      $('#rental-notes').focus();
      return;
    }
    confirmAction('确认登记付款完毕', '请确认线下付款已完成。本原型只演示登记状态。', () => {
      const batch = state.rentals.find((entry) => entry.id === v.batchId);
      batch.paid = true;
      batch.notes = v['rental-notes'];
      closeDrawer();
      render();
      notify('演示付款记录已登记');
    });
  }
});
document.addEventListener('change', async (event) => {
  const node = event.target;
  for (const module of window.IDDesignModules) {
    if (module.onChange && (await module.onChange(node))) return;
  }
  if (node.dataset.select) {
    const selection = getSelection(node.dataset.select);
    if (node.checked) selection.add(node.dataset.id);
    else selection.delete(node.dataset.id);
    render();
  } else if (node.dataset.selectAll) {
    const rows = $$('tbody tr[data-row-id]', node.closest('table'));
    const selection = getSelection(node.dataset.selectAll);
    rows.forEach((row) => {
      if (node.checked) selection.add(row.dataset.rowId);
      else selection.delete(row.dataset.rowId);
    });
    render();
  } else if (node.dataset.columnToggle) {
    const tableId = node.dataset.columnToggle;
    const column = columnDefinitions[tableId]?.find((entry) => entry.id === node.dataset.column);
    if (!column || fixedTableColumn(column)) return;
    const hidden = state.columns.get(tableId) || new Set();
    if (node.checked) hidden.delete(node.dataset.column);
    else hidden.add(node.dataset.column);
    state.columns.set(tableId, hidden);
    render();
    updateColumnCount(tableId);
  } else if (node.id === 'order-product') {
    const plan = $('#order-plan');
    plan.innerHTML = options(productPlans[node.value], productPlans[node.value][0]);
  } else if (node.id === 'mail-type') {
    preserveDrawerDraft();
    editMailbox($('input[name="recordId"]', $('#drawer'))?.value || '');
  } else if (node.id === 'country-filter') {
    state.country = node.value;
    state.page = 1;
    render();
  } else if (node.id === 'status-filter') {
    state.status = node.value;
    state.page = 1;
    render();
  } else if (node.id === 'import-file') {
    const file = node.files[0];
    if (!file) return;
    if (file.size > 1024 * 1024) {
      notify('演示导入文件请控制在 1MB 以内');
      return;
    }
    $('#import-content').value = await file.text();
  } else if (node.id === 'recharge-currency') {
    preserveMainDraft();
    render();
  } else if (node.id === 'order-start' && $('#order-kind')?.value !== '续费') {
    $('#order-expiry').value = addCalendarMonth(node.value);
  }
});
document.addEventListener('input', (event) => {
  const node = event.target;
  for (const module of window.IDDesignModules) {
    if (module.onInput && module.onInput(node)) return;
  }
  if (node.id === 'personal-tool-search') {
    state.personalToolQuery = node.value;
    $('#personal-tool-results').innerHTML = personalToolTiles();
  }
  if (node.id === 'list-search') {
    state.query = node.value;
    state.page = 1;
    const cursor = node.selectionStart;
    render();
    const search = $('#list-search');
    search.focus();
    search.setSelectionRange(cursor, cursor);
  }
  if (node.closest('#drawer') && state.drawerContext) preserveDrawerDraft();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    const dropdowns = $$('details[data-dismiss-outside][open]');
    if (dropdowns.length) event.preventDefault();
    for (const dropdown of dropdowns) {
      const restoreFocus = dropdown.contains(document.activeElement);
      dropdown.open = false;
      if (restoreFocus) $('summary', dropdown)?.focus({ preventScroll: true });
    }
  }
  if (event.key === 'Enter' && event.target.matches('[data-option-input]')) {
    event.preventDefault();
    changeOptionList('option-add', event.target);
    return;
  }

});
// Only floating selectors dismiss outside; in-page disclosure sections remain expanded.
document.addEventListener('pointerdown', (event) => {
  for (const dropdown of $$('details[data-dismiss-outside][open]'))
    if (!event.composedPath().includes(dropdown)) dropdown.open = false;
});
function dismissOnBackdrop(dialog, dismiss) {
  let beganOutside = false;
  const outside = (event) => {
    const bounds = dialog.getBoundingClientRect();
    return event.target === dialog &&
      (event.clientX < bounds.left || event.clientX > bounds.right ||
       event.clientY < bounds.top || event.clientY > bounds.bottom);
  };
  dialog.addEventListener('pointerdown', (event) => {
    beganOutside = event.button === 0 && outside(event);
  });
  dialog.addEventListener('pointercancel', () => { beganOutside = false; });
  dialog.addEventListener('click', (event) => {
    const shouldDismiss = beganOutside && outside(event);
    beganOutside = false;
    if (shouldDismiss) dismiss();
  });
}
dismissOnBackdrop($('#drawer'), dismissDrawer);
dismissOnBackdrop($('#confirm-dialog'), () => {
  pendingConfirm = null;
  $('#confirm-dialog').close();
});
$('#drawer').addEventListener('cancel', (event) => {
  event.preventDefault();
  dismissDrawer();
});
$('#confirm-dialog').addEventListener('cancel', () => {
  pendingConfirm = null;
});
$('#nav-toggle').innerHTML = icon('menu');
$('#theme-toggle').innerHTML = icon('moon');
$('#theme-toggle').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme !== 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('#theme-toggle').innerHTML = icon(dark ? 'sun' : 'moon');
  $('#theme-toggle').setAttribute('aria-label', dark ? '切换为浅色主题' : '切换为深色主题');
});
$('#nav-toggle').addEventListener('click', () => {
  if (window.innerWidth <= 900) {
    document.body.classList.toggle('nav-open');
    $('#sidebar-shade').hidden = !document.body.classList.contains('nav-open');
  } else {
    state.collapsed = !state.collapsed;
    document.body.classList.toggle('is-collapsed', state.collapsed);
  }
  $('#nav-toggle').setAttribute(
    'aria-expanded',
    String(
      window.innerWidth <= 900 ? document.body.classList.contains('nav-open') : !state.collapsed
    )
  );
});
$('#sidebar-shade').addEventListener('click', () => {
  document.body.classList.remove('nav-open');
  $('#sidebar-shade').hidden = true;
  $('#nav-toggle').setAttribute('aria-expanded', 'false');
  $('#nav-toggle').focus({ preventScroll: true });
});
if (window.IDLocalData) {
  const profile = $('#profile-button');
  profile.setAttribute(
    'aria-label',
    window.IDLocalData.authRequired ? '查看我的账号' : '查看本机操作员'
  );
  $('.avatar', profile).textContent = Array.from(state.actor.name)[0] || '本';
  $('.profile-name', profile).textContent = state.actor.name;
  $('[data-action="preview-states"]').hidden = true;
}
$('#profile-button').addEventListener('click', () => {
  if (window.IDLocalData?.authRequired && window.IDLocalAuth?.openProfile) {
    window.IDLocalAuth.openProfile();
    return;
  }
  openDrawer(
    window.IDLocalData ? '本机操作员' : '演示账户',
    window.IDLocalData ? '' : '林管理员 · 页面设计预览',
    window.IDLocalData
      ? '<div class="side-note">当前操作记录使用本机操作员身份。员工登录和角色权限待接入。</div>'
      : `<div class="side-note">此身份为虚构示例，不代表当前系统登录用户，也不会读取身份或权限资料。</div><div class="form-footer">${button('查看页面状态', 'preview-states', '', 'info')}</div>`,
    button('关闭', 'drawer-close')
  );
});
window.addEventListener('hashchange', navigate);
window.addEventListener('popstate', navigate);
window.addEventListener('resize', () => {
  if (window.innerWidth > 900) {
    document.body.classList.remove('nav-open');
    $('#sidebar-shade').hidden = true;
  }
});
let designIdCounter = 0;
function designGo(route) {
  const target = '#/' + String(route).replace(/^#?\/?/, '');
  if (
    window.IDDesignAPI.modules.operations?.blockRechargeNavigation({
      quiet: location.hash === target
    })
  )
    return;
  if (location.hash !== target) history.pushState(null, '', target);
  navigate();
}
function showDesignPreviewStates() {
  const modes = [
    ['normal', '正常内容'],
    ['loading', '首次加载'],
    ['refresh', '保留内容刷新'],
    ['error', '首次读取失败'],
    ['refresh-error', '刷新失败保留内容'],
    ['empty', '空数据'],
    ['permission', '无权限']
  ];
  openDrawer(
    '查看页面状态',
    '这是设计原型的状态切换，不发送网络请求。实际业务接入后由统一查询层驱动。',
    `<div class="guide-list">${modes.map(([mode, label]) => button(label, 'preview-mode', state.previewMode === mode ? 'primary' : '', '', `data-mode="${mode}"`)).join('')}</div>`,
    button('关闭', 'drawer-close')
  );
}
function applyDesignPreviewState() {
  const region = activePageRegion();
  region.querySelector(':scope > [data-preview-feedback]')?.remove();
  const mode = state.previewMode;
  if (mode === 'normal') return;
  if (mode === 'refresh' || mode === 'refresh-error') {
    const feedback = document.createElement('div');
    feedback.dataset.previewFeedback = '';
    feedback.className = mode === 'refresh' ? 'design-region-progress' : 'inline-notice warning';
    feedback.setAttribute('role', 'status');
    feedback.innerHTML =
      mode === 'refresh'
        ? `<span>正在刷新，保留当前内容</span>${button('结束预览', 'preview-retry', 'compact')}`
        : `${icon('info')}<span>刷新失败，已保留最后内容和当前输入。</span>${button('重试', 'preview-retry', 'compact')}`;
    region.prepend(feedback);
    region.setAttribute('aria-busy', String(mode === 'refresh'));
    return;
  }
  if (mode === 'loading') {
    region.setAttribute('aria-busy', 'true');
    region.innerHTML = `<section class="panel design-state-panel" role="status"><div class="panel-heading"><h2>正在读取页面资料</h2>${button('结束预览', 'preview-retry', 'compact')}</div><div class="design-loading-rows" aria-hidden="true">${Array.from({ length: 7 }, () => '<div class="design-loading-row"></div>').join('')}</div></section>`;
  } else {
    const labels = {
      error: ['暂时无法读取资料', '请检查连接后重试，当前输入已保留。'],
      empty: ['还没有符合条件的资料', '可以调整筛选条件或新增资料。'],
      permission: ['当前账户没有访问权限', '请由具备该模块权限的账户处理。']
    };
    const [title, description] = labels[mode];
    region.innerHTML = `<section class="panel design-state-panel">${empty(title, description)}<div class="design-state-actions">${button(mode === 'error' ? '重试' : '返回正常预览', 'preview-retry', 'primary')}</div></section>`;
  }
}
function designUnits(value, scale = 4) {
  const text = String(value ?? '').trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) throw new Error('金额格式不正确');
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace(/^-/, '').split('.');
  if (fraction.length > scale) throw new Error('金额小数位过长');
  const result = BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0') || '0');
  return negative ? -result : result;
}
function designFormatUnits(value, scale = 4) {
  const units = BigInt(value);
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const base = 10n ** BigInt(scale);
  return `${negative ? '-' : ''}${absolute / base}${scale ? '.' + String(absolute % base).padStart(scale, '0') : ''}`;
}
function roundedDivision(numerator, denominator) {
  if (!denominator) throw new Error('汇率不能为零');
  const negative = numerator < 0n !== denominator < 0n;
  const a = numerator < 0n ? -numerator : numerator;
  const b = denominator < 0n ? -denominator : denominator;
  const result = (a + b / 2n) / b;
  return negative ? -result : result;
}
window.IDDesignAPI = {
  beginRegionRead,
  finishRegionRead,
  activePageRegion,
  clearPageRegions,
  restorePendingPageScroll,
  $,
  $$,
  esc: escapeHtml,
  icon,
  button,
  tag,
  textAction,
  openActionMenu,
  options,
  field,
  input,
  select,
  header,
  gptOrderSyncRoute,
  gptOrderTabs,
  summary,
  empty,
  table,
  pagination,
  pageRows,
  titleInfo,
  state,
  collections: { mailboxes, accounts, subscriptions },
  getSelection,
  notify,
  beginActionFeedback,
  withActionFeedback,
  completeAction,
  setError,
  readForm,
  optionListEditor,
  readOptionList,
  optionListPending,
  readDraft,
  confirmAction,
  openDrawer,
  closeDrawer,
  openToolboxPanel,
  refreshToolbox: () => {
    if ($('#drawer[open]')?.dataset.layout === 'workspace-tools') showTools(state.toolsTab);
  },
  copyText,
  render,
  navigate,
  go: designGo,
  addCalendarMonth,
  nowText: () => '2026-11-03 10:30',
  newId: (prefix = 'record') => `${prefix}-demo-${Date.now()}-${++designIdCounter}`,
  modules: {},
  navigation,
  canVisit: permittedRoute,
  compactListToolbars,
  legacy: {
    editMailbox,
    showImport,
    parseCsv,
    findRecord,
    renderMailbox,
    showTools,
    renderClaude,
    renderOrder,
    orderFields,
    showPersonalToolManager
  },
  money: {
    units: designUnits,
    formatUnits: designFormatUnits,
    normalize: (value) => designFormatUnits(designUnits(value)),
    add: (a, b) => designFormatUnits(designUnits(a) + designUnits(b)),
    subtract: (a, b) => designFormatUnits(designUnits(a) - designUnits(b)),
    compare: (a, b) =>
      designUnits(a) < designUnits(b) ? -1 : designUnits(a) > designUnits(b) ? 1 : 0,
    convert: (amount, rate) =>
      designFormatUnits(roundedDivision(designUnits(amount) * designUnits(rate, 8), 100000000n)),
    multiply: (a, b) => designFormatUnits(roundedDivision(designUnits(a) * designUnits(b), 10000n)),
    divide: (amount, rate) =>
      designFormatUnits(roundedDivision(designUnits(amount) * 100000000n, designUnits(rate, 8)))
  }
};
window.addEventListener(
  'DOMContentLoaded',
  () => {
    navigate();
    if (new URLSearchParams(window.location.search).get('panel') === 'tools') showTools();
  },
  { once: true }
);
