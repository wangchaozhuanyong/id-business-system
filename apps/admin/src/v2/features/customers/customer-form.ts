import type { CreateV2CustomerInput, V2Customer } from './contracts';

export interface CustomerFormState {
  name: string;
  phone: string;
  clearPhone: boolean;
  wechat: string;
  qq: string;
  whatsapp: string;
  clearWhatsapp: boolean;
  sourceOptionId: string;
  tagOptionIds: string[];
  active: boolean;
  remark: string;
}

export function createCustomerPayload(
  form: CustomerFormState,
  editingItem: Pick<V2Customer, 'id'> | null
): CreateV2CustomerInput {
  const payload: CreateV2CustomerInput = {
    name: form.name.trim(),
    wechat: form.wechat.trim() || null,
    qq: form.qq.trim() || null,
    sourceOptionId: form.sourceOptionId || null,
    tagOptionIds: [...form.tagOptionIds],
    recordStatus: form.active ? 'active' : 'disabled',
    remark: form.remark.trim() || null
  };
  if (!editingItem || form.phone.trim()) {
    payload.phone = form.phone.trim() || null;
  } else if (form.clearPhone) {
    payload.phone = null;
  }
  if (!editingItem || form.whatsapp.trim()) {
    payload.whatsapp = form.whatsapp.trim() || null;
  } else if (form.clearWhatsapp) {
    payload.whatsapp = null;
  }
  return payload;
}
