import type { V2RechargeJob } from './contracts';

export const planLabels = {
  plus: 'ChatGPT Plus',
  'pro-5x': 'ChatGPT Pro 5×',
  'pro-20x': 'ChatGPT Pro 20×'
};

export const currencyOptions = [
  { value: 'PHP', label: '菲律宾比索（PHP）' },
  { value: 'USD', label: '美元（USD）' },
  { value: 'MYR', label: '马来西亚令吉（MYR）' },
  { value: 'EUR', label: '欧元（EUR）' },
  { value: 'GBP', label: '英镑（GBP）' },
  { value: 'AUD', label: '澳大利亚元（AUD）' },
  { value: 'CAD', label: '加拿大元（CAD）' },
  { value: 'JPY', label: '日元（JPY）' },
  { value: 'KRW', label: '韩元（KRW）' },
  { value: 'SGD', label: '新加坡元（SGD）' },
  { value: 'INR', label: '印度卢比（INR）' },
  { value: 'IDR', label: '印度尼西亚卢比（IDR）' },
  { value: 'THB', label: '泰铢（THB）' },
  { value: 'VND', label: '越南盾（VND）' },
  { value: 'TWD', label: '新台币（TWD）' },
  { value: 'HKD', label: '港元（HKD）' },
  { value: 'BRL', label: '巴西雷亚尔（BRL）' },
  { value: 'MXN', label: '墨西哥比索（MXN）' },
  { value: 'AED', label: '阿联酋迪拉姆（AED）' },
  { value: 'SAR', label: '沙特里亚尔（SAR）' },
  { value: 'ZAR', label: '南非兰特（ZAR）' },
  { value: 'NZD', label: '新西兰元（NZD）' },
  { value: 'CHF', label: '瑞士法郎（CHF）' },
  { value: 'SEK', label: '瑞典克朗（SEK）' },
  { value: 'NOK', label: '挪威克朗（NOK）' },
  { value: 'DKK', label: '丹麦克朗（DKK）' },
  { value: 'PLN', label: '波兰兹罗提（PLN）' },
  { value: 'TRY', label: '土耳其里拉（TRY）' }
] as const;

