import { isApiError } from '@/api/apiError';
import { sanitizeV2CheckoutDiagnostic, type V2CheckoutDiagnostic } from '@apple-business/shared';
import { DirectBrowserError } from './bitbrowser-direct-api';
import { checkoutDiagnosticSummary } from './bitbrowser-checkout-diagnostic';

export const directPaymentDiagnosticLabels = {
  official_read_session_failed: '官网会话接口未能读取，请核对原窗口的登录状态。',
  official_read_identity_mismatch: '官网会话的用户与本次账号不一致，本次已停止。',
  official_read_token_invalid: '官网会话中的访问凭据无效或已过期，本次未付款。',
  official_read_response_too_large: '官网资料超过当前安全读取范围，本次已停止。',
  official_read_response_invalid: '官网会话或资料接口返回的格式无法解析，本次未付款。',
  official_read_timeout: '读取官网会话或账号资料超时，本次未付款。',
  official_read_network_failed: '当前比特窗口无法完成官网资料请求，请检查原窗口网络。',
  official_read_failed: '官网资料读取脚本未完成，本次未付款。',
  direct_payment_preparation_failed: '网页付款准备未完成，请核对原窗口和执行阶段。',
  direct_payment_control_failed: '未能读取所属窗口的控制状态，本次已停止。',
  direct_payment_identity_failed: '官网账号或订阅状态未完整核实，本次已停止。',
  direct_payment_identity_subscription_conflict: '官网显示免费但仍有有效订阅，本次未创建订单。',
  direct_payment_existing_checkout_read_failed: '官网原单读取未完成，本次未重复建单。',
  direct_payment_expired_authorization_failed: '过期原单替换授权未核实，本次未创建新单。',
  direct_payment_plan_selection_failed: '官网目标套餐入口未核实，本次未创建订单。',
  direct_payment_checkout_create_failed: '官网建单步骤未完成，请保留原窗口核对。',
  direct_payment_quote_read_failed: '官网原单报价读取未完成，本次未付款。',
  direct_payment_quote_period_unverified: '官网月度订阅周期未核实，本次未付款。',
  direct_payment_quote_tax_unverified: '官网税费金额未核实，本次未付款。',
  direct_payment_quote_amount_mismatch: '官网页面与结算接口金额不一致，本次未付款。',
  direct_payment_quote_billing_mismatch: '官网重新计税的账单与本次填写不一致，本次未付款。',
  official_billing_country_mismatch: '官网计税账单的国家与本次填写不一致，本次未付款。',
  official_billing_state_mismatch: '官网计税账单的州或省与本次填写不一致，本次未付款。',
  official_billing_city_mismatch: '官网计税账单的城市与本次填写不一致，本次未付款。',
  official_billing_line1_mismatch: '官网计税账单的地址第一行与本次填写不一致，本次未付款。',
  official_billing_line2_mismatch: '官网计税账单的地址第二行与本次填写不一致，本次未付款。',
  official_billing_postal_code_mismatch: '官网计税账单的邮政编码与本次填写不一致，本次未付款。',
  official_billing_name_mismatch: '官网计税账单的姓名与本次填写不一致，本次未付款。',
  direct_payment_cycle_prepare_failed: '订阅周期准备未完成，请保留原任务核对。',
  direct_payment_upgrade_failed: '官网升级准备未完成，请核对原升级记录。',
  direct_payment_preparation_timeout: '本轮官网付款准备已超时，请检查原窗口。',
  existing_checkout_unverified: '原结算的账号、套餐或未付款状态未能核实。',
  original_checkout_identifier_unverified:
    '历史建单记录缺少可核实的订单编号，已保留原记录；本次未创建新单或付款。',
  existing_checkout_unavailable: '官网结账窗口已变化或原单已失效。',
  account_has_other_payment_attempt: '该账号历史付款或升级结果仍待核实，只允许复查原单。',
  payment_account_or_order_unverified: '官网账号或原订单已变化，本次已停止。',
  payment_marker_required: '官网操作标记未持久化，本次已停止。',
  checkout_unknown_write: '官网建单结果未明确，本次不会重复创建。',
  official_checkout_http_failed: '官网建单接口返回失败；原请求已保留，本次不会重复建单。',
  official_checkout_response_invalid: '官网建单响应无法核实；原请求已保留，本次不会重复建单。',
  official_checkout_network_failed: '官网建单请求连接失败，结果尚未明确；本次不会重复建单。',
  official_payment_form_load_failed:
    '官网提示：无法加载付款表单。原建单记录已保留，本次不会重复点击。',
  official_pro_tier_unverified: '官网 Pro 档位尚未核实，原结账单已保留，本次未付款。',
  official_checkout_quote_unavailable: '官网原单接口未提供可核实的计税明细，本次未付款。',
  official_checkout_quote_binding_unverified: '官网计税明细未能绑定本次原单，本次未付款。',
  checkout_response_plan_unverified: '官网结账来源或套餐未核实，本次已停止。',
  payment_currency_mismatch: '官网付款币种与锁定币种不一致。',
  unsupported_payment_quote: '官网账单金额格式未核实，本次未付款。',
  payment_quote_incomplete: '官网今日应付、税费或月度续费金额尚未完整核实。',
  billing_fields_incomplete: '官网完整账单资料尚未核实，本次未付款。',
  official_payment_field_not_ready: '官网付款字段尚未就绪，请检查原窗口。',
  ambiguous_official_payment_field: '官网付款字段不唯一，本次已停止。',
  invalid_payment_field: '官网付款字段校验未通过，请检查原窗口。',
  payment_form_changed: '官网付款表单已变化，本次已停止。',
  billing_fields_changed: '账单资料已变化，请重新核对。',
  payment_quote_changed: '账单资料或官网报价已变化，请重新核价。',
  previous_payment_attempt_exists: '原窗口已观察到付款操作，请只读核实原单。',
  payment_operation_failed: '官网付款操作未完成，请只读核对原单。',
  payment_result_unknown: '付款确认已保留，官网提交结果待核实；本次不会重复点击。',
  direct_payment_bank_verification_required: '付款请求已提交，官网正在等待本人完成银行验证。',
  official_payment_method_verification_failed:
    '官网提示：未能验证您的支付方式，请核对原单与银行验证结果。',
  checkout_account_unverified: '官网建单请求的账号绑定未核实，请保留原单。',
  duplicate_payment_observed: '原窗口观察到多次付款请求，已停止自动操作并保留原单。',
  unexpected_payment_observed: '原窗口观察到预期外的付款操作，请只读核对原单。',
  payment_account_binding_changed: '付款请求的账号绑定未核实，请只读核对原单。',
  payment_order_binding_changed: '付款请求的订单绑定未核实，请只读核对原单。',
  payment_intent_binding_changed: '官网付款凭据的绑定不一致，请只读核对原单。',
  unexpected_payment_persistence_failed: '已观察到付款操作，但记录回传未确认；请保留原单。',
  payment_binding_persistence_failed: '付款凭据已出现，但记录回传未确认；请保留原单。'
} as const;

