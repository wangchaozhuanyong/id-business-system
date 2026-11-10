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

// Display only fixed descriptions and bounded measurements, never upstream errors or credentials.
export const monitorCheckInfo = {
  public_site: ['网站与核心服务', '独立站外探针', '连续 3 次失败告警，连续 2 次成功恢复。', '请运维接入独立站外检测，并核对网站就绪响应。'],
  external_probe: ['站外探针', '签名检测回传', '超过 4 分钟没有回传时告警。', '请运维核对独立探针是否运行、能否回传。'],
  tls_expiry: ['网站证书', '独立站外探针', '证书剩余有效期不超过 14 天时告警。', '请运维核对证书有效期、续期任务及站外检测。'],
  api_errors: ['业务接口', '当前服务进程的请求统计', '近 10 分钟至少 50 个样本，5xx 不少于 5 次且占比至少 5%，连续 2 次观测触发。', '请运维结合异常时段核查接口错误；样本不足时保留未知。'],
  disk_space: ['业务磁盘', '业务数据所在磁盘', '可用空间低于 15%，连续 2 次观测触发。', '请运维核对可用容量及保留策略，不直接删除业务资料。'],
  login_abuse: ['登录安全', '当前服务进程的登录统计', '5 分钟内同一账号 5 次失败或限流，或合计 12 次限流。', '查看登录日志，核对异常时间与登录行为。'],
  sensitive_reads: ['敏感资料访问', '当前服务进程的受监测读取统计', '10 分钟内同一员工至少 20 次指定敏感资料读取，连续 2 次观测触发。', '查看操作记录，核对读取行为与业务用途。'],
  recharge_runtime: ['代充执行器', '原代充服务就绪检测', '连续 3 次就绪检测失败告警。', '查看代充后台状态；结果不明的付款先核对原任务。'],
  recharge_review: ['付款结果核对', '原代充近期任务回执', '仅识别原任务明确标记的付款待核实；近期记录最多 200 条。', '核对原任务和付款回执，确认前不要重复充值。'],
  recharge_stuck: ['代充任务时长', '原代充近期任务回执', '运行超过 30 分钟，连续 2 次观测触发；近期记录最多 200 条。', '查看原任务当前进度和回执，不自动重启付款。'],
  recharge_burst: ['代充失败频率', '原代充近期任务回执', '近 15 分钟至少 5 笔明确失败；近期记录最多 200 条。', '核对近期失败原因及原任务结果。'],
  order_sync: ['订单同步', '后台订单同步回执', '连续 3 次失败，或已有回执超过 10 分钟未更新。', '请运维核对订单同步任务与最近回执。'],
  exchange_rates: ['汇率采集', '汇率采集任务状态', '连续 3 次采集失败告警。', '查看汇率采集配置、最近成功时间及失败记录。'],
  mailbox: ['邮箱查询', '当前服务进程的查询统计', '近 10 分钟至少 3 次服务端错误；至少 2 次成功且无错误才显示正常。', '打开邮箱查询与邮箱池，核对连接及查询结果。'],
  backup: ['备份校验', '备份工作进程校验回执', '完整性失败、连续 3 次失败或已有回执超过 20 分钟未更新。', '请运维接入备份校验回执；未接入无法判断备份任务是否正常。'],
  sheets: ['Google 表格同步', '表格工作进程写后核对回执', '完整性失败、连续 3 次失败或已有回执超过 15 分钟未更新。', '请运维接入表格同步回执，并核对同步目标及写入结果。']
};

export const monitorReasons = {
  insufficient_requests: '近 10 分钟请求样本不足 50 个，暂不能判断错误率。',
  mailbox_samples: '近 10 分钟尚未满足正常或异常的判定条件。',
  receipt_disabled: '尚未接入专用工作进程回执，无法判断任务运行结果。',
  receipt_missing: '尚未收到有效的工作进程回执。',
  receipt_future: '回执时间超出允许范围，请核对工作进程时间。',
  receipt_stale: '最近工作进程回执已超时，请核对任务是否仍在运行。',
  integrity_failed: '最近回执报告完整性校验失败。',
  verification_missing: '已有运行回执，但尚无成功校验依据。',
  sync_disabled: '订单同步任务未启用，此项没有运行回执。',
  sync_missing: '尚未收到订单同步运行回执。',
  sync_stale: '订单同步已有回执超过 10 分钟未更新。',
  recovering: '已有失败记录，正在等待后续成功观测。',
  rates_disabled: '汇率自动采集未启用，或尚未选择采集来源。',
  rates_missing: '尚未取得成功的汇率采集记录。',
  rates_unavailable: '暂时无法读取汇率采集状态。',
  disk_unavailable: '暂时无法读取业务磁盘可用容量。',
  runtime_disabled: '尚未连接代充执行器的检测入口。',
  tasks_unavailable: '暂时无法读取有效的原代充任务回执。',
  tasks_empty: '近期没有可用于判断此项状态的任务回执。',
  tasks_incomplete: '近期任务回执不完整，无法据此确认全部任务正常。',
  probe_disabled: '独立站外探针尚未接通。',
  probe_missing: '已启用站外接入，正在等待首次有效回传。',
  probe_stale: '超过 4 分钟没有收到站外探针回传。'
};

export function monitorCheckDetail(code, status, observed, { stale = false, open = false } = {}) {
  const info = monitorCheckInfo[code];
  let detail = stale ? '最近检测结果已超过 5 分钟，请刷新或核查采集来源。'
    : observed?.reason && monitorReasons[observed.reason];
  if (!detail) detail = !observed ? '尚未取得有效检测结果。' :
    status === 'unknown' ? '当前证据不足，暂时无法判断。' :
    open && observed.status === 'ok' ? '已出现成功观测，正在等待满足恢复条件。' :
    status === 'bad' ? '已达到告警条件，请核查相关记录。' :
    status === 'watch' ? '已发现异常信号，尚未达到连续告警次数。' :
    status === 'disabled' ? '该项采集尚未启用。' : '最近有效观测未触发告警条件。';
  const count = observed?.count;
  const measurement = !stale && observed?.status !== 'disabled' && count !== null && count !== undefined && observationLabels[code]
    ? observationLabels[code] + '：' + count + (code === 'disk_space' ? '%' : '') : '';
  return { title: info[0], source: info[1], threshold: info[2], guidance: info[3], detail, measurement };
}

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