const labels: Record<string, string> = {
  free: '免费版',
  plus: 'Plus',
  pro: 'Pro（档位待核验）',
  running: '正在执行',
  awaiting_human_verification: '等待本人验证',
  awaiting_details: '等待填写付款资料',
  awaiting_confirmation: '等待确认金额',
  confirming: '正在提交本次付款',
  finished: '本次操作已结束',
  unknown: '结果待核验',
  blank: '报价页空白',
  loading: '报价页仍在加载',
  checkout: '已进入有效结算页',
  quote_incomplete: '报价字段不完整',
  official_error: '官网结算错误页',
  open_browser: '仅登录窗口',
  session_ready: '账号已登录，窗口已就绪',
  session_restore: '正在加载官网并核对账号',
  login_email: '正在填写官网登录邮箱',
  login_password: '正在填写官网登录密码',
  login_code_required: '等待输入官网登录验证码',
  login_code_submitted: '验证码已提交，正在核对官网会话',
  login_manual_required: '等待本人在官网窗口完成登录验证',
  login_verified: '官网账号登录并核对通过',
  login_code_expired: '验证码等待超时，请在原窗口检查登录状态',
  login_code_not_requested: '当前任务没有等待验证码',
  invalid_login_code: '验证码格式无效',
  invalid_login_credentials: '账号或密码格式无效',
  login_form_ambiguous: '官网登录表单无法唯一识别，请在原窗口操作',
  unsupported_login_provider: '该账号需要其他登录方式，请在原窗口操作',
  official_login_email_mismatch: '官网已登录邮箱与本次输入账号不一致',
  official_login_not_verified: '未能确认官网账号已登录，本次未付款',
  page_load: '加载官网页面',
  page_refresh: '刷新当前官网页面',
  session_page_refreshing: '页面加载失败，正在刷新当前窗口',
  session_read: '读取官网会话',
  account_read: '核对官网账号',
  session_load_timeout: '代理加载超过本轮等待时间',
  session_network_error: '官网会话网络请求失败',
  session_retries_exhausted: '当前页面刷新及窗口尝试均失败，失败窗口已清理；请检查代理连接后再试',
  bitbrowser_profile_cleanup: '正在关闭并清理本次失败窗口',
  bitbrowser_profile_rebuilding: '正在重新创建窗口',
  bitbrowser_cleanup_unverified: '未能确认失败窗口已安全清理，已停止重建，请在比特浏览器检查该窗口',
  session_verified: '账户核对通过',
  existing_checkout_read: '读取原结算',
  existing_checkout_rebuilding: '旧结算不可用，正在创建新结算',
  plan_selection: '选择官网套餐',
  checkout_create: '准备创建官方结算',
  checkout_request_sending: '正在请求官方结算',
  checkout_wait: '等待官方结算响应',
  quote_read: '读取官方报价',
  quote_waiting: '报价页仍在加载',
  quote_page_refreshing: '正在刷新当前报价页',
  quote_ready: '已取得官方报价',
  waiting_local_connector: '等待本机连接器接收',
  connector_dispatch: '正在连接本机执行器',
  bitbrowser_group: '正在核对比特浏览器分组',
  bitbrowser_profile_created: '已创建比特浏览器窗口',
  bitbrowser_profile_opened: '比特浏览器窗口已打开',
  stale_profile_cleanup: '正在清理历史失败窗口',
  payment_guard_passed: '币种和付款上限已核对',
  payment_request_sending: '已发出本次唯一付款请求',
  details_required: '等待填写官网资料',
  payment_ready: '已核价，等待确认',
  checkout_quote_verified: '官方报价已核对',
  checkout_ready_for_billing: '等待账单地址确定总额',
  blocked: '当前步骤未完成',
  subscription_activated: '开通成功',
  paid_pending_activation: '已付款，待开通',
  paid_tier_pending_verification: '已付款，档位待核验',
  payment_failed: '付款失败',
  payment_result_unknown: '付款结果待核验',
  payment_unknown_resolved: '历史付款锁已处理',
  payment_unknown_resolution: '正在处理历史付款记录',
  verification_required: '官网要求真人验证，本次已安全停止',
  payment_cancelled: '已取消本次确认',
  payment_submitted_or_pending: '等待原单付款结果',
  rechecking_original_payment: '正在只读复查原订单',
  original_payment_recheck: '只读复查原订单',
  paid: '已确认付款',
  declined: '官方拒付',
  requires_action: '需要本人验证',
  not_attempted: '未尝试付款',
  not_verified: '未核验',
  restored: '会话已恢复',
  json_session_not_restored: 'JSON 会话未恢复，请提供新的授权 JSON',
  official_user_mismatch: '官网用户与本次目标账号不一致',
  official_account_mismatch: '官网账户与本次目标账号不一致',
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
  payment_quote_not_ready: '官网最终金额尚未稳定，本次未付款',
  payment_confirmation_expired: '确认已过期，请重新核价',
  card_expiry_or_cvc_invalid: '银行卡有效期或安全码格式无效',
  billing_country_option_not_found: '官网未找到 United States 账单国家选项，已安全停止',
  network_unconfirmed: '浏览器出口未确认，暂不能提交付款',
  local_browser_operation_failed: '本机浏览器执行失败，请查看原窗口',
  bitbrowser_local_api_unavailable: '无法连接比特浏览器，请确认软件和 Local API 已启动',
  bitbrowser_local_api_rejected: '比特浏览器拒绝了本次操作，请检查接口密钥与设置',
  bitbrowser_group_ambiguous: '找到多个同名窗口分组，请保留唯一分组',
  bitbrowser_group_unverified: '无法确认比特浏览器窗口分组',
  bitbrowser_group_missing: '所选分组已不存在，请刷新分组列表后重新选择',
  bitbrowser_tag_missing: '所选标签已不存在，请刷新标签列表后重新选择',
  bitbrowser_tag_binding_failed: '窗口已创建但标签绑定失败，未打开窗口或执行充值，请检查比特浏览器',
  bitbrowser_tag_ambiguous: '找到多个同名窗口标签，请先在比特浏览器中区分名称',
  bitbrowser_catalog_invalid: '比特浏览器分组或标签列表无法确认，请刷新重试',
  bitbrowser_catalog_limit: '比特浏览器分组或标签数量超过读取上限，请整理后重试',
  bitbrowser_profile_unverified: '比特浏览器窗口创建结果未确认',
  bitbrowser_profile_sync_unverified: '无法确认窗口已关闭登录资料同步，请检查比特浏览器设置后重试',
  bitbrowser_debug_endpoint_missing: '比特浏览器未返回可连接的窗口',
  bitbrowser_context_missing: '比特浏览器窗口上下文不可用',
  local_connector_not_received: '本机连接器未接收，本次已安全结束',
  payment_currency_mismatch: '官网币种与锁定币种不一致，本次未付款',
  payment_amount_over_limit: '官网今日应付超过设定上限，本次未付款',
  payment_quote_incomplete: '官网最终金额不完整，本次未付款',
  bank_verification_required: '需要本人完成银行验证',
  quote_needs_review_or_billing: '官网初始总额或预估税费未完整读取，本次未付款',
  actual_quote_unknown: '无法明确读取今日应付',
  checkout_page_load_timeout: '报价页等待满本轮时间后仍未加载',
  checkout_page_network_error: '当前报价页的代理或网络连接失败',
  checkout_page_incomplete: '报价页未返回完整内容',
  prepayment_retries_exhausted: '报价页刷新及三次窗口尝试均失败，失败窗口已清理',
  existing_checkout_unavailable: '原结算已失效，本次未付款',
  confirmed_no_bank_request: '已确认银行卡未收到付款请求',
  no_original_payment_attempt: '没有已尝试付款的原单',
  no_payment_attempt_to_recheck: '没有可只读复查的付款记录',
  original_payment_recheck_failed: '官网原订单复查未完成',
  worker_operation_failed: '服务器执行步骤未完成',
  worker_acceptance_unknown: '执行器接收结果待核验，本次不会自动重发',
  worker_not_received: '执行器未接收本次任务，请重新开始',
  confirmation_acceptance_unknown: '付款确认接收结果待核验，只能复查原订单',
  payment_details_expired: '填写付款资料已超时，本次未付款',
  original_quote_mismatch: '原订单当前币种或金额与历史记录不一致，只展示官网实际结果',
  durable_state_unavailable: '记录服务未确认，已阻止重复请求',
  operation_cancelled: '操作已取消',
  cancelled: '本次任务已取消',
  cancelling: '正在停止并清理本次窗口',
  operation_cancel_requested: '已收到停止请求，正在清理',
  http_error: '官网拒绝当前请求，本次已安全停止',
  access_token_expired: '授权凭据已过期，请更新授权 JSON',
  account_checked: '官网账号已核对',
  account_operation_in_progress: '同一账号已有一笔操作正在执行',
  account_operation_lock_invalid: '账号操作锁状态异常，已停止本次操作',
  ambiguous_official_payment_field: '官网出现多个付款字段，无法安全确定填写位置',
  another_local_job_is_running: '本机连接器正在执行另一笔任务',
  before_payment_click: '已完成付款前检查',
  billing_address_location_mismatch: '账单地址的国家或地区与当前设置不一致',
  billing_country_invalid: '账单国家无效',
  billing_email_invalid: '账单邮箱与授权账号邮箱不一致',
  billing_field_required: '官网要求补充账单资料',
  billing_fields_changed: '付款前账单字段发生变化，已停止付款',
  billing_form_changed: '官网账单表单结构已变化，已停止付款',
  bitbrowser_api_token_invalid: '比特浏览器 Local API 密钥无效',
  browser_startup_failed: '官网浏览器启动失败',
  card_expired: '银行卡已过期',
  checkout_attempted: '已尝试创建官方结算',
  checkout_created: '官方结算已创建',
  checkout_ledger_plan_mismatch: '原结算记录的套餐与本次选择不一致',
  checkout_marker_write_failed: '未能安全保存建单记录，已阻止继续',
  checkout_page_identifier_unverified: '无法确认当前页面属于本次结算',
  checkout_record_plan_mismatch: '历史结算记录的套餐不匹配',
  checkout_response_unreadable: '官网结算响应无法安全读取',
  checkout_tier_not_verified: '官网结算的 Pro 档位无法确认',
  complete_payment_quote_required: '官网最终付款金额不完整',
  confirmation_already_consumed: '本次付款确认已使用，已阻止重复提交',
  confirmation_cancelled: '已取消付款确认',
  confirmation_mismatch: '当前报价与已确认金额不一致',
  connector_origin_not_allowed: '本机连接器未允许当前网站来源',
  connector_token_invalid: '本机连接密钥不匹配',
  consult_original_payment_record: '已存在付款尝试，请只读复查原订单',
  duplicate_checkout_blocked: '已阻止重复创建结算',
  duplicate_payment_blocked: '已阻止重复付款',
  existing_subscription_conflict: '当前账号已有与本次不兼容的订阅',
  history_conflict: '历史付款记录已发生变化，需要重新核对',
  interrupted: '本次操作已中断',
  invalid_bitbrowser_configuration: '比特浏览器配置不完整或无效',
  invalid_browser_window_name: '浏览器窗口名称无效',
  invalid_callback_url: '本机连接器的回传地址无效',
  invalid_checkout_record: '原结算记录无法验证',
  invalid_connector_job: '本机连接器任务无效或已失效',
  invalid_connector_payload: '本机连接器接收的任务资料不完整',
  invalid_json_or_access_token: '授权 JSON 无效或登录凭据已失效',
  invalid_local_connector_configuration: '本机连接器地址或配置无效',
  invalid_locked_currency: '锁定币种无效',
  invalid_operation_combination: '本次操作模式与任务资料不匹配',
  invalid_payment_amount: '最高付款金额无效',
  invalid_payment_authorization: '本次单次付款授权无效',
  invalid_payment_details: '银行卡或账单资料不完整',
  invalid_payment_evidence: '官网付款凭据无法验证',
  invalid_payment_field: '官网付款字段无法安全填写',
  invalid_payment_limit: '最高付款上限无效',
  invalid_payment_preparation: '付款前安全检查未完成',
  invalid_payment_record: '历史付款记录无法验证',
  invalid_payment_status: '官网返回了无法识别的付款状态',
  invalid_session_json: '授权 JSON 格式无效',
  json_account_mismatch: '授权 JSON 的账号与本次任务不一致',
  json_email_mismatch: '授权 JSON 的邮箱信息不一致',
  json_too_large: '授权 JSON 文件过大',
  local_io_or_record_error: '本机安全记录读写失败，已停止操作',
  local_payment_confirmation_required: '本次付款缺少明确确认',
  local_plan_selection_required: '需要先确认本次套餐',
  local_secure_terminal_required: '本机安全确认通道不可用',
  missing_checkout_identifier: '原结算记录缺少订单编号',
  missing_observed_checkout_entity: '原结算记录缺少处理方信息',
  missing_target_account_id: '授权 JSON 缺少目标账号编号',
  missing_target_user_id: '授权 JSON 缺少目标用户编号',
  network_error: '连接官网时发生网络错误',
  network_timeout: '连接官网时网络超时',
  official_checkout_navigation_not_observed: '点击套餐后未进入官方结算页',
  official_payment_field_not_ready: '官网付款字段尚未加载完成',
  official_subscribe_button_not_ready: '官网付款按钮尚未可用',
  payment_account_or_order_unverified: '付款前无法再次确认账号和订单',
  payment_details_already_consumed: '本次银行卡资料已提交过，已阻止重复使用',
  payment_evidence_mismatch: '付款凭据与本次订单或金额不一致',
  payment_evidence_required: '官网未返回可验证的付款成功凭据',
  payment_form_changed: '官网付款表单已变化，已停止付款',
  payment_ledger_attachment_invalid: '付款记录与当前结算无法绑定',
  payment_marker_required: '未能保存付款防重标记，已停止付款',
  payment_operation_failed: '付款执行过程发生异常',
  payment_prepared: '已填写付款资料并核对金额',
  payment_quote_plan_mismatch: '官网最终报价的套餐与本次选择不一致',
  payment_record_required: '未找到本次付款的安全记录',
  payment_result: '正在确认原单付款结果',
  payment_save_preference_changed: '官网保存付款方式的选项发生变化，已停止付款',
  plan_selection_cancelled: '已取消套餐选择',
  response_too_large: '官网响应超过安全读取上限',
  retry_requires_rejected_record: '当前历史记录不符合安全重试条件',
  unexpected_checkout_origin: '当前结算页不是官方允许的地址',
  unexpected_request_target: '发现非官方付款请求，已阻止',
  unexpected_response: '官网返回了无法识别的响应',
  unknown_account_shape: '官网账号资料格式已变化',
  unknown_current_plan: '无法确认当前账号套餐',
  unsafe_state_directory: '本机安全记录目录无法验证',
  unsafe_state_file: '本机安全记录文件无法验证',
  unsupported_payment_quote: '官网返回了不支持的报价格式',
  unsupported_state_record: '历史安全记录版本不受支持',
  unsupported_target_plan: '本次选择的套餐不受支持'
};

