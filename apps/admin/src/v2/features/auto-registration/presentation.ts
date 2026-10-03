import type { V2RegistrationJob, V2RegistrationMailboxStartBlockedReason } from './contracts';
import type { RegistrationLaunch } from './api';
export const mailboxBlockedReasons: Record<V2RegistrationMailboxStartBlockedReason, string> = {
  registered: '该邮箱已注册',
  mailbox_disabled: '邮箱已停用，请先在邮件验证码查询中启用',
  authorization_invalid: '邮箱查询授权已失效，请先更新授权',
  primary_unavailable: '所属主邮箱不可用，请先核对主邮箱',
  unfinished_task: '该邮箱有未结束任务，请先继续或取消原任务'
};
export function requireRegistrationAccepted(response: RegistrationLaunch) {
  if (response.delivery === 'accepted') return;
  throw new Error(
    (response.reason && registrationReasons[response.reason]) ||
      (response.delivery === 'not_received'
        ? '内置浏览器未接收任务，请从原任务重试'
        : response.delivery === 'rejected'
          ? '执行器拒绝启动，请先处理原任务'
          : '任务接收结果暂不明确，请核对原任务，避免重复注册')
  );
}
export const stateLabels: Record<V2RegistrationJob['state'], string> = {
  queued: '等待开始',
  running: '正在执行',
  awaiting_email: '等待邮件验证',
  awaiting_user: '等待本人处理',
  partial: '待继续',
  completed: '注册与安全配置完成',
  cancelled: '已取消'
};
export { V2_REGISTRATION_STEP_LABELS as stepLabels } from '@apple-business/shared';
export const registrationReasons: Record<string, string> = {
  existing_account_requires_review: '官网显示已有账号或已有密码，请人工核对后使用账号管理。',
  verification_required: '请在原浏览器窗口完成本人验证，再点击继续。',
  form_unrecognized: '官网页面暂时无法识别，请在原窗口核对。',
  mailbox_timeout: '未收到本步骤的邮件，请核对邮箱或手动输入。',
  official_login_not_verified: '尚未核实官网登录邮箱，请在原窗口完成登录。',
  password_unverified: '密码设置尚未核实，请保留原窗口继续。',
  mfa_unverified: '双重验证尚未核实，请保留原窗口继续。',
  offer_unverified: '优惠资格待核实，可在账号编辑中人工标记。',
  fingerprint_engine_unavailable: '系统指纹浏览器尚未安装，请联系管理员更新执行器。',
  fingerprint_start_timeout: '指纹浏览器启动超过 30 秒，已停止，请检查执行器。',
  fingerprint_cleanup_failed: '未能确认指纹窗口已关闭，请检查执行器后再启动任务。',
  fingerprint_environment_duplicated: '本次浏览器环境与已有环境重复，已停止，请从原任务重试。',
  builtin_execution_failed: '内置浏览器执行中断，原任务检查点已保留。',
  builtin_profile_missing: '执行器重启或原窗口已关闭，请先核对官网账号，避免重复注册。',
  builtin_original_window_pending: '另一个原窗口尚未结束，请继续或取消原任务。',
  worker_busy: '执行器正在处理原任务，请先继续或取消原任务。',
  invalid_registration_payload: '执行器无法接收注册资料，请联系管理员核对版本。',
  builtin_cancel_unconfirmed: '任务授权已撤销，原窗口关闭尚未确认；请点击重试关闭。',
  builtin_task_not_received: '内置浏览器尚未接收本次任务，可以从原任务重试。',
  server_proxy_invalid: '代理资料或提取结果无效，请检查代理 IP 管理。',
  server_proxy_unavailable: '代理暂不可用，请检查提取服务和供应商。',
  proxy_resolving: '正在提取代理 IP；动态代理最多尝试 10 次。',
  proxy_verifying: '正在核实代理并打开官网，每次页面准备最多等待 20 秒。',
  proxy_retrying: '代理未能完成页面准备，正在更换 IP 和指纹窗口，最多尝试 10 次。',
  proxy_ready: '代理与官网页面准备完成，正在继续原注册任务。',
  registration_page_refreshing: '官网页面暂未就绪，正在原窗口刷新一次并重新识别。',
  proxy_retry_exhausted: '已尝试 10 次仍无法准备官网页面，任务已停止；请检查代理后重试。',
  proxy_cleanup_failed: '未能确认失败窗口已关闭，已停止换 IP；请检查执行器。',
  proxy_network_unconfirmed: '未能通过所选代理核实官网连通，请检查代理。',
  proxy_country_mismatch: '代理实际出口国家与目录资料不一致，注册已停止。',
  registration_authorization_expired: '注册任务授权已失效，请核对管理员和邮箱授权。',
  local_execution_failed: '本机执行中断，请处理原窗口后继续。',
  durable_state_unavailable: '结果暂未保存，请先恢复系统连接再继续。',
  operation_cancelled: '本次操作已取消。'
};
