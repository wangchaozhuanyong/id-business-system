import type { FormRules } from 'element-plus';
import type { V2RechargeDetails } from './contracts';

export const rechargeFields: {
  key: keyof V2RechargeDetails;
  label: string;
  required?: boolean;
  secret?: boolean;
  max: number;
  placeholder?: string;
}[] = [
  { key: 'number', label: '银行卡号', required: true, secret: true, max: 23 },
  { key: 'name', label: '持卡人姓名', required: true, max: 120 },
  { key: 'expiry', label: '有效期', required: true, max: 5, placeholder: 'MM/YY' },
  { key: 'cvc', label: '安全码', required: true, secret: true, max: 4 },
  { key: 'email', label: '账单邮箱', required: true, max: 250 },
  { key: 'country', label: '账单国家', required: true, max: 2, placeholder: '两位代码，如 MY' },
  { key: 'line1', label: '街道地址', required: true, max: 250 },
  { key: 'line2', label: '补充地址', max: 250, placeholder: '门牌、楼层等（选填）' },
  { key: 'city', label: '城市', required: true, max: 120 },
  { key: 'state', label: '州／省', max: 120, placeholder: '按账单填写（选填）' },
  { key: 'postal_code', label: '邮编', required: true, max: 20 }
];

export function formatRechargeExpiry(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 4);
  return digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
}

export function rechargeFieldError(key: keyof V2RechargeDetails, value: string): string {
  const field = rechargeFields.find((item) => item.key === key)!;
  if (!value.trim()) return field.required ? `请填写${field.label}` : '';
  if (
    value.length > field.max ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
    return `${field.label}格式无效`;
  if (key === 'number') {
    const digits = value.replace(/[ -]/g, '');
    if (!/^\d{13,19}$/.test(digits)) return '请填写 13 至 19 位银行卡号';
    const sum = [...digits].reverse().reduce((total, digit, index) => {
      const n = Number(digit) * (index % 2 ? 2 : 1);
      return total + (n > 9 ? n - 9 : n);
    }, 0);
    if (sum % 10) return '银行卡号校验未通过';
  }
  if (key === 'expiry' && !/^(0[1-9]|1[0-2])\/\d{2}$/.test(value)) return '请使用 MM/YY 格式';
  if (key === 'cvc' && !/^\d{3,4}$/.test(value)) return '请填写 3 至 4 位安全码';
  if (key === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return '请填写有效账单邮箱';
  if (key === 'country' && !/^[A-Za-z]{2}$/.test(value)) return '请填写两位国家代码';
  return '';
}

export function rechargeDetailsReady(details: V2RechargeDetails): boolean {
  return rechargeFields.every((field) => !rechargeFieldError(field.key, details[field.key]));
}

export const rechargeRules: FormRules<V2RechargeDetails> = Object.fromEntries(
  rechargeFields.map((field) => [
    field.key,
    [
      {
        trigger: ['blur', 'change'],
        validator: (_rule: unknown, value: string, callback: (error?: Error) => void) => {
          const message = rechargeFieldError(field.key, value);
          callback(message ? new Error(message) : undefined);
        }
      }
    ]
  ])
);
