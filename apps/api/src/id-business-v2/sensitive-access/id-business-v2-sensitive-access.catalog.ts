import { BadRequestException } from '@nestjs/common';

export type IdBusinessV2SensitiveAccessMode =
  | 'denied'
  | 'direct'
  | 'approval_required'
  | 'admin_bypass';

export interface IdBusinessV2SensitiveAccessDescriptor {
  module: string;
  fieldName: string;
  objectType: string;
  permissionCode: string;
  label: string;
}

export const ID_BUSINESS_V2_SENSITIVE_ACCESS_CATALOG = [
  {
    module: 'id_business_v2_account',
    fieldName: 'appleId',
    objectType: 'id_business_v2_account',
    permissionCode: 'apple.account.view_full',
    label: 'Apple ID 账号'
  },
  {
    module: 'id_business_v2_account',
    fieldName: 'password',
    objectType: 'id_business_v2_account',
    permissionCode: 'apple.secret.view_password',
    label: 'Apple ID 密码'
  },
  {
    module: 'id_business_v2_account',
    fieldName: 'phone',
    objectType: 'id_business_v2_account',
    permissionCode: 'apple.secret.view_phone',
    label: 'ID 手机号'
  },
  {
    module: 'id_business_v2_account',
    fieldName: 'securityInfo',
    objectType: 'id_business_v2_account',
    permissionCode: 'apple.secret.view_security',
    label: 'ID 密保资料'
  },
  {
    module: 'id_business_v2_customer',
    fieldName: 'phone',
    objectType: 'id_business_v2_customer',
    permissionCode: 'customer.view_phone',
    label: '客户手机号'
  },
  {
    module: 'id_business_v2_customer',
    fieldName: 'whatsapp',
    objectType: 'id_business_v2_customer',
    permissionCode: 'customer.view_phone',
    label: '客户 WhatsApp'
  },
  {
    module: 'id_business_v2_gift_card',
    fieldName: 'code',
    objectType: 'id_business_v2_gift_card',
    permissionCode: 'apple.gift_card.view_full',
    label: '完整礼品卡号'
  }
] as const satisfies readonly IdBusinessV2SensitiveAccessDescriptor[];

export const ID_BUSINESS_V2_SENSITIVE_PERMISSION_CODES = new Set<string>(
  ID_BUSINESS_V2_SENSITIVE_ACCESS_CATALOG.map((item) => item.permissionCode)
);

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
