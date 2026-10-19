import assert from 'node:assert/strict';
import test from 'node:test';

test('邮箱验证码读取保留数字和混合码，拒绝普通文字并仅回退同封明确验证码', async () => {
  const { isV2MailboxVerificationCode, resolveV2MailboxVerificationCode } =
    await import('../dist/index.js');
  for (const value of ['123456', '012345', '1234', '12345678', 'AB12CD']) {
    assert.equal(isV2MailboxVerificationCode(value), true);
    assert.equal(
      resolveV2MailboxVerificationCode({ subject: '其他服务', extractedCode: value }),
      value
    );
  }
  for (const value of [
    'ChatGPT',
    'continue',
    'password',
    '123',
    '123456789',
    'ABCDEF',
    '123 456'
  ]) {
    assert.equal(isV2MailboxVerificationCode(value), false);
    assert.equal(
      resolveV2MailboxVerificationCode({ subject: '其他服务', extractedCode: value }),
      null
    );
  }
  const mail = {
    subject: 'Your temporary ChatGPT verification code',
    extractedCode: 'ChatGPT',
    bodyText: 'ChatGPT\n\n012345\n\nEnter this code to continue.'
  };
  assert.equal(resolveV2MailboxVerificationCode(mail), '012345');
  assert.equal(resolveV2MailboxVerificationCode({ ...mail, extractedCode: null }), '012345');
  assert.equal(resolveV2MailboxVerificationCode({ ...mail, bodyText: 'ChatGPT\ncontinue' }), null);
  assert.equal(resolveV2MailboxVerificationCode({ ...mail, bodyText: '123456\n654321' }), null);
  assert.equal(
    resolveV2MailboxVerificationCode({ ...mail, bodyText: 'Reference 123456789' }),
    null
  );
  assert.equal(
    resolveV2MailboxVerificationCode({
      subject: 'Other provider',
      bodyText: 'Security code: 654321'
    }),
    '654321'
  );
  assert.equal(
    resolveV2MailboxVerificationCode({ subject: 'Order 123456', bodyText: 'Total: 654321' }),
    null
  );
  assert.equal(
    resolveV2MailboxVerificationCode({
      subject: 'Other provider',
      bodyText: 'Security code: 12345678AB'
    }),
    null
  );
});

test('银充到期按北京时间自然月，含月末、闰年、跨年和秒精度', async () => {
  const { bankRechargeDefaultDueAt } = await import('../dist/index.js');
  for (const [openedAt, dueAt] of [
    ['2026-01-01T10:15:00+08:00', '2026-01-31T02:15:00.000Z'],
    ['2026-02-01T10:15:00+08:00', '2026-02-28T02:15:00.000Z'],
    ['2028-02-01T10:15:00+08:00', '2028-02-29T02:15:00.000Z'],
    ['2026-03-04T10:15:00+08:00', '2026-04-03T02:15:00.000Z'],
    ['2026-12-20T10:15:00+08:00', '2027-01-19T02:15:00.000Z'],
    ['2026-01-31T00:15:13.456+08:00', '2026-02-26T16:15:13.456Z'],
    ['2028-01-31T00:15:00+08:00', '2028-02-27T16:15:00.000Z'],
    ['2026-12-31T00:15:00+08:00', '2027-01-29T16:15:00.000Z']
  ]) {
    assert.equal(bankRechargeDefaultDueAt(openedAt).toISOString(), dueAt);
    const date = new Date(openedAt);
    const original = date.getTime();
    assert.equal(bankRechargeDefaultDueAt(date).toISOString(), dueAt);
    assert.equal(date.getTime(), original);
  }
  assert.throws(() => bankRechargeDefaultDueAt('invalid'), /开通时间无效/);
});

