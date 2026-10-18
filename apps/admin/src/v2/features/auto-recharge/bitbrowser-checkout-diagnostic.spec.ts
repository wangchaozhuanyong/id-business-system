import { describe, expect, it } from 'vitest';
import { sanitizeV2CheckoutDiagnostic } from '@apple-business/shared';
import {
  CHECKOUT_ERROR_BODY_LIMIT,
  checkoutErrorDiagnostic
} from './bitbrowser-checkout-diagnostic';

describe('建单失败正文仅在内存分类', () => {
  it.each([
    [{ body: 'x'.repeat(CHECKOUT_ERROR_BODY_LIMIT + 1) }, 'oversized'],
    [{ body: 'private-base64', base64Encoded: true }, 'base64'],
    [{ body: 123 }, 'unavailable'],
    [{ body: '   ' }, 'empty']
  ])('读取边界%j：%s', (body, state) => {
    expect(checkoutErrorDiagnostic(body).body_state).toBe(state);
  });
  it('FastAPI字符串detail可分类；分类不是已证实根因，正文不持久化', () => {
    const output = checkoutErrorDiagnostic({
      body: JSON.stringify({
        detail: 'An existing checkout is pending PRIVATE_TOKEN 4242424242424242'
      })
    });
    expect(output).toMatchObject({
      body_state: 'parsed_json',
      categories: ['pending_checkout'],
      attribution: 'message_pattern'
    });
    expect(JSON.stringify(output)).not.toMatch(/PRIVATE_TOKEN|4242424242424242/);
  });
  it('未知字符串detail明确标为未归因，不能凭HTTP400推断参数、点击或账号根因', () => {
    expect(checkoutErrorDiagnostic({ body: '{"detail":"Something happened PRIVATE"}' })).toEqual({
      body_state: 'parsed_json',
      code_present: false,
      param_present: false,
      categories: [],
      attribution: 'unclassified'
    });
  });
  it('结构化校验列表只保留已知代码和参数路径，不保留输入值', () => {
    const output = checkoutErrorDiagnostic({
      body: JSON.stringify({
        detail: [
          {
            type: 'missing',
            loc: ['body', 'billing_details', 'country'],
            msg: 'Field required',
            input: 'PRIVATE'
          }
        ]
      })
    });
    expect(output).toMatchObject({
      code: 'missing',
      param: 'billing_details.country',
      attribution: 'structured_code'
    });
    expect(JSON.stringify(output)).not.toMatch(/PRIVATE|input|Field required/);
  });
  it('非JSON响应也只产生分类，不保留HTML、正文或URL', () => {
    const output = checkoutErrorDiagnostic({
      body: '<html>Too many requests https://private.invalid</html>'
    });
    expect(output).toMatchObject({
      body_state: 'plain_text',
      categories: ['rate_limit'],
      attribution: 'message_pattern'
    });
    expect(JSON.stringify(output)).not.toMatch(/html|private.invalid/);
  });
  it('看似正常代码格式的秘密和未知参数不能穿过白名单', () => {
    const output = checkoutErrorDiagnostic({
      body: JSON.stringify({
        error: {
          code: 'private_token_that_looks_like_a_code',
          param: 'sessionToken',
          message: 'PRIVATE'
        }
      })
    });
    expect(output).toMatchObject({
      code_present: true,
      param_present: true,
      attribution: 'unclassified'
    });
    expect(output).not.toHaveProperty('code');
    expect(output).not.toHaveProperty('param');
    expect(
      sanitizeV2CheckoutDiagnostic({
        ...output,
        request_index: -1,
        body: 'PRIVATE',
        categories: ['private']
      })
    ).toEqual({
      body_state: 'parsed_json',
      code_present: true,
      param_present: true,
      attribution: 'unclassified',
      categories: []
    });
  });
});
