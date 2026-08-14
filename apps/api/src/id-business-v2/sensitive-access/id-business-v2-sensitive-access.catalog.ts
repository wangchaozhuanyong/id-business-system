import { BadRequestException } from '@nestjs/common';

export type IdBusinessV2SensitiveAccessMode =
  | 'denied'
  | 'direct'
  | 'approval_required'
  | 'admin_bypass';

export type IdBusinessV2SensitiveDisplayContext =
  | 'account_management'
  | 'customer_management'
  | 'order_workbench'
  | 'topup_workbench'
  | 'renewal_workbench'
  | 'business_records'
  | 'dashboard_notifications'
  | 'export'
  | 'audit';

export type IdBusinessV2SensitiveDisplayMode =
  | 'hidden'
  | 'masked'
  | 'reveal_direct'
  | 'reveal_approval'
  | 'full';

export const ID_BUSINESS_V2_SENSITIVE_CONTEXT_LABELS: Record<
  IdBusinessV2SensitiveDisplayContext,
  string
> = {
  account_management: 'ID 资料管理',
  customer_management: '客户资料管理',
  order_workbench: '订单录入与修改',
  topup_workbench: '加卡与余额操作',
  renewal_workbench: '续费与售后执行',
  business_records: '业务历史记录',
  dashboard_notifications: '仪表盘与通知',
  export: '导出文件',
  audit: '审计日志'
};

export const ID_BUSINESS_V2_SENSITIVE_MODE_LABELS: Record<
  IdBusinessV2SensitiveDisplayMode,
  string
> = {
  hidden: '不显示',
  masked: '仅脱敏',
  reveal_direct: '点击查看',
  reveal_approval: '审批查看',
  full: '完整显示'
};

export interface IdBusinessV2SensitiveAccessDescriptor {
  key: string;
  module: string;
  fieldName: string;
  objectType: string;
  permissionCode: string;
  label: string;
  secret: boolean;
  contexts: readonly IdBusinessV2SensitiveDisplayContext[];
}

export const ID_BUSINESS_V2_SENSITIVE_ACCESS_CATALOG = [
  {
    key: 'account.apple_id',
    module: 'id_business_v2_account',
    fieldName: 'appleId',
    objectType: 'id_business_v2_account',
    permissionCode: 'apple.account.view_full',
    label: 'Apple ID 账号',
    secret: false,
    contexts: [
      'account_management',
      'order_workbench',
      'topup_workbench',
      'renewal_workbench',
      'business_records',
      'dashboard_notifications',
      'export',
      'audit'
    ]
  },
  {
    key: 'account.password',
    module: 'id_business_v2_account',
    fieldName: 'password',
    objectType: 'id_business_v2_account',
    permissionCode: 'apple.secret.view_password',
    label: 'Apple ID 密码',
    secret: true,
    contexts: ['account_management']
  },
  {
    key: 'account.phone',
    module: 'id_business_v2_account',
    fieldName: 'phone',
    objectType: 'id_business_v2_account',
    permissionCode: 'apple.secret.view_phone',
    label: 'ID 手机号',
    secret: false,
    contexts: ['account_management', 'export', 'audit']
  },
  {
    key: 'account.security_info',
    module: 'id_business_v2_account',
    fieldName: 'securityInfo',
    objectType: 'id_business_v2_account',
    permissionCode: 'apple.secret.view_security',
    label: 'ID 密保资料',
    secret: true,
    contexts: ['account_management']
  },
  {
    key: 'customer.phone',
    module: 'id_business_v2_customer',
    fieldName: 'phone',
    objectType: 'id_business_v2_customer',
    permissionCode: 'customer.view_phone',
    label: '客户手机号',
    secret: false,
    contexts: ['customer_management', 'order_workbench', 'audit']
  },
  {
    key: 'customer.wechat',
    module: 'id_business_v2_customer',
    fieldName: 'wechat',
    objectType: 'id_business_v2_customer',
    permissionCode: 'customer.view_phone',
    label: '客户微信',
    secret: false,
    contexts: ['customer_management', 'order_workbench', 'audit']
  },
  {
    key: 'customer.qq',
    module: 'id_business_v2_customer',
    fieldName: 'qq',
    objectType: 'id_business_v2_customer',
    permissionCode: 'customer.view_phone',
    label: '客户 QQ',
    secret: false,
    contexts: ['customer_management', 'order_workbench', 'audit']
  },
  {
    key: 'customer.whatsapp',
    module: 'id_business_v2_customer',
    fieldName: 'whatsapp',
    objectType: 'id_business_v2_customer',
    permissionCode: 'customer.view_phone',
    label: '客户 WhatsApp',
    secret: false,
    contexts: ['customer_management', 'order_workbench', 'audit']
  },
  {
    key: 'order.website_account',
    module: 'id_business_v2_order',
    fieldName: 'websiteAccount',
    objectType: 'id_business_v2_order',
    permissionCode: 'apple.order.view_website_account',
    label: '订单网站账号',
    secret: false,
    contexts: ['renewal_workbench', 'business_records', 'audit']
  },
  {
    key: 'gift_card.code',
    module: 'id_business_v2_gift_card',
    fieldName: 'code',
    objectType: 'id_business_v2_gift_card',
    permissionCode: 'apple.gift_card.view_full',
    label: '完整礼品卡号',
    secret: false,
    contexts: ['topup_workbench', 'business_records', 'audit']
  }
] as const satisfies readonly IdBusinessV2SensitiveAccessDescriptor[];

