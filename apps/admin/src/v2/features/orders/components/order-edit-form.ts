import type { FormRules } from 'element-plus';
import { V2_DECIMAL_PLACES, formatV2Decimal, isV2UnsignedDecimal } from '@/v2/utils/decimal';
import type { V2OrderEntryCustomer } from '../contracts';

export function createEmptyOrderEditForm() {
  return {
    customerId: '',
    serviceOptionId: '',
    accountId: '',
    accountDisposition: 'retained' as 'retained' | 'sold',
    settlementPlatformOptionId: '',
    platformOrderNo: '',
    websiteAccount: '',
    clearWebsiteAccount: false,
    receivedAmount: '',
    balanceAmount: '',
    openedAt: null as Date | null,
    dueAt: null as Date | null,
    lockScope: 'by_service' as 'by_service' | 'global',
    remark: ''
  };
}

export function createOrderEditRules(
  form: ReturnType<typeof createEmptyOrderEditForm>,
  canEditCore: () => boolean
): FormRules {
  return {
    customerId: [{ required: true, message: '请选择客户', trigger: 'change' }],
    serviceOptionId: [{ required: true, message: '请选择业务', trigger: 'change' }],
    accountId: [{ required: true, message: '请选择使用 ID', trigger: 'change' }],
    receivedAmount: [
      {
        validator: (_rule, value, callback) =>
          callback(
            isNonNegativeDecimal(value)
              ? undefined
              : new Error(`请输入最多 ${V2_DECIMAL_PLACES} 位小数的非负金额`)
          ),
        trigger: 'blur'
      }
    ],
    balanceAmount: [
      {
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
        validator: (_rule, value, callback) => {
          if (!(value instanceof Date) || !(form.openedAt instanceof Date)) {
            callback(new Error('请选择有效时间'));
            return;
          }
          if (value.getTime() <= form.openedAt.getTime()) {
            callback(new Error('到期时间必须晚于开通时间'));
            return;
          }
          if (canEditCore() && value.getTime() <= Date.now()) {
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
  const detail = customer.wechat || customer.maskedPhone;
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