test('邮箱明确码回退校验完整内容，不能截取邮箱、连字符或分组数字前缀', async () => {
  const { resolveV2MailboxVerificationCode } = await import('../dist/index.js');
  for (const token of [
    '1234-5678',
    '123456@example.test',
    '1234 5678',
    '1234 - 5678',
    '1234\n5678',
    '123456.789',
    '123456/789',
    '12345678AB',
    '123456789'
  ]) {
    assert.equal(
      resolveV2MailboxVerificationCode({
        subject: 'Other provider',
        extractedCode: 'continue',
        bodyText: `Security code: ${token}`
      }),
      null,
      token
    );
  }
  for (const bodyText of [
    'Security code: 012345',
    'Security code: 012345\nEnter this code to continue.'
  ]) {
    assert.equal(
      resolveV2MailboxVerificationCode({ subject: 'Other provider', bodyText }),
      '012345'
    );
  }
  assert.equal(
    resolveV2MailboxVerificationCode({
      subject: 'Other provider',
      bodyText: 'Security code: 123456 Verification code: 654321'
    }),
    null
  );
});

test('主题与正文分开扫描，ChatGPT 独立行与带标签候选共用两侧分组校验', async () => {
  const { resolveV2MailboxVerificationCode } = await import('../dist/index.js');
  const subject = 'Your temporary ChatGPT verification code';
  for (const bodyText of [
    '123456\n789',
    'Security code:1234\n567890',
    '123\n456789',
    '123456\n\n789'
  ]) {
    assert.equal(
      resolveV2MailboxVerificationCode({ subject, bodyText, extractedCode: 'ChatGPT' }),
      null,
      bodyText
    );
  }
  for (const bodyText of [
    'Security code:012345',
    'Security code:\n012345',
    'ChatGPT\n012345\nEnter this code to continue.'
  ]) {
    assert.equal(
      resolveV2MailboxVerificationCode({ subject, bodyText, extractedCode: 'ChatGPT' }),
      '012345',
      bodyText
    );
  }
  assert.equal(
    resolveV2MailboxVerificationCode({
      subject: 'Security code:012345',
      bodyText: 'No code in body'
    }),
    '012345'
  );
});

test('loads the compiled shared package with standard Node ESM resolution', async () => {
  const shared = await import('../dist/index.js');

  assert.equal(typeof shared.multiplyDecimalStrings, 'function');
  assert.equal(shared.V2_FINANCE_CURRENCIES.length, 26);
  assert.ok(shared.V2_FINANCE_CURRENCIES.includes('USDT'));
});

test('换汇扣费计算使用十进制且币种中文目录完整', async () => {
  const { calculateFinanceExchange, V2_FINANCE_CURRENCY_OPTIONS } =
    await import('../dist/index.js');
  assert.equal(V2_FINANCE_CURRENCY_OPTIONS.length, 26);
  assert.equal(new Set(V2_FINANCE_CURRENCY_OPTIONS.map((x) => x.code)).size, 26);
  assert.ok(V2_FINANCE_CURRENCY_OPTIONS.every((x) => /[\u4e00-\u9fff]/.test(x.label)));
  for (const currency of ['JPY', 'KRW', 'CLP', 'VND'])
    assert.equal(V2_FINANCE_CURRENCY_OPTIONS.find((x) => x.code === currency).minorUnits, 0);
  const source = calculateFinanceExchange({
    sourceAmount: '1000',
    targetAmount: '600',
    feeAmount: '10',
    feeMode: 'source_extra'
  });
  assert.equal(source.totalDebit, '1010');
  assert.equal(source.feePercent, '1');
  assert.equal(source.exchangeRate, '0.6');
  assert.equal(source.effectiveRate, '0.59405941');
  const target = calculateFinanceExchange({
    sourceAmount: '1000',
    targetAmount: '590',
    feeAmount: '10',
    feeMode: 'target_deducted'
  });
  assert.equal(target.grossTargetAmount, '600');
  assert.equal(target.feePercent, '1.66666667');
  assert.equal(target.exchangeRate, '0.6');
  assert.equal(target.effectiveRate, '0.59');
  assert.equal(
    calculateFinanceExchange({
      sourceAmount: '9999999999999',
      targetAmount: '9999999999999',
      feeAmount: '0.0001',
      feeMode: 'source_extra'
    }).totalDebit,
    '9999999999999.0001'
  );
  for (const feeMode of ['source_extra', 'target_deducted'])
    assert.equal(
      calculateFinanceExchange({
        sourceAmount: '0.0001',
        targetAmount: '1',
        feeAmount: '0',
        feeMode
      }).feePercent,
      '0'
    );
  for (const amount of ['0', '-1', '1.00001', '100000000000000', 'NaN'])
    assert.throws(() =>
      calculateFinanceExchange({
        sourceAmount: amount,
        targetAmount: '1',
        feeAmount: '0',
        feeMode: 'source_extra'
      })
    );
});