export const ID_BUSINESS_V2_SENSITIVE_PERMISSION_CODES = new Set<string>(
  ID_BUSINESS_V2_SENSITIVE_ACCESS_CATALOG.map((item) => item.permissionCode)
);

export function getIdBusinessV2SensitiveDescriptorByKey(fieldKey: string) {
  return ID_BUSINESS_V2_SENSITIVE_ACCESS_CATALOG.find((item) => item.key === fieldKey) ?? null;
}

export function listIdBusinessV2SensitiveDisplayCatalog() {
  return ID_BUSINESS_V2_SENSITIVE_ACCESS_CATALOG.flatMap((descriptor) =>
    descriptor.contexts.map((context) => ({
      fieldKey: descriptor.key,
      fieldLabel: descriptor.label,
      permissionCode: descriptor.permissionCode,
      context,
      contextLabel: ID_BUSINESS_V2_SENSITIVE_CONTEXT_LABELS[context],
      allowedModes: getIdBusinessV2SensitiveAllowedDisplayModes(descriptor, context)
    }))
  );
}

export function getIdBusinessV2SensitiveAllowedDisplayModes(
  descriptor: IdBusinessV2SensitiveAccessDescriptor,
  context: IdBusinessV2SensitiveDisplayContext
): readonly IdBusinessV2SensitiveDisplayMode[] {
  if (context === 'audit') return ['hidden', 'masked'];
  if (descriptor.secret) return ['hidden', 'masked', 'reveal_direct', 'reveal_approval'];
  if (context === 'account_management' || context === 'customer_management') {
    return ['hidden', 'masked', 'reveal_direct', 'reveal_approval', 'full'];
  }
  return ['hidden', 'masked', 'full'];
}

export function requireIdBusinessV2SensitiveAccessDescriptor(input: {
  module?: unknown;
  fieldName?: unknown;
  objectType?: unknown;
}) {
  const descriptor = ID_BUSINESS_V2_SENSITIVE_ACCESS_CATALOG.find(
    (item) =>
      item.module === input.module &&
      item.fieldName === input.fieldName &&
      item.objectType === input.objectType
  );
  if (!descriptor) {
    throw new BadRequestException('敏感资料字段不在允许申请的清单中');
  }
  return descriptor;
}