const paymentFailureLabels: Record<string, string> = {
  card_declined: '发卡行拒绝了这笔付款',
  expired_card: '银行卡已过期',
  incorrect_cvc: '银行卡安全码不正确',
  incorrect_number: '银行卡号不正确',
  invalid_number: '官网判定银行卡号无效',
  insufficient_funds: '银行卡余额或可用额度不足',
  authentication_required: '发卡行要求完成本人验证',
  payment_intent_binding_changed: '付款订单标识在执行中发生变化',
  official_payment_evidence_not_observed: '官网未返回可验证的付款结果',
  payment_response_not_verified: '官网付款响应无法安全验证'
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
  if (job.result.operator_resolution === 'confirmed_no_bank_request') return '历史记录已处理';
  if (
    job.result.reason === 'account_has_other_payment_attempt' ||
    job.result.status === 'payment_result_unknown'
  )
    return '历史付款待处理';
  if (job.result.reason === 'existing_checkout_unavailable') return '原结算已失效';
  if (job.result.page_state === 'blank') return '报价页空白';
  if (job.result.page_state === 'official_error') return '官网错误页';
  if (job.result.page_state === 'quote_incomplete') return '报价不完整';
  if (job.result.page_state === 'network_error') return '代理连接失败';
  if (job.result.quote) return '未知';
  if (job.action === 'check') return '待获取报价';
  if (job.action === 'quote' && job.state === 'running') return '正在获取报价';
  if (job.action === 'flow' && job.state === 'running') return '正在计算最终金额';
  if (job.action === 'bitbrowser' && job.state === 'running') return '正在读取官网金额';
  if (job.state === 'awaiting_details') return '等待填写账单资料';
  if (job.action === 'quote' && job.state === 'finished' && job.result.reason) return '获取失败';
  if (job.state === 'unknown') return '报价结果待核验';
  return '待获取报价';
}
export function subscriptionLabel(job: V2RechargeJob): string {
  const result = job.result;
  if (result.mode === 'open_browser') return '未执行开通（仅登录模式）';
  if (result.operator_resolution === 'confirmed_no_bank_request') return '尚未开通';
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

export interface RechargeIssueFeedback {
  title: string;
  message: string;
  action: string;
}

const credentialReasons = new Set([
  'access_token_expired',
  'invalid_json',
  'invalid_json_or_access_token',
  'invalid_session_json',
  'json_session_not_restored',
  'missing_session_token'
]);
const connectorReasons = new Set([
  'another_local_job_is_running',
  'bitbrowser_api_token_invalid',
  'bitbrowser_local_api_rejected',
  'bitbrowser_local_api_unavailable',
  'connector_origin_not_allowed',
  'connector_token_invalid',
  'invalid_bitbrowser_configuration',
  'invalid_local_connector_configuration',
  'local_connector_not_received'
]);
const networkReasons = new Set([
  'checkout_page_load_timeout',
  'checkout_page_network_error',
  'network_error',
  'network_timeout',
  'network_unconfirmed',
  'session_load_timeout',
  'session_network_error',
  'session_retries_exhausted',
  'prepayment_retries_exhausted'
]);
const paymentUnknownReasons = new Set([
  'account_has_other_payment_attempt',
  'confirmation_acceptance_unknown',
  'consult_original_payment_record',
  'durable_state_unavailable',
  'payment_evidence_required',
  'payment_operation_failed',
  'previous_payment_attempt_exists',
  'worker_acceptance_unknown'
]);

export function failureReasonLabel(value: unknown): string {
  if (typeof value !== 'string') return '系统未收到具体失败原因';
  return labels[value] ?? '系统未识别到具体失败原因';
}

export function paymentFailureLabel(value: unknown): string {
  if (typeof value !== 'string') return '官网或银行未返回可识别的拒付原因';
  return paymentFailureLabels[value] ?? '官网或银行未返回可识别的拒付原因';
}

function issueAction(job: V2RechargeJob, reason?: string, paymentFailure?: string): string {
  if (
    paymentFailure === 'authentication_required' ||
    job.result.payment_status === 'requires_action'
  )
    return '请在当前官网窗口完成银行验证，然后只读复查原订单。';
  if (paymentFailure || job.result.payment_status === 'declined')
    return '请核对银行卡状态、余额、限额和银行限制；系统不会自动重复付款。';
  if (reason && credentialReasons.has(reason)) return '请重新导出并载入当前账号的授权 JSON。';
  if (reason && connectorReasons.has(reason))
    return '请打开比特浏览器和本机连接器，再到右上角设置检查连接、密钥和窗口配置。';
  if (reason && networkReasons.has(reason))
    return '请在右上角设置检查代理 IP 和等待时间，确认代理可用后重新开始。';
  if (reason === 'bitbrowser_cleanup_unverified')
    return '请先在比特浏览器确认本任务的失败窗口已关闭，再重新开始。';
  if (reason === 'verification_required' || job.result.user_action_required === true)
    return '请在当前官网窗口完成真人验证，然后返回网站继续。';
  if (
    (reason && paymentUnknownReasons.has(reason)) ||
    job.state === 'unknown' ||
    job.result.payment_status === 'unknown'
  )
    return '请先使用“只读复查原订单”；确认账号仍为免费版且银行卡没有收到请求后，再处理历史付款锁。';
  if (job.result.payment_attempted === true || Number(job.result.payment_requests_sent ?? 0) > 0)
    return '本次可能已发出付款请求，请只读复查原订单，不要重新发起付款。';
  return '请根据上述原因修正资料或设置后重新开始；本次未提交付款。';
}

export function rechargeIssueFeedback(job: V2RechargeJob): RechargeIssueFeedback | null {
  if (job.result.operator_resolution === 'confirmed_no_bank_request') return null;
  const paymentFailure =
    typeof job.result.payment_failure_reason === 'string'
      ? job.result.payment_failure_reason
      : undefined;
  if (
    paymentFailure ||
    job.result.payment_status === 'declined' ||
    job.result.status === 'payment_failed'
  ) {
    return {
      title: '付款失败原因',
      message: paymentFailureLabel(paymentFailure),
      action: issueAction(job, undefined, paymentFailure)
    };
  }
  const reason = typeof job.result.reason === 'string' ? job.result.reason : undefined;
  if (reason) {
    const pageMessages: Record<string, string> = {
      blank: '报价页等待满本轮时间并自动刷新后，仍没有返回有效内容',
      official_error: '官网返回了结算错误页，未取得可用报价',
      quote_incomplete: '官网报价字段不完整，无法安全确认今日应付金额',
      network_error: browserFailureLabel(job.result.error_type, job.result.browser_error_code)
    };
    return {
      title: job.result.user_action_required === true ? '需要你处理' : '本次未完成原因',
      message:
        typeof job.result.page_state === 'string' && pageMessages[job.result.page_state]
          ? pageMessages[job.result.page_state]!
          : failureReasonLabel(reason),
      action: issueAction(job, reason)
    };
  }
  if (job.state === 'unknown' || job.result.status === 'payment_result_unknown') {
    return {
      title: '结果待核验',
      message: '官网或本机连接器没有返回可确认的最终结果',
      action: issueAction(job)
    };
  }
  if (
    ['finished'].includes(job.state) &&
    (typeof job.result.error_type === 'string' || typeof job.result.browser_error_code === 'string')
  ) {
    return {
      title: '浏览器执行失败',
      message: browserFailureLabel(job.result.error_type, job.result.browser_error_code),
      action: issueAction(job, 'network_error')
    };
  }
  return null;
}

export function paymentStatusLabel(job: V2RechargeJob): string {
  if (job.result.mode === 'open_browser') return '未发起付款（仅登录模式）';
  if (job.result.operator_resolution === 'confirmed_no_bank_request')
    return '已确认银行卡未收到付款请求';
  if (job.result.payment_status) return statusLabel(job.result.payment_status);
  if (job.state === 'confirming') return '正在提交本次付款';
  if (job.state === 'unknown' || job.result.payment_attempted || job.result.payment_outcome)
    return '付款结果待核验';
  return '未尝试付款';
}

export function browserFailureLabel(type?: string, code?: string): string {
  const types: Record<string, string> = {
    TimeoutError: '等待超时',
    TargetClosedError: '浏览器窗口或连接已关闭',
    Error: '浏览器操作异常',
    TypeError: '浏览器请求异常',
    UnexpectedError: '未识别的浏览器异常'
  };
  const codes: Record<string, string> = {
    'net::ERR_TIMED_OUT': '网络响应超时',
    'net::ERR_CONNECTION_TIMED_OUT': '连接超时',
    'net::ERR_CONNECTION_RESET': '连接被重置',
    'net::ERR_CONNECTION_CLOSED': '连接已关闭',
    'net::ERR_PROXY_CONNECTION_FAILED': '代理连接失败',
    'net::ERR_TUNNEL_CONNECTION_FAILED': '代理通道连接失败',
    'net::ERR_NAME_NOT_RESOLVED': '域名解析失败',
    'net::ERR_NETWORK_CHANGED': '网络发生切换',
    'net::ERR_EMPTY_RESPONSE': '网络未返回内容',
    'net::ERR_CONNECTION_REFUSED': '连接被拒绝',
    'net::ERR_INTERNET_DISCONNECTED': '网络已断开'
  };
  if (code && Object.hasOwn(codes, code)) return codes[code];
  if (type && Object.hasOwn(types, type)) return types[type];
  return '浏览器操作异常';
}
