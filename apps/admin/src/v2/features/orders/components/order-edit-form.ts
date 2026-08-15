import type { FormRules } from 'element-plus';
import { V2_DECIMAL_PLACES, formatV2Decimal, isV2UnsignedDecimal } from '@/v2/utils/decimal';
import { validateTargetProfitRate } from '@/v2/features/order-entry/public-api';
import { parseV2DateTimeInput } from '@/v2/utils/dateTime';
import { getV2BusinessNowMs } from '@/v2/runtime/businessClock';
import type { V2OrderEntryCustomer } from '../contracts';

export function createEmptyOrderEditForm() {
  return {
    customerId: '',
    serviceOptionId: '',
    accountId: '',
    accountSource: 'inventory' as 'inventory' | 'customer_owned',
    accountDisposition: 'retained' as 'retained' | 'sold',
    settlementPlatformOptionId: '',
    platformOrderNo: '',
    websiteAccount: '',
    clearWebsiteAccount: false,
    receivedOriginalAmount: '',
    targetProfitRate: '',
    balanceAmount: '',
    openedAt: null as string | null,
    dueAt: null as string | null,
    lockScope: 'by_service' as 'by_service' | 'global',
    remark: ''
  };
}

export type OrderEditForm = ReturnType<typeof createEmptyOrderEditForm>;

export function createOrderEditRules(
  form: ReturnType<typeof createEmptyOrderEditForm>,
  canEditCore: () => boolean,
  canEditPricing: () => boolean,
  percentageFee: () => string
): FormRules {
  return {
    customerId: [{ required: true, message: '请选择客户', trigger: 'change' }],
    serviceOptionId: [{ required: true, message: '请选择业务', trigger: 'change' }],
    accountId: [{ required: true, message: '请选择使用 ID', trigger: 'change' }],
    settlementPlatformOptionId: [
      {
        validator: (_rule, value, callback) =>
          callback(
            canEditPricing() && !String(value ?? '').trim()
              ? new Error('请选择结算平台')
              : undefined
          ),
        trigger: 'change'
      }
    ],
    receivedOriginalAmount: [
      {
        required: true,
        validator: (_rule, value, callback) =>
          callback(
            isNonNegativeDecimal(value)
              ? undefined
              : new Error(`请输入最多 ${V2_DECIMAL_PLACES} 位小数的非负金额`)
          ),
        trigger: 'blur'
      }
    ],
    targetProfitRate: [
      {
        validator: (_rule, value, callback) => {
          const normalized = String(value ?? '').trim();
          if (!normalized) {
            callback();
            return;
          }
          const error = validateTargetProfitRate(normalized, percentageFee());
          callback(error ? new Error(error) : undefined);
        },
        trigger: 'blur'
      }
    ],
    balanceAmount: [
      {
        required: true,
        validator: (_rule, value, callback) =>
          callback(
            isPositiveDecimal(value)
              ? undefined
              : new Error(`请输入最多 ${V2_DECIMAL_PLACES} 位小数的正数`)
          ),
        trigger: 'blur'
      }
    ],
    openedAt: [{ required: true, message: '请选择开通时间', trigger: 'change' }],
    dueAt: [
      {
        required: true,
        validator: (_rule, value, callback) => {
          const dueAt = parseV2DateTimeInput(value);
          const openedAt = parseV2DateTimeInput(form.openedAt);
          if (!dueAt || !openedAt) {
            callback(new Error('请选择有效时间'));
            return;
          }
          if (dueAt.getTime() <= openedAt.getTime()) {
            callback(new Error('到期时间必须晚于开通时间'));
            return;
          }
          const businessNow = getV2BusinessNowMs();
          if (canEditCore() && businessNow !== null && dueAt.getTime() <= businessNow) {
            callback(new Error('待处理订单的到期时间必须晚于当前时间'));
            return;
          }
          callback();
        },
        trigger: 'change'
      }
    ],
    platformOrderNo: [
      {
        validator: (_rule, value, callback) =>
          callback(
            value && !form.settlementPlatformOptionId
              ? new Error('填写平台订单号时必须选择结算平台')
              : undefined
          ),
        trigger: 'blur'
      }
    ]
  };
}

export function customerLabel(customer: V2OrderEntryCustomer) {
  const detail = customer.wechat || customer.qq || customer.maskedWhatsapp || customer.maskedPhone;
  return detail ? `${customer.name} / ${detail}` : customer.name;
}

export function isNonNegativeDecimal(value: unknown) {
  return isV2UnsignedDecimal(value);
}

export function isPositiveDecimal(value: unknown) {
  const normalized = String(value ?? '').trim();
  return isNonNegativeDecimal(normalized) && Number(normalized) > 0;
}

export function formatDecimal(value: string) {
  return formatV2Decimal(value);
}