test('退役自动注册不再参与实时范围，共享邮箱和充值范围保留', async () => {
  const { V2_DATA_SCOPES, isV2DataScope, expandV2DataScopes } = await import('../dist/index.js');
  assert.equal(V2_DATA_SCOPES.includes('auto-registration'), false);
  assert.equal(isV2DataScope('auto-registration'), false);
  assert.equal(isV2DataScope('auto-recharge'), true);
  assert.equal(isV2DataScope('vendure-mailbox'), true);
  const scopes = expandV2DataScopes(['auto-recharge', 'vendure-mailbox']);
  assert.equal(scopes.includes('auto-recharge'), true);
  assert.equal(scopes.includes('vendure-mailbox'), true);
  assert.equal(scopes.includes('auto-registration'), false);
});

test('普通订单币种契约与持久化兼容映射一致，财务扩展币种保持独立', async () => {
  const {
    V2_ORDER_RECEIPT_CURRENCIES,
    V2_FINANCE_CURRENCIES,
    isV2OrderReceiptCurrency,
    legacyFinanceCurrency
  } = await import('../dist/index.js');
  assert.deepEqual(V2_ORDER_RECEIPT_CURRENCIES, ['CNY', 'MYR', 'USD', 'USDT']);
  for (const currency of V2_FINANCE_CURRENCIES) {
    const supported = V2_ORDER_RECEIPT_CURRENCIES.includes(currency);
    assert.equal(isV2OrderReceiptCurrency(currency), supported);
    if (supported) assert.equal(legacyFinanceCurrency(currency), currency);
    else assert.throws(() => legacyFinanceCurrency(currency), /原业务不支持该币种/);
  }
  for (const value of [null, undefined, '', 'cny', 'UNKNOWN', 1])
    assert.equal(isV2OrderReceiptCurrency(value), false);
  assert.equal(V2_FINANCE_CURRENCIES.length, 26);
});

test('人工结单标记在标准 Node ESM 中保持原单绑定，失败不能覆盖成功证据', async () => {
  const { readV2RechargeManualSettlement } = await import('../dist/index.js');
  const proof = {
    version: 1,
    outcome: 'failure',
    operationId: '11111111-1111-4111-8111-111111111111',
    sourceJobId: '22222222-2222-4222-8222-222222222222',
    operatorId: '33333333-3333-4333-8333-333333333333',
    accountKey: 'a'.repeat(64),
    identifier: 'oaics_synthetic',
    plan: 'plus',
    resolvedAt: '2026-10-19T00:00:00.000Z',
    requestDigest: 'b'.repeat(64)
  };
  const document = {
    checkout_identifier: proof.identifier,
    target_plan: 'plus',
    manual_settlement: proof
  };
  assert.equal(readV2RechargeManualSettlement(document)?.outcome, 'failure');
  for (const patch of [
    { payment_status: 'paid' },
    { payment_evidence: {} },
    { status: 'subscription_activated' },
    { checkout_identifier: 'oaics_other' }
  ])
    assert.equal(readV2RechargeManualSettlement({ ...document, ...patch }), undefined);
  assert.equal(
    readV2RechargeManualSettlement({
      ...document,
      manual_settlement: { ...proof, untrusted: true }
    }),
    undefined
  );
  assert.equal(
    readV2RechargeManualSettlement({
      ...document,
      manual_settlement: { ...proof, outcome: 'success' }
    }),
    undefined
  );
  assert.equal(
    readV2RechargeManualSettlement({
      ...document,
      manual_settlement: {
        ...proof,
        outcome: 'success',
        orderId: '44444444-4444-4444-8444-444444444444'
      }
    })?.outcome,
    'success'
  );
});
