import type { FormRules } from 'element-plus';
import { V2_DECIMAL_PLACES } from '@/v2/utils/decimal';
import type { V2OrderEntryForm } from './order-entry-form';
import { isPositiveOrderAmount, validateTargetProfitRate } from './order-pricing';
import { createOrderReceiptRules } from './order-receipt';

export function createOrderEntryRules(
  form: V2OrderEntryForm,
  getSettlementPercentageFee: () => string
): FormRules {
  return {
    countryId: [{ required: true, message: '请选择国家', trigger: 'change' }],
    categoryId: [{ required: true, message: '请选择业务分类', trigger: 'change' }],
    serviceOptionId: [{ required: true, message: '请选择业务', trigger: 'change' }],
    customerId: [{ required: true, message: '请选择客户', trigger: 'change' }],
    accountId: [{ required: true, message: '请选择可用 ID', trigger: 'change' }],
    ...createOrderReceiptRules(form),
    settlementPlatformOptionId: [{ required: true, message: '请选择结算平台', trigger: 'change' }],
    targetProfitRate: [
      {
        validator: (_rule, value, callback) => {
          const normalized = String(value ?? '').trim();
          if (!normalized) {
            callback();
            return;
          }
          const error = validateTargetProfitRate(normalized, getSettlementPercentageFee());
          callback(error ? new Error(error) : undefined);
        },
        trigger: 'blur'
      }
    ],
    balanceAmount: [
      {
        required: true,
        validator: (_rule, value, callback) => {
          callback(
            isPositiveOrderAmount(value)
              ? undefined
              : new Error(`请输入最多 ${V2_DECIMAL_PLACES} 位小数的正数`)
          );
        },
        trigger: 'blur'
      }
    ],
    openedAt: [{ required: true, message: '请选择开通时间', trigger: 'change' }],
    dueAt: [
      {
        required: true,
        validator: (_rule, value, callback) => {
          if (!(value instanceof Date)) {
            callback(new Error('请选择到期时间'));
            return;
          }
          if (!(form.openedAt instanceof Date) || value.getTime() <= form.openedAt.getTime()) {
            callback(new Error('到期时间必须晚于开通时间'));
            return;
          }
          if (value.getTime() <= Date.now()) {
            callback(new Error('到期时间必须晚于当前时间'));
            return;
          }
          callback();
        },
        trigger: 'change'
      }
    ],
    platformOrderNo: [
      {
        validator: (_rule, value, callback) => {
          callback(
            value && !form.settlementPlatformOptionId
              ? new Error('填写平台订单号时必须选择结算平台')
              : undefined
          );
        },
        trigger: 'blur'
      }
    ]
  };
}
