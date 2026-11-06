import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api/apiError';
import {
  DirectPaymentDiagnosticError,
  directPaymentDiagnosticLabels,
  directPaymentFailure,
  directPaymentOperation,
  directPaymentOperations,
  type DirectPaymentOperation
} from './bitbrowser-payment-diagnostics';

describe('网页付款受控诊断', () => {
  it.each(Object.keys(directPaymentOperations) as DirectPaymentOperation[])(
    '%s保留操作停点，未知异常正文不进入受控错误',
    async (operation) => {
      const secret =
        'synthetic-private-token 4242424242424242 https://invalid.test/?secret=private';
      const failure = await directPaymentOperation(operation, async () => {
        throw new Error(secret);
      }).catch((cause: unknown) => cause as DirectPaymentDiagnosticError);
      expect(failure.facts).toEqual({
        stage: directPaymentOperations[operation][0],
        reason: directPaymentOperations[operation][1],
        error_type: 'Error'
      });
      expect(Object.hasOwn(directPaymentDiagnosticLabels, failure.facts.reason)).toBe(true);
      expect(JSON.stringify(failure)).not.toContain(secret);
      expect(failure.message).not.toContain(secret);
      expect(failure).not.toHaveProperty('cause');
    }
  );
  it.each([
    ['官网付款币种与锁定币种不一致。', 'payment_currency_mismatch'],
    ['官网页面与结算接口金额不一致。', 'direct_payment_quote_amount_mismatch'],
    ['官网重新计税的账单资料与本次填写不一致。', 'direct_payment_quote_billing_mismatch'],
    ['official_payment_field_not_ready', 'official_payment_field_not_ready']
  ])('只保留已知错误的受控原因：%s', (message, reason) => {
    expect(directPaymentFailure(new Error(message), 'quote_validation').facts.reason).toBe(reason);
  });
  it.each(['__proto__', 'constructor', 'unknown_reason', 'payment_currency_mismatch PRIVATE'])(
    '任意字符串或字典原型不能成为reason：%s',
    (message) => {
      expect(directPaymentFailure(new Error(message), 'quote_read').facts.reason).toBe(
        'direct_payment_quote_read_failed'
      );
    }
  );
  it('后端拒绝仅保存HTTP状态，不保存原异常正文', () => {
    const failure = directPaymentFailure(
      new ApiError('synthetic-private-body', {
        kind: 'conflict',
        code: 'CONFLICT',
        status: 409,
        retryable: false
      }),
      'expired_authorization'
    );
    expect(failure.facts).toMatchObject({
      stage: 'expired_checkout_authorization',
      reason: 'direct_payment_expired_authorization_failed',
      http_status: 409
    });
    expect(failure.message).toContain('HTTP 409');
    expect(JSON.stringify(failure)).not.toContain('synthetic-private-body');
  });
  it.each([0, 99, 600, 401.5, NaN, '401', null])('非法HTTP状态%j不进入回执', (status) => {
    expect(
      new DirectPaymentDiagnosticError('quote_read', undefined, { http_status: status as number })
        .facts
    ).not.toHaveProperty('http_status');
  });
  it('不信任异常对象自行附带的reason、HTTP和正文', () => {
    const failure = directPaymentFailure(
      { reason: 'payment_quote_changed', http_status: 401, body: 'synthetic-private' },
      'existing_checkout_read'
    );
    expect(failure.facts).toEqual({
      stage: 'existing_checkout_read',
      reason: 'direct_payment_existing_checkout_read_failed'
    });
  });
  it('外层操作不会覆盖内层已经核实的停点与安全元数据', async () => {
    const original = new DirectPaymentDiagnosticError(
      'quote_read',
      'existing_checkout_unavailable',
      { http_status: 410, page_state: 'official_error' }
    );
    const failure = await directPaymentOperation('confirmation', async () => {
      throw original;
    }).catch((cause: unknown) => cause);
    expect(failure).toBe(original);
    expect(original.facts).toEqual({
      stage: 'quote_read',
      reason: 'existing_checkout_unavailable',
      http_status: 410,
      page_state: 'official_error'
    });
  });
  it('只允许受控建单诊断跨回调边界，原响应和凭据被再次过滤', () => {
    const failure = new DirectPaymentDiagnosticError(
      'checkout_create',
      'official_checkout_http_failed',
      {
        http_status: 400,
        diagnostics: {
          checkout_error: {
            request_index: 1,
            body_state: 'parsed_json',
            code: 'invalid_request_error',
            param: 'plan_name',
            categories: ['plan_validation'],
            attribution: 'structured_code',
            body: 'PRIVATE',
            headers: { authorization: 'PRIVATE' }
          } as never
        }
      }
    );
    expect(failure.facts).toMatchObject({
      http_status: 400,
      diagnostics: {
        checkout_error: {
          request_index: 1,
          code: 'invalid_request_error',
          param: 'plan_name',
          attribution: 'structured_code'
        }
      }
    });
    expect(JSON.stringify(failure)).not.toContain('PRIVATE');
  });
});
