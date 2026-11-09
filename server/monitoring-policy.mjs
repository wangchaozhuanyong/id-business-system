const minute = 60_000;
export const monitorChannels = {
  security: '安全管理员',
  operations: '运维接收人',
  rechargeAdmin: '代充管理员',
  rechargeGroup: '代充群组'
};

const rule = (label, category, priority, channel, { failures = 1, oneShot = false, enabled = true } = {}) =>
  Object.freeze({ label, category, priority, channel, failures, oneShot, enabled });

export const monitorRules = Object.freeze({
  public_site: rule('网站或核心服务不可用', '运行', 'P0', 'operations', { failures: 3 }),
  external_probe: rule('站外探针失联', '运行', 'P1', 'operations'),
  tls_expiry: rule('网站证书临近到期', '运行', 'P1', 'operations'),
  api_errors: rule('业务接口错误率过高', '运行', 'P1', 'operations', { failures: 2 }),
  disk_space: rule('业务磁盘可用空间不足', '运行', 'P1', 'operations', { failures: 2 }),
  login_abuse: rule('异常登录尝试', '安全', 'P1', 'security'),
  admin_access: rule('员工权限或凭据已变更', '安全', 'P1', 'security', { oneShot: true }),
  sensitive_reads: rule('敏感资料读取量异常', '安全', 'P1', 'security', { failures: 2 }),
  channel_change: rule('监控接收人或规则已变更', '安全', 'P1', 'security', { oneShot: true }),
  recharge_runtime: rule('代充执行器不可用', '代充', 'P1', 'operations', { failures: 3 }),
  recharge_review: rule('代充付款待核实', '代充', 'P1', 'recharge'),
  recharge_stuck: rule('代充任务长时间未结束', '代充', 'P1', 'recharge', { failures: 2 }),
  recharge_burst: rule('代充明确失败集中出现', '代充', 'P1', 'recharge'),
  recharge_success: rule('代充已确认成功', '代充', 'P2', 'legacy', { oneShot: true, enabled: false }),
  recharge_failure: rule('代充明确失败', '代充', 'P1', 'legacy', { oneShot: true, enabled: false }),
  recharge_cards: rule('代充因卡池无可用资源被拒绝', '代充', 'P1', 'legacy', { oneShot: true, enabled: false }),
  recharge_route: rule('代充因套餐支付线路不可用被拒绝', '代充', 'P1', 'recharge', { oneShot: true }),
  payment_duplicate: rule('已核实重复扣款', '代充', 'P0', 'security', { oneShot: true }),
  security_confirmed: rule('已核实安全事件', '安全', 'P0', 'security', { oneShot: true }),
  order_sync: rule('代充订单同步连续失败', '后台任务', 'P1', 'operations'),
  exchange_rates: rule('汇率采集连续失败', '后台任务', 'P1', 'operations'),
  mailbox: rule('邮箱查询服务连续异常', '后台任务', 'P1', 'operations'),
  backup: rule('备份校验失败或回执超期', '后台任务', 'P1', 'operations'),
  sheets: rule('Google 表格同步连续失败', '后台任务', 'P1', 'operations'),
  digest: rule('监控与代充日报', '摘要', 'P2', 'operations', { oneShot: true, enabled: false })
});

export const legacyRules = ['recharge_success', 'recharge_failure', 'recharge_cards'];
export const taskMonitorRules = new Set(['recharge_review', 'recharge_stuck', 'recharge_success', 'recharge_failure']);
export const readyPath = '/health/ready';
export const monitorPath = '/api/local/system-monitoring';
export const monitorReportPath = '/api/monitoring/site-probe';
export const monitorConfigDomain = 'system-monitoring-config';
export const monitorStateDomain = 'system-monitoring-state';
export const scopePattern = /^[a-zA-Z0-9_-]{1,80}$/;
export const botTokenPattern = /^\d{5,20}:[a-zA-Z0-9_-]{20,100}$/;
export const chatIdPattern = /^-?[1-9]\d{0,18}$/;
export const beijingDay = (at) => new Date(at + 8 * 60 * minute).toISOString().slice(0, 10);
const beijingTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium', hourCycle: 'h23'
});
const observationLabels = {
  tls_expiry: '证书剩余天数', api_errors: '接口 5xx 次数', disk_space: '磁盘可用比例',
  login_abuse: '异常尝试次数', sensitive_reads: '敏感资料读取次数', recharge_burst: '明确失败任务数',
  recharge_cards: '卡池拒绝次数', recharge_route: '线路拒绝次数', mailbox: '服务端错误次数',
  backup: '连续失败次数', sheets: '连续失败次数', order_sync: '连续失败次数', exchange_rates: '连续失败次数'
};

export function monitoringError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function initialMonitoringConfig() {
  return {
    enabled: false,
    token: '',
    channels: {},
    rules: Object.fromEntries(Object.entries(monitorRules).map(([code, value]) => [code, value.enabled])),
    legacy: { phase: 'native', recipients: [] },
    bindings: {}
  };
}

export function boundedCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 ? value : null;
}

export function telegramText(item, origin) {
  const { code, kind, at, scope, count, summary } = item;
  if (kind === 'test') return '【ID 业务管理系统】Telegram 渠道测试。此消息不对应真实告警。';
  const { priority, label } = monitorRules[code];
  const prefix = kind === 'recovered' ? '已恢复' : priority === 'P0' ? '紧急' : priority === 'P1' ? '告警' : '摘要';
  const details = summary ? ['成功 ' + summary.success + ' · 失败 ' + summary.failure +
    ' · 待核实 ' + summary.review + ' · 未恢复告警 ' + summary.open] : [];
  if (taskMonitorRules.has(code) && scopePattern.test(scope))
    details.push('任务尾号 ' + scope.slice(-6));
  if (count !== null && count !== undefined)
    details.push((observationLabels[code] || '本次观测') + ' ' + count + (code === 'disk_space' ? '%' : ''));
  if (code === 'recharge_review') details.push('请核对原任务回执，切勿重复充值。');
  return ['【ID 业务管理系统 · ' + prefix + '】' + label, '北京时间 ' + beijingTime.format(at), ...details,
    '事件编号 ' + item.incidentId, ...(origin ? ['查看监控中心 ' + origin + '/#/monitor'] : [])].join('\n');
}

export async function sendTelegram({ token, chatId, text, fetchImpl = fetch }) {
  if (!botTokenPattern.test(token) || !chatIdPattern.test(chatId)) return { status: 'failed', reason: 'configuration' };
  try {
    const response = await fetchImpl('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(6000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, protect_content: true, link_preview_options: { is_disabled: true } })
    });
    let result;
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body || []) {
        bytes += chunk.byteLength;
        if (bytes > 8192) break;
        chunks.push(chunk);
      }
      if (bytes <= 8192) result = JSON.parse(Buffer.concat(chunks));
    } catch { /* The Telegram response may be incomplete. */ }
    if (response.ok && result?.ok === true && Number.isSafeInteger(result.result?.message_id) &&
        result.result.message_id > 0 && String(result.result.chat?.id) === chatId)
      return { status: 'accepted', messageId: result.result.message_id };
    if (response.status === 429) {
      const seconds = Number(result?.parameters?.retry_after ?? response.headers.get('retry-after'));
      return { status: 'retry', delay: Math.max(1, Number.isSafeInteger(seconds) ? seconds : 60) * 1000 };
    }
    if (response.status >= 400 && response.status < 500) return { status: 'failed', reason: 'rejected' };
  } catch { /* A network timeout may occur after Telegram accepted the message. */ }
  return { status: 'unknown', reason: 'unconfirmed' };
}
