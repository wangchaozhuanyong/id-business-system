import type { CreateV2CustomerInput, V2Customer } from './contracts';

export interface CustomerFormState {
  name: string;
  phone: string;
  clearPhone: boolean;
  wechat: string;
  clearWechat: boolean;
  qq: string;
  clearQq: boolean;
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
    sourceOptionId: form.sourceOptionId || null,
    tagOptionIds: [...form.tagOptionIds],
    recordStatus: form.active ? 'active' : 'disabled',
    remark: form.remark.trim() || null
  };
  if (!editingItem || form.wechat.trim()) {
    payload.wechat = form.wechat.trim() || null;
  } else if (form.clearWechat) {
    payload.wechat = null;
  }
  if (!editingItem || form.qq.trim()) {
    payload.qq = form.qq.trim() || null;
  } else if (form.clearQq) {
    payload.qq = null;
  }
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
