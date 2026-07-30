import type { CreateV2CustomerInput, V2Customer, V2OrderEntryCustomer } from './contracts';

export interface V2QuickCustomerForm {
  name: string;
  phone: string;
  wechat: string;
  qq: string;
  whatsapp: string;
  sourceOptionId: string;
  tagOptionIds: string[];
  active: boolean;
  remark: string;
}

export function createEmptyQuickCustomerForm(): V2QuickCustomerForm {
  return {
    name: '',
    phone: '',
    wechat: '',
    qq: '',
    whatsapp: '',
    sourceOptionId: '',
    tagOptionIds: [],
    active: true,
    remark: ''
  };
}

export function createQuickCustomerPayload(form: V2QuickCustomerForm): CreateV2CustomerInput {
  return {
    name: form.name.trim(),
    phone: form.phone.trim() || null,
    wechat: form.wechat.trim() || null,
    qq: form.qq.trim() || null,
    whatsapp: form.whatsapp.trim() || null,
    sourceOptionId: form.sourceOptionId || null,
    tagOptionIds: [...form.tagOptionIds],
    recordStatus: form.active ? 'active' : 'disabled',
    remark: form.remark.trim() || null
  };
}

export function toOrderEntryCustomer(customer: V2Customer): V2OrderEntryCustomer {
  return {
    id: customer.id,
    name: customer.name,
    wechat: customer.wechat,
    qq: customer.qq,
    maskedPhone: customer.maskedPhone,
    maskedWhatsapp: customer.maskedWhatsapp
  };
}