type Reason = keyof typeof directPaymentDiagnosticLabels;
export function directOfficialReadReason(value: unknown): Reason | undefined {
  return typeof value === 'string' &&
    value.startsWith('official_read_') &&
    Object.hasOwn(directPaymentDiagnosticLabels, value)
    ? (value as Reason)
    : undefined;
}
export const directPaymentOperations = {
  preparation: ['payment_preparation', 'direct_payment_preparation_failed'],
  control: ['browser_control_connect', 'direct_payment_control_failed'],
  identity: ['subscription_check', 'direct_payment_identity_failed'],
  existing_checkout_read: [
    'existing_checkout_read',
    'direct_payment_existing_checkout_read_failed'
  ],
  recheck: ['original_payment_recheck', 'direct_payment_existing_checkout_read_failed'],
  existing_checkout_binding: ['existing_checkout_binding', 'existing_checkout_unverified'],
  expired_authorization: [
    'expired_checkout_authorization',
    'direct_payment_expired_authorization_failed'
  ],
  plan_selection: ['plan_selection', 'direct_payment_plan_selection_failed'],
  checkout_create: ['checkout_create', 'direct_payment_checkout_create_failed'],
  payment_form: ['payment_preparation', 'invalid_payment_field'],
  quote_read: ['quote_read', 'direct_payment_quote_read_failed'],
  quote_validation: ['quote_validation', 'payment_quote_incomplete'],
  cycle_prepare: ['next_subscription_cycle_review', 'direct_payment_cycle_prepare_failed'],
  upgrade: ['subscription_upgrade', 'direct_payment_upgrade_failed'],
  confirmation: ['payment_confirmation', 'payment_operation_failed'],
  payment_result: ['payment_result', 'payment_operation_failed']
} as const satisfies Record<string, readonly [string, Reason]>;
export type DirectPaymentOperation = keyof typeof directPaymentOperations;

