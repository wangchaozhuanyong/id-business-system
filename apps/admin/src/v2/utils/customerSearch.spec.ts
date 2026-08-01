import { describe, expect, it } from 'vitest';
import { formatV2CustomerSearchLabel } from './customerSearch';

const customer = {
  id: 'customer-1',
  name: '小明客户',
  wechat: 'ming-wechat',
  qq: '323525',
  maskedPhone: '138****5678',
  maskedWhatsapp: '+60****8899'
};

describe('formatV2CustomerSearchLabel', () => {
  it('shows the WeChat field that matched the keyword', () => {
    expect(formatV2CustomerSearchLabel(customer, 'WECHAT')).toBe('小明客户 / 微信 ming-wechat');
  });

  it('shows the QQ field that matched the keyword', () => {
    expect(formatV2CustomerSearchLabel(customer, '3525')).toBe('小明客户 / QQ 323525');
  });

  it('recognizes a full phone number from its masked prefix and suffix', () => {
    expect(formatV2CustomerSearchLabel(customer, '13800135678')).toBe(
      '小明客户 / 手机 138****5678'
    );
  });

  it('shows masked contact choices when an encrypted contact match cannot be identified locally', () => {
    expect(formatV2CustomerSearchLabel(customer, '00135678')).toBe(
      '小明客户 / 手机 138****5678 · WhatsApp +60****8899'
    );
  });
});
