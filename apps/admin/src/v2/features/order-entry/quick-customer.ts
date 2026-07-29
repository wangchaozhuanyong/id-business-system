import type { CreateV2CustomerInput, V2Customer, V2OrderEntryCustomer } from './contracts';

export interface V2QuickCustomerForm {
  name: string;
  phone: string;
  wechat: string;
  sourceOptionId: string;
  tagOptionIds: string[];
  serviceOptionIds: string[];
  active: boolean;
  remark: string;
}

export function createEmptyQuickCustomerForm(): V2QuickCustomerForm {
  return {
    name: '',
    phone: '',
    wechat: '',
    sourceOptionId: '',
    tagOptionIds: [],
    serviceOptionIds: [],
    active: true,
    remark: ''
  };
}

export function createQuickCustomerPayload(form: V2QuickCustomerForm): CreateV2CustomerInput {
  return {
    name: form.name.trim(),
    phone: form.phone.trim() || null,
    wechat: form.wechat.trim() || null,
    sourceOptionId: form.sourceOptionId || null,
    tagOptionIds: [...form.tagOptionIds],
    serviceOptionIds: [...form.serviceOptionIds],
    recordStatus: form.active ? 'active' : 'disabled',
    remark: form.remark.trim() || null
  };
}

export function toOrderEntryCustomer(customer: V2Customer): V2OrderEntryCustomer {
  return {
    id: customer.id,
    name: customer.name,
    wechat: customer.wechat,
    maskedPhone: customer.maskedPhone
  };
}
