import type { FormRules } from 'element-plus';

export const topupRecordReversalRules: FormRules = {
  reason: [
    {
      required: true,
      validator: (_rule, value, callback) => {
        const normalized = String(value ?? '').trim();
        callback(
          normalized.length >= 2 && normalized.length <= 500
            ? undefined
            : new Error('处理原因必须为 2 至 500 个字符')
        );
      },
      trigger: 'blur'
    }
  ]
};
