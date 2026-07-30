import { describe, expect, it } from 'vitest';
import type { V2Customer } from '@/v2/types/records';
import {
  createEmptyQuickCustomerForm,
  createQuickCustomerPayload,
  toOrderEntryCustomer
} from './quick-customer';

describe('order entry quick customer', () => {
  it('normalizes optional fields before creating a customer', () => {
    const form = createEmptyQuickCustomerForm();
    Object.assign(form, {
      name: '  小明  ',
      phone: ' 13800138000 ',
      wechat: ' ',
      qq: ' 10001 ',
      whatsapp: ' +60 12-345 6789 ',
      sourceOptionId: 'source-1',
      tagOptionIds: ['tag-1'],
      active: false,
      remark: '  首次下单  '
    });

    expect(createQuickCustomerPayload(form)).toEqual({
      name: '小明',
      phone: '13800138000',
      wechat: null,
      qq: '10001',
      whatsapp: '+60 12-345 6789',
      sourceOptionId: 'source-1',
      tagOptionIds: ['tag-1'],
      recordStatus: 'disabled',
      remark: '首次下单'
    });
  });

  it('maps the created record into the order customer selector shape', () => {
    const customer = {
      id: 'customer-1',
      name: '小明',
      wechat: 'xiaoming',
      qq: '10001',
      maskedPhone: '138****8000',
      maskedWhatsapp: '+60****6789'
    } as V2Customer;

    expect(toOrderEntryCustomer(customer)).toEqual({
      id: 'customer-1',
      name: '小明',
      wechat: 'xiaoming',
      qq: '10001',
      maskedPhone: '138****8000',
      maskedWhatsapp: '+60****6789'
    });
  });
});
