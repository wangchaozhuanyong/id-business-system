import type { IdBusinessV2SensitiveDisplayMode } from '../sensitive-access/public-api';
import type { CustomerWithRelations } from './persistence/id-business-v2-customer.repository';

export type IdBusinessV2CustomerContactField = 'phone' | 'wechat' | 'qq' | 'whatsapp';

export interface IdBusinessV2CustomerContactPresentation {
  phone: string | null;
  wechat: string | null;
  qq: string | null;
  whatsapp: string | null;
  modes: Record<IdBusinessV2CustomerContactField, IdBusinessV2SensitiveDisplayMode>;
}

export function maskIdBusinessV2CustomerPhone(value: string | null) {
  if (!value) return null;
  if (value.length <= 4) return '****';
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}

export function maskIdBusinessV2CustomerContact(value: string | null) {
  if (!value) return null;
  if (value.length <= 2) return '*'.repeat(value.length);
  if (value.length <= 5) return `${value.slice(0, 1)}***${value.slice(-1)}`;
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

export function toIdBusinessV2CustomerResponse(
  customer: CustomerWithRelations,
  presentation?: IdBusinessV2CustomerContactPresentation
) {
  const fallbackWechat = customer.wechatMasked ?? maskIdBusinessV2CustomerContact(customer.wechat);
  const fallbackQq = customer.qqMasked ?? maskIdBusinessV2CustomerContact(customer.qq);
  return {
    id: customer.id,
    name: customer.name,
    maskedPhone: customer.phoneMasked,
    displayPhone: presentation ? presentation.phone : customer.phoneMasked,
    phoneTail: customer.phoneTail,
    hasPhone: Boolean(customer.phoneEncrypted),
    wechat: presentation ? presentation.wechat : fallbackWechat,
    hasWechat: Boolean(customer.wechatEncrypted || customer.wechat),
    qq: presentation ? presentation.qq : fallbackQq,
    hasQq: Boolean(customer.qqEncrypted || customer.qq),
    maskedWhatsapp: customer.whatsappMasked,
    displayWhatsapp: presentation ? presentation.whatsapp : customer.whatsappMasked,
    whatsappTail: customer.whatsappTail,
    hasWhatsapp: Boolean(customer.whatsappEncrypted),
    contactDisplayModes: presentation?.modes ?? {
      phone: 'masked',
      wechat: 'masked',
      qq: 'masked',
      whatsapp: 'masked'
    },
    sourceOptionId: customer.sourceOptionId,
    source: customer.sourceOption,
    tagOptionIds: customer.tags.map((item) => item.optionId),
    tags: customer.tags.map((item) => item.option),
    serviceOptionIds: customer.services.map((item) => item.optionId),
    services: customer.services.map((item) => ({
      ...item.option,
      firstOpenedAt: item.firstOpenedAt!,
      lastOpenedAt: item.lastOpenedAt!,
      activationCount: item.activationCount
    })),
    recordStatus: customer.recordStatus,
    remark: customer.remark,
    createdBy: customer.createdBy,
    createdAt: customer.createdAt,
    updatedAt: customer.updatedAt
  };
}
