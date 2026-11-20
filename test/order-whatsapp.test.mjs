import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatOrderPhone, orderPhoneKey, splitOrderPhone, validOrderPhone,
  formatOrderWhatsApp, orderWhatsAppKey, splitOrderWhatsApp, validOrderWhatsApp
} from '../modules/orders/order-whatsapp.mjs';

test('WhatsApp 区号只在号码填写后加入，可粘贴完整国际号码覆盖默认区号', () => {
  assert.deepEqual(splitOrderWhatsApp(''), { code: '86', national: '' });
  assert.equal(formatOrderWhatsApp('86', ''), '');
  assert.equal(formatOrderWhatsApp('86', '138 0000 0000'), '+8613800000000');
  for (const pasted of ['＋６０ ５６４５４５５', '0060-5645455', 'https://wa.me/605645455']) {
    const parts = splitOrderWhatsApp(pasted);
    assert.deepEqual(parts, { code: '60', national: '5645455' });
    assert.equal(formatOrderWhatsApp(parts.code, parts.national), '+605645455');
    assert.equal(orderWhatsAppKey(pasted), '+605645455');
  }
  assert.deepEqual(splitOrderWhatsApp('+852 2123 4567'), { code: '852', national: '21234567' });
  assert.equal(orderWhatsAppKey('605645455'), '+605645455');
  assert.equal(orderWhatsAppKey('13800000000'), '+8613800000000');
  assert.equal(orderWhatsAppKey('WA-演示'), 'wa-演示');
});

test('WhatsApp 对不完整、未知区号与过长输入保留可修正的值', () => {
  for (const value of ['+86', '+00012345678', '+9991234567', '+601234567890123456', 'wa-account']) {
    assert.equal(validOrderWhatsApp(value), false);
  }
  assert.equal(formatOrderWhatsApp('86', '+9991234567'), '+9991234567');
  assert.equal(formatOrderWhatsApp('86', 'wa-account'), 'wa-account');
  assert.equal(validOrderWhatsApp('+605645455'), true);
});

test('联系电话默认中国，也可粘贴带国际区号的号码', () => {
  assert.deepEqual(splitOrderPhone(''), { code: '86', national: '' });
  assert.equal(formatOrderPhone('86', ''), '');
  assert.equal(formatOrderPhone('86', '138 0000 0000'), '+8613800000000');
  for (const pasted of ['＋６０ ５６４５４５５', '0060-5645455']) {
    const { code, national } = splitOrderPhone(pasted);
    assert.deepEqual({ code, national }, { code: '60', national: '5645455' });
    assert.equal(formatOrderPhone(code, national), '+605645455');
    assert.equal(orderPhoneKey(pasted), '+605645455');
    assert.equal(validOrderPhone(pasted), true);
  }
  assert.equal(formatOrderPhone('86', '010-6500 1234'), '+861065001234');
  assert.equal(orderPhoneKey('010-6500 1234'), '+861065001234');
  assert.equal(orderPhoneKey('+86 (010) 6500 1234'), '+861065001234');
  assert.equal(orderPhoneKey('13800000000'), '+8613800000000');
});

test('联系电话保留未知的历史内容，不猜测国外裸号或解析 WhatsApp 链接', () => {
  assert.equal(orderPhoneKey('605645455'), '605645455');
  assert.equal(orderPhoneKey('电话待确认'), '电话待确认');
  assert.equal(orderPhoneKey('https://wa.me/605645455'), 'https://wa.me/605645455');
  for (const value of ['+86', '+9991234567', 'https://wa.me/605645455', '605645455'])
    assert.equal(validOrderPhone(value), false);
});
