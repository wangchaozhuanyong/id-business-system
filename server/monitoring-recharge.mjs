import { chatIdPattern, monitoringError, scopePattern } from './monitoring-policy.mjs';

export function createLegacyRechargeNotifications(client) {
  return {
    async read() {
      try {
        const { telegram, config, runtime, stats } = await client.readLegacyNotificationSettings();
        const switches = [telegram?.on_success, telegram?.on_failure, telegram?.on_card_pool_empty];
        const { admin_chat_id: adminChat, group_chat_id: groupChat, notify_admin: notifyAdmin,
          notify_group: notifyGroup, bot_token: maskedToken } = telegram || {};
        if (![...switches, notifyAdmin, notifyGroup, config?.maintenance_mode].every(value => typeof value === 'boolean') ||
            ![adminChat, groupChat, maskedToken].every(value => typeof value === 'string') ||
            ![runtime?.active_activation_jobs, stats?.running].every(value => Number.isSafeInteger(value) && value >= 0))
          throw new Error();
        const recipients = [
          ...(maskedToken && notifyAdmin && adminChat ? ['rechargeAdmin'] : []),
          ...(maskedToken && notifyGroup && groupChat ? ['rechargeGroup'] : [])
        ];
        if ((recipients.includes('rechargeAdmin') && !chatIdPattern.test(adminChat)) ||
            (recipients.includes('rechargeGroup') && !chatIdPattern.test(groupChat)))
          throw monitoringError(422, '原代充使用的接收编号需先核对为数字 Chat ID');
        return { snapshot: { switches, adminChat, groupChat, notifyAdmin, notifyGroup, recipients },
          idle: config.maintenance_mode && runtime.active_activation_jobs === 0 && stats.running === 0 };
      } catch (error) {
        if (error.status === 422) throw error;
        throw monitoringError(503, '无法读取原代充通知设置和任务状态');
      }
    },
    async disable(snapshot) {
      try {
        // The original API keeps the existing token when it is omitted. The
        // chat IDs and routing switches also serve native authentication.
        await client.disableLegacyBusinessNotifications(snapshot);
      } catch {
        throw monitoringError(503, '原代充关闭请求结果待核对，请刷新后继续接管');
      }
    }
  };
}

const taskTime = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/;
const minute = 60_000;
const unknownPayment = '付款结果待核实，已转人工确认，请勿重复充值，请联系客服处理。';
const cardEmptyMessages = new Set(['银行卡池暂无可用卡片，任务未启动', '银行卡池暂无可用卡片，请先在后台「银行卡池」导入银行卡后再试']);

function nativeTask(row) {
  if (typeof row?.jobKey !== 'string' || !scopePattern.test(row.jobKey) || !taskTime.test(row.time)) return null;
  const createdAt = Date.parse(row.time.replaceAll('/', '-').replace(' ', 'T') + '+08:00');
  if (!Number.isSafeInteger(createdAt)) return null;
  return { job: row.jobKey, createdAt, status: row.status, review: row.status === 'manual' && row.message === unknownPayment,
    empty: cardEmptyMessages.has(row.message) };
}

export function projectRechargeMonitoring(tasks, now, since) {
  if (!Array.isArray(tasks)) throw new Error('代充任务回执格式无效');
  const rows = tasks.map(nativeTask).filter(row => row && row.createdAt <= now);
  const recent = rows.filter(row => row.createdAt >= now - 15 * minute);
  const failures = recent.filter(row => row.status === 'failed' && !row.empty).length;
  const complete = tasks.length < 200 && rows.length === tasks.length;
  const samples = [{ code: 'recharge_burst', status: failures >= 5 ? 'bad' : complete ? 'ok' : 'unknown', count: failures,
    reason: failures < 5 && !complete ? 'tasks_incomplete' : undefined }];
  for (const row of rows) {
    if (row.review || row.status === 'success')
      samples.push({ code: 'recharge_review', scope: row.job, status: row.review ? 'bad' : 'ok' });
    if (['running', 'success', 'failed', 'manual', 'maintenance', 'card_invalid'].includes(row.status))
      samples.push({ code: 'recharge_stuck', scope: row.job,
        status: row.status === 'running' && now - row.createdAt >= 30 * minute ? 'bad' : 'ok' });
    if (since && row.createdAt > since && row.createdAt >= now - 24 * 60 * minute) {
      if (row.status === 'success' || (row.status === 'failed' && !row.empty))
        samples.push({ code: row.status === 'success' ? 'recharge_success' : 'recharge_failure',
          scope: row.job, status: 'bad', at: row.createdAt });
    }
  }
  return { samples, rows, complete };
}
