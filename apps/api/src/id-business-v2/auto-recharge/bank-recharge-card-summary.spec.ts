import { describe, expect, it } from 'vitest';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import {
  bankRechargeCardNumberSummary,
  encryptedBankRechargeCardSummary,
  readBankRechargeCardSummary
} from './bank-recharge-card-summary';
import { listChatgptAccounts } from './bank-recharge-account-list';

const encryption = new FieldEncryptionService({ get: () => 'synthetic-summary-test' } as never);
const cardNumber = '4111111123456789';
const summary = '4*******23456789';
async function listing(openingCards: unknown[]) {
  const repository = {
    renewalWarningDays: async () => 3,
    listAccounts: async () => [
      { id: 'account', emailHash: 'hash', emailMasked: 'fi***@example.invalid', status: 'active' }
    ],
    subscriptionsForAccounts: async () => [],
    loginNetworksByEmailHashes: async () => [],
    openingCardsForAccounts: async () => openingCards
  };
  return (await listChatgptAccounts({}, repository as never, encryption)).items[0]!.openingCard;
}
describe('开通银行卡脱敏信息', () => {
  it('12 至 19 位卡号仅展示首位与末八位，保留中间掩码', () => {
    for (const length of [12, 15, 16, 19]) {
      const number = `4${'1'.repeat(length - 9)}23456789`;
      expect(bankRechargeCardNumberSummary(number)).toBe(`4${'*'.repeat(length - 9)}23456789`);
    }
    expect(bankRechargeCardNumberSummary('4111 1111-2345 6789')).toBe(summary);
  });
  it('缺少完整卡号时不伪造首位或末八位，非法快照不能暴露完整卡号', () => {
    for (const value of [null, undefined, '', '6789', 'short-card', '4'.repeat(20)])
      expect(bankRechargeCardNumberSummary(value)).toBeNull();
    expect(
      readBankRechargeCardSummary(encryption, encryption.encrypt(cardNumber), null)
    ).toBeNull();
  });
  it('存储加密摘要，删除原卡后仍可回读且不是完整卡号', () => {
    const encrypted = encryptedBankRechargeCardSummary(encryption, encryption.encrypt(cardNumber));
    expect(encrypted).not.toContain(summary);
    expect(encryption.decrypt(encrypted)).toBe(summary);
    expect(readBankRechargeCardSummary(encryption, encrypted, null)).toBe(summary);
  });
  it('已有成功开通记录从真实卡资料补读，未删除时保留卡编号', async () => {
    const card = await listing([
      {
        accountId: 'account',
        card: {
          id: 'card',
          label: '验收卡',
          last4: '6789',
          numberEncrypted: encryption.encrypt(cardNumber)
        }
      }
    ]);
    expect(card).toMatchObject({ id: 'card', numberSummary: summary, deleted: false });
    expect(JSON.stringify(card)).not.toContain(cardNumber);
  });
  it('显示最新成功开通的卡，删除后使用历史快照及显式删除标记', async () => {
    const card = await listing([
      {
        accountId: 'account',
        card: null,
        cardDeletedAt: new Date(),
        cardNumberSummaryEncrypted: encryption.encrypt(summary)
      },
      {
        accountId: 'account',
        card: { id: 'older', numberEncrypted: encryption.encrypt('5555555555554444') }
      }
    ]);
    expect(card).toMatchObject({ id: null, numberSummary: summary, deleted: true });
  });
  it('未记录卡或仅有历史尾四位时不会误报已删除', async () => {
    expect(await listing([])).toBeNull();
    expect(await listing([{ accountId: 'account', card: null, cardLast4: '6789' }])).toMatchObject({
      numberSummary: null,
      deleted: false
    });
  });
});
