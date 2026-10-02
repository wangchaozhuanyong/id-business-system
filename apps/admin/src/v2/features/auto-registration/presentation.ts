import type { V2RegistrationJob } from './contracts';
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
  local_execution_failed: '本机执行中断，请处理原窗口后继续。',
  durable_state_unavailable: '结果暂未保存，请先恢复系统连接再继续。',
  operation_cancelled: '本次操作已取消。'
};