const knownMessages: Readonly<Record<string, Reason>> = {
  '官网账号已变化，本次停止复查。': 'payment_account_or_order_unverified',
  '官网原结账单绑定未核实。': 'existing_checkout_unverified',
  '官网原单套餐或编号不一致。': 'payment_account_or_order_unverified',
  '官网原单实付金额未核实。': 'payment_quote_incomplete',
  '原升级记录绑定未核实。': 'existing_checkout_unverified',
  '官网原升级发票列表未核实。': 'direct_payment_existing_checkout_read_failed',
  '官网原升级付款证据存在歧义。': 'payment_account_or_order_unverified',
  '原付款账本或报价绑定缺失，本次无法确认复查收尾。': 'existing_checkout_unverified',
  '原付款账本更新结果待核实，请保留原单并重新只读复查。':
    'direct_payment_existing_checkout_read_failed',
  '原订单编号未核实，禁止创建新订单': 'original_checkout_identifier_unverified',
  '官网套餐档位未核实。': 'official_pro_tier_unverified',
  '官网账号已变化，本次已停止。': 'payment_account_or_order_unverified',
  '官网订阅显示免费但仍有有效订阅，本次不会创建订单。':
    'direct_payment_identity_subscription_conflict',
  '该账号历史付款或升级结果仍待核实，本次仅允许复查原单。': 'account_has_other_payment_attempt',
  '该账号历史付款结果仍待核实，本次仅允许复查原单。': 'account_has_other_payment_attempt',
  '官网操作标记未持久化，本次已停止。': 'payment_marker_required',
  '官网建单结果未明确，本次不会重复创建。': 'checkout_unknown_write',
  '官网结账来源未核实。': 'checkout_response_plan_unverified',
  '官网结账窗口已变化或原单已失效。': 'existing_checkout_unavailable',
  '官网原单状态或套餐未核实。': 'existing_checkout_unverified',
  '官网付款币种与锁定币种不一致。': 'payment_currency_mismatch',
  '官网账单金额未核实。': 'unsupported_payment_quote',
  '官网订阅周期未核实。': 'direct_payment_quote_period_unverified',
  '官网今日应付、税费或月度续费金额尚未完整核实。': 'payment_quote_incomplete',
  '官网金额未核实，已停止付款。': 'payment_quote_incomplete',
  '官网税费未核实。': 'direct_payment_quote_tax_unverified',
  '官网页面与结算接口金额不一致。': 'direct_payment_quote_amount_mismatch',
  '官网账单资料尚未核实。': 'billing_fields_incomplete',
  '官网重新计税的账单资料与本次填写不一致。': 'direct_payment_quote_billing_mismatch',
  '账单资料或官网报价已变化，请重新核价。': 'payment_quote_changed',
  '原窗口已观察到付款操作，请只读核实原单。': 'previous_payment_attempt_exists',
  '原窗口已发生付款操作，需核实原单；本次不会重复提交。': 'previous_payment_attempt_exists',
  '本轮官网核价已超时，请检查原窗口。': 'direct_payment_preparation_timeout',
  '付款确认已保留，官网提交结果待核实；本次不会重复点击。': 'payment_result_unknown'
};
const errorTypes = new Set([
  'TimeoutError',
  'AssertionError',
  'Error',
  'TypeError',
  'TargetClosedError',
  'UnexpectedError'
]);
type PageState = 'official_error' | 'quote_incomplete';
interface Metadata {
  http_status?: number;
  page_state?: PageState;
  error_type?: string;
  diagnostics?: { checkout_error?: V2CheckoutDiagnostic };
}

/** Only closed diagnostics and a numeric HTTP status can cross the callback boundary. */
export class DirectPaymentDiagnosticError extends Error {
  readonly facts: Readonly<{ stage: string; reason: Reason } & Metadata>;
  constructor(operation: DirectPaymentOperation, reason?: Reason, metadata: Metadata = {}) {
    const definition = directPaymentOperations[operation];
    const safeReason =
      reason && Object.hasOwn(directPaymentDiagnosticLabels, reason) ? reason : definition[1];
    const httpStatus =
      Number.isInteger(metadata.http_status) &&
      Number(metadata.http_status) >= 100 &&
      Number(metadata.http_status) <= 599
        ? metadata.http_status
        : undefined;
    super(
      directPaymentDiagnosticLabels[safeReason] +
        (httpStatus ? `（HTTP ${httpStatus}）` : '') +
        checkoutDiagnosticSummary(metadata.diagnostics?.checkout_error)
    );
    this.facts = Object.freeze({
      stage: definition[0],
      reason: safeReason,
      ...(httpStatus ? { http_status: httpStatus } : {}),
      ...(['official_error', 'quote_incomplete'].includes(String(metadata.page_state))
        ? { page_state: metadata.page_state }
        : {}),
      ...(errorTypes.has(String(metadata.error_type)) ? { error_type: metadata.error_type } : {}),
      ...(metadata.diagnostics?.checkout_error
        ? {
            diagnostics: {
              checkout_error: sanitizeV2CheckoutDiagnostic(metadata.diagnostics.checkout_error)
            }
          }
        : {})
    });
  }
}
export function directPaymentFailure(cause: unknown, operation: DirectPaymentOperation) {
  if (cause instanceof DirectPaymentDiagnosticError) return cause;
  const message = cause instanceof Error ? cause.message : '';
  const reason = Object.hasOwn(directPaymentDiagnosticLabels, message)
    ? (message as Reason)
    : Object.hasOwn(knownMessages, message)
      ? knownMessages[message]
      : undefined;
  const status = isApiError(cause)
    ? cause.status
    : cause instanceof DirectBrowserError
      ? cause.metadata.httpStatus
      : undefined;
  return new DirectPaymentDiagnosticError(operation, reason, {
    ...(typeof status === 'number' ? { http_status: status } : {}),
    ...(reason === 'payment_quote_incomplete' ? { page_state: 'quote_incomplete' } : {}),
    ...(cause instanceof Error ? { error_type: cause.name } : {})
  });
}
export async function directPaymentOperation<T>(
  operation: DirectPaymentOperation,
  work: () => Promise<T>
) {
  try {
    return await work();
  } catch (cause) {
    throw directPaymentFailure(cause, operation);
  }
}
