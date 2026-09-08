import type { V2RechargeJob } from './contracts';

export const planLabels = {
  plus: 'ChatGPT Plus',
  'pro-5x': 'ChatGPT Pro 5×',
  'pro-20x': 'ChatGPT Pro 20×'
};
const labels: Record<string, string> = {
  free: '免费版',
  plus: 'Plus',
  pro: 'Pro（档位待核验）',
  running: '正在执行',
  awaiting_confirmation: '等待确认金额',
  confirming: '正在提交本次付款',
  finished: '本次操作已结束',
  unknown: '结果待核验',
  session_restore: '核对官网会话',
  session_verified: '账户核对通过',
  existing_checkout_read: '读取原结算',
  plan_selection: '选择官网套餐',
  checkout_create: '准备创建官方结算',
  checkout_request_sending: '正在请求官方结算',
  checkout_wait: '等待官方结算响应',
  quote_read: '读取官方报价',
  quote_ready: '已取得官方报价',
  payment_ready: '已核价，等待确认',
  checkout_quote_verified: '官方报价已核对',
  blocked: '当前步骤未完成',
  subscription_activated: '开通成功',
  paid_pending_activation: '已付款，待开通',
  paid_tier_pending_verification: '已付款，档位待核验',
  payment_failed: '付款失败',
  payment_result_unknown: '付款结果待核验',
  verification_required: '官网要求真人验证，本次已安全停止',
  payment_cancelled: '已取消本次确认',
  payment_submitted_or_pending: '等待原单付款结果',
  paid: '已确认付款',
  declined: '官方拒付',
  requires_action: '需要本人验证',
  not_attempted: '未尝试付款',
  not_verified: '未核验',
  restored: '会话已恢复',
  json_session_not_restored: 'JSON 会话未恢复，请提供新的授权 JSON',
  official_user_mismatch: '官网用户与 JSON 不一致',
  official_account_mismatch: '官网账户与 JSON 不一致',
  invalid_json: 'JSON 格式无效',
  missing_session_token: 'JSON 缺少官网会话凭据',
  bank_card_number_invalid: '银行卡号格式无效',
  browser_operation_failed: '官网浏览器步骤未完成',
  browser_memory_exhausted: '官网浏览器内存不足，本次未创建订单或付款',
  official_upgrade_entry_not_found: '未找到官网升级入口',
  official_pricing_plan_entry_not_found: '未找到唯一的官网套餐定价入口',
  official_plus_option_not_found: '未找到官网 Plus 选项',
  official_plan_menu_timeout: '官网套餐菜单未在规定时间内加载',
  official_personal_option_not_found: '未找到可用的个人套餐切换控件',
  official_plan_tier_not_found: '未识别到所选 Pro 档位',
  official_plan_option_not_found: '未找到所选套餐的开通入口',
  official_plan_option_disabled: '官网套餐选项暂不可点击',
  official_plan_option_ambiguous: '找到多个套餐控件，无法确定目标',
  official_plan_region_ambiguous: '存在多个套餐窗口，无法确定目标',
  official_plan_selection_timeout: '选择官网套餐超时',
  official_plan_browser_error: '选择套餐时官网浏览器异常',
  selected_plan_changed: '官网选中套餐发生变化，已停止建单',
  incompatible_existing_subscription: '已有不兼容订阅',
  previous_checkout_attempt_exists: '已有原结算记录，请复查原订单',
  previous_payment_attempt_exists: '该订单已尝试付款，只允许复查',
  account_has_other_payment_attempt: '该账户已有付款尝试，请选择原套餐复查',
  payment_quote_changed: '官网金额已变化，请重新核价',
  payment_confirmation_expired: '确认已过期，请重新核价',
  network_unconfirmed: '服务器出口未确认，暂不能提交付款',
  bank_verification_required: '需要本人完成银行验证',
  quote_needs_review_or_billing: '官网初始总额或预估税费未完整读取，本次未付款',
  actual_quote_unknown: '无法明确读取今日应付',
  no_original_payment_attempt: '没有已尝试付款的原单',
  worker_operation_failed: '服务器执行步骤未完成',
  durable_state_unavailable: '记录服务未确认，已阻止重复请求',
  operation_cancelled: '操作已取消',
  http_error: '官网拒绝当前请求，本次已安全停止'
};
export const selectionStepLabels = {
  open_menu: '打开套餐菜单',
  pricing_page: '进入官网套餐定价页',
  personal_plans: '切换个人套餐',
  choose_tier: '选择 Pro 档位',
  choose_plan: '核对开通按钮',
  verify_plan: '再次核对套餐'
};
export function quotePlaceholder(job: V2RechargeJob): string {
  if (job.result.quote) return '未知';
  if (job.action === 'check') return '待获取报价';
  if (job.action === 'quote' && job.state === 'running') return '正在获取报价';
  if (job.action === 'quote' && job.state === 'finished' && job.result.reason) return '获取失败';
  if (job.state === 'unknown') return '报价结果待核验';
  return '待获取报价';
}
export function subscriptionLabel(job: V2RechargeJob): string {
  const result = job.result;
  if (result.payment_outcome || result.subscription_status)
    return statusLabel(result.payment_outcome || result.subscription_status);
  if (
    job.state === 'unknown' ||
    job.state === 'confirming' ||
    result.payment_attempted ||
    (result.payment_status && result.payment_status !== 'not_attempted')
  )
    return '结果待核验';
  return '尚未执行开通';
}
export function statusLabel(value: unknown) {
  return typeof value === 'string' ? (labels[value] ?? '待核验') : '未知';
}
