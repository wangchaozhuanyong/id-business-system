import { describe, expect, it } from 'vitest';
import { createCustomerPayload, type CustomerFormState } from './customer-form';

function makeForm(overrides: Partial<CustomerFormState> = {}): CustomerFormState {
  return {
    name: ' 客户 A ',
    phone: '',
    clearPhone: false,
    wechat: ' wx-a ',
    clearWechat: false,
    qq: ' 10001 ',
    clearQq: false,
    whatsapp: '',
    clearWhatsapp: false,
    sourceOptionId: 'source-1',
    tagOptionIds: ['tag-1'],
    active: true,
    remark: ' 备注 ',
    ...overrides
  };
}

describe('customer form payload', () => {
  it('includes QQ and WhatsApp when formally creating a customer', () => {
    expect(
      createCustomerPayload(
        makeForm({
          phone: ' 13800138000 ',
          whatsapp: ' +60 12-345 6789 '
        }),
        null
      )
    ).toEqual({
      name: '客户 A',
      phone: '13800138000',
      wechat: 'wx-a',
      qq: '10001',
      whatsapp: '+60 12-345 6789',
      sourceOptionId: 'source-1',
      tagOptionIds: ['tag-1'],
      recordStatus: 'active',
      remark: '备注'
    });
  });

  it('keeps sensitive contacts when edit inputs are blank', () => {
    const payload = createCustomerPayload(makeForm(), { id: 'customer-1' });

    expect(payload).not.toHaveProperty('phone');
    expect(payload).not.toHaveProperty('whatsapp');
  });

  it('clears WhatsApp only through the explicit clear option', () => {
    const payload = createCustomerPayload(makeForm({ clearWhatsapp: true }), { id: 'customer-1' });

    expect(payload.whatsapp).toBeNull();
  });
});
