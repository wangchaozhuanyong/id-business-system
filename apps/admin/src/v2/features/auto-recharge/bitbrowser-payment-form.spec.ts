import { afterEach, describe, expect, it, vi } from 'vitest';
import type { V2RechargeDetails } from './contracts';
import type { DirectPaymentFrame, DirectPaymentSession } from './bitbrowser-payment-session';
import { fillDirectPaymentForm, verifyDirectPaymentForm } from './bitbrowser-payment-form';

class Input {
  private current = '';
  writes = 0;
  disabled = false;
  readOnly = false;
  hidden = false;
  checked = false;
  name = '';
  type = 'text';
  labels: { textContent: string }[] = [];
  events: string[] = [];
  afterBlur?: () => void;
  constructor(
    public autocomplete: string,
    initial = ''
  ) {
    this.current = initial;
  }
  get value() {
    return this.current;
  }
  set value(value: string) {
    this.current = value;
    this.writes++;
  }
  getClientRects() {
    return this.hidden ? [] : [{}];
  }
  focus() {}
  blur() {
    this.afterBlur?.();
  }
  dispatchEvent(event: Event) {
    this.events.push(event.type);
    return true;
  }
  click() {
    this.checked = !this.checked;
    this.events.push('click');
  }
}
class Select extends Input {
  constructor(
    autocomplete: string,
    public options: { value: string; textContent: string }[],
    value = ''
  ) {
    super(autocomplete, value);
  }
  get value() {
    return super.value;
  }
  set value(value: string) {
    super.value = value;
  }
  get selectedOptions() {
    return this.options.filter((option) => option.value === this.value);
  }
}
const details: V2RechargeDetails = {
  number: '4242424242424242',
  expiry: '12/39',
  cvc: '123',
  name: 'Synthetic Buyer',
  email: 'buyer@example.invalid',
  country: 'US',
  line1: '123 Test Street',
  line2: '',
  city: 'Test City',
  state: 'CA',
  postal_code: '90001'
};
function frame(id: string, url: string, nodes: Input[], actualUrl = url) {
  const document = {
    querySelectorAll(selector: string) {
      return nodes.filter((node) =>
        selector.split(',').some((part) => {
          if (part.startsWith('select') !== node instanceof Select) return false;
          const attributes = [...part.matchAll(/\[(autocomplete|name|type)(~?=)"([^"]*)"\]/g)];
          return (
            attributes.length > 0 &&
            attributes.every((attribute) => {
              const value = node[attribute[1] as 'autocomplete' | 'name' | 'type'];
              return attribute[2] === '~='
                ? value.split(/\s+/).includes(attribute[3]!)
                : value === attribute[3];
            })
          );
        })
      );
    }
  };
  const evaluate = vi.fn(async (expression: string) => {
    const run = new Function(
      'document',
      'location',
      'getComputedStyle',
      'HTMLInputElement',
      'HTMLSelectElement',
      'Event',
      `return (${expression});`
    );
    return run(
      document,
      new URL(actualUrl),
      () => ({ display: 'block', visibility: 'visible' }),
      Input,
      Select,
      Event
    );
  });
  return { id, url, evaluate } as DirectPaymentFrame & { evaluate: typeof evaluate };
}
function fixture(options: { minimal?: boolean; countryLabel?: boolean } = {}) {
  const country = new Select('country', [
    { value: options.countryLabel ? 'United States' : 'US', textContent: 'United States' }
  ]);
  const fields = {
    number: new Input('cc-number'),
    expiry: new Input('cc-exp'),
    cvc: new Input('cc-csc'),
    name: new Input('name'),
    email: new Input('email'),
    country,
    line1: new Input('address-line1'),
    line2: new Input('address-line2'),
    city: new Input('address-level2'),
    state: new Input('address-level1'),
    postal_code: new Input('postal-code')
  };
  const billingNodes = [
    fields.country,
    fields.name,
    fields.line1,
    fields.city,
    fields.postal_code,
    ...(options.minimal ? [] : [fields.email, fields.line2, fields.state])
  ];
  const root = frame(
    'main',
    'https://chatgpt.com/checkout/openai_llc/oaics_synthetic',
    billingNodes
  );
  const cardFrames = [
    frame('card-number-oopif', 'https://js.stripe.com/v3/card', [fields.number]),
    frame('card-expiry-oopif', 'https://js.stripe.com/v3/expiry', [fields.expiry]),
    frame('card-cvc-oopif', 'https://js.stripe.com/v3/cvc', [fields.cvc])
  ];
  const frames: DirectPaymentFrame[] = [root, ...cardFrames];
  const controller = new AbortController();
  const session: DirectPaymentSession = {
    signal: controller.signal,
    evaluate: root.evaluate,
    frames: vi.fn(async () => frames)
  };
  return { session, controller, fields, frames, root, billingNodes };
}
afterEach(() => vi.useRealTimers());

describe('网页直连官方支付表单', () => {
  it('跨三个独立卡片 OOPIF 填写并回读，不返回或保存卡片内容', async () => {
    const f = fixture();
    const untrusted = frame('other', 'https://third-party.example.invalid/', [
      new Input('cc-number')
    ]);
    f.frames.push(untrusted);
    expect(
      await fillDirectPaymentForm(f.session, { ...details }, Date.now() + 2000)
    ).toBeUndefined();
    for (const field of [
      'number',
      'expiry',
      'cvc',
      'name',
      'email',
      'line1',
      'city',
      'state',
      'postal_code'
    ] as const) {
      expect(f.fields[field].value).toBe(details[field]);
      expect(f.fields[field].events).toEqual(['input', 'change']);
    }
    expect(untrusted.evaluate).not.toHaveBeenCalled();
    await expect(
      verifyDirectPaymentForm(f.session, details, Date.now() + 2000)
    ).resolves.toBeUndefined();
    const responses = await Promise.all(f.root.evaluate.mock.results.map((item) => item.value));
    expect(JSON.stringify(responses)).not.toContain(details.number);
    expect(JSON.stringify(responses)).not.toContain(details.cvc);
  });

  it('任何卡片字段重复时，第一次写入前停止', async () => {
    const f = fixture();
    f.frames.push(frame('duplicate', 'https://js.stripe.com/v3/other', [new Input('cc-number')]));
    await expect(fillDirectPaymentForm(f.session, details, Date.now() + 1000)).rejects.toThrow(
      'ambiguous_official_payment_field'
    );
    expect(Object.values(f.fields).every((field) => field.writes === 0)).toBe(true);
  });

  it('全部卡片控件均可编辑后才开始填写', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.fields.cvc.disabled = true;
    const result = fillDirectPaymentForm(f.session, details, Date.now() + 2000);
    await vi.advanceTimersByTimeAsync(50);
    expect(f.fields.number.writes).toBe(0);
    f.fields.cvc.disabled = false;
    await vi.advanceTimersByTimeAsync(100);
    await result;
    expect(f.fields.number.value).toBe(details.number);
  });

  it('读取唯一控件后、真正填写前出现重复控件时也不猜选', async () => {
    const f = fixture();
    const nodes = [f.fields.number];
    const card = frame('card', 'https://js.stripe.com/v3/card', nodes);
    const evaluate = card.evaluate.getMockImplementation()!;
    card.evaluate.mockImplementation(async (expression) => {
      if (expression.includes('"mode":"fill"')) nodes.push(new Input('cc-number'));
      return evaluate(expression);
    });
    f.frames.splice(1, 1, card);
    await expect(fillDirectPaymentForm(f.session, details, Date.now() + 1000)).rejects.toThrow(
      'payment_form_changed'
    );
    expect(f.fields.number.writes).toBe(0);
  });

  it('国家选项仅提供完整名称时能匹配ISO国家代码', async () => {
    const f = fixture({ countryLabel: true });
    await fillDirectPaymentForm(f.session, details, Date.now() + 1000);
    expect(f.fields.country.value).toBe('United States');
  });

  it('州文本框与下拉框短暂并存时只选择明确匹配的下拉选项', async () => {
    const f = fixture();
    const select = new Select('address-level1', [{ value: 'CA', textContent: 'California' }]);
    f.billingNodes.push(select);
    await fillDirectPaymentForm(f.session, details, Date.now() + 1000);
    expect(select.value).toBe('CA');
    expect(f.fields.state.writes).toBe(0);
  });

  it('街道失焦后改变 autocomplete，仍以当前精确值回读', async () => {
    const f = fixture();
    f.fields.line1.afterBlur = () => {
      f.fields.line1.autocomplete = 'disabled';
    };
    await fillDirectPaymentForm(f.session, details, Date.now() + 1000);
    expect(f.fields.line1.autocomplete).toBe('disabled');
    f.fields.line1.value = 'Changed Street';
    await expect(verifyDirectPaymentForm(f.session, details, Date.now() + 5)).rejects.toThrow();
  });

  it('官网未索取邮箱及空的可选地址行和州时不虚构字段', async () => {
    const f = fixture({ minimal: true });
    await fillDirectPaymentForm(f.session, { ...details, state: '' }, Date.now() + 1000);
    expect(f.fields.email.writes).toBe(0);
    expect(f.fields.state.writes).toBe(0);
  });

  it('已填卡片或账单被改写时拒绝通过回读', async () => {
    const f = fixture();
    await fillDirectPaymentForm(f.session, details, Date.now() + 1000);
    f.fields.number.value = '5555555555554444';
    await expect(verifyDirectPaymentForm(f.session, details, Date.now() + 1000)).rejects.toThrow(
      'payment_form_changed'
    );
    f.fields.number.value = details.number;
    f.fields.city.value = 'Other City';
    await expect(verifyDirectPaymentForm(f.session, details, Date.now() + 1000)).rejects.toThrow(
      'billing_fields_changed'
    );
  });

  it.each([
    'http://js.stripe.com/',
    'https://js.stripe.com.evil.invalid/',
    'https://user@js.stripe.com/',
    'https://js.stripe.com:444/'
  ])('不向不可信frame发送任何字段：%s', async (url) => {
    const f = fixture();
    const unsafe = frame('unsafe', url, [new Input('cc-number')]);
    f.frames.push(unsafe);
    await fillDirectPaymentForm(f.session, details, Date.now() + 1000);
    expect(unsafe.evaluate).not.toHaveBeenCalled();
  });

  it('可信元数据对应的frame已导航至外站时，页面内再次核验并拒绝填写', async () => {
    const f = fixture();
    const moved = frame(
      'moved',
      'https://js.stripe.com/v3/card',
      [new Input('cc-number')],
      'https://other.example.invalid/'
    );
    f.frames.splice(1, 1, moved);
    await expect(fillDirectPaymentForm(f.session, details, Date.now() + 1000)).rejects.toThrow(
      'payment_form_changed'
    );
    expect(Object.values(f.fields).every((field) => field.writes === 0)).toBe(true);
  });

  it('取消或耗尽预算后不再读取或填写', async () => {
    const f = fixture();
    f.controller.abort();
    await expect(fillDirectPaymentForm(f.session, details, Date.now() + 1000)).rejects.toThrow(
      'bitbrowser_direct_cancelled'
    );
    expect(f.session.frames).not.toHaveBeenCalled();
    const next = fixture();
    await expect(fillDirectPaymentForm(next.session, details, Date.now() - 1)).rejects.toThrow(
      'official_payment_field_not_ready'
    );
    expect(next.session.frames).not.toHaveBeenCalled();
  });

  it('枚举frame没有响应也受同一截止时间限制', async () => {
    vi.useFakeTimers();
    const f = fixture();
    vi.mocked(f.session.frames).mockImplementation(() => new Promise(() => {}));
    const pending = expect(
      fillDirectPaymentForm(f.session, details, Date.now() + 50)
    ).rejects.toThrow('official_payment_field_not_ready');
    await vi.advanceTimersByTimeAsync(51);
    await pending;
    expect(f.fields.number.writes).toBe(0);
  });

  it('等待frame期间取消会立即终止，迟到枚举不触发填写', async () => {
    const f = fixture();
    let finish!: (frames: DirectPaymentFrame[]) => void;
    vi.mocked(f.session.frames).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const pending = expect(
      fillDirectPaymentForm(f.session, details, Date.now() + 1000)
    ).rejects.toThrow('bitbrowser_direct_cancelled');
    await Promise.resolve();
    f.controller.abort();
    await pending;
    finish(f.frames);
    await Promise.resolve();
    expect(f.fields.number.writes).toBe(0);
  });

  it('已排队的填写命令到达页面时若超时，也不能迟到写入卡资料', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const card = f.frames[1];
    const evaluate = card.evaluate.bind(card);
    let finish: (() => void) | undefined;
    card.evaluate = async (expression) => {
      if (expression.includes('"mode":"fill"'))
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      return evaluate(expression);
    };
    const pending = expect(
      fillDirectPaymentForm(f.session, details, Date.now() + 100)
    ).rejects.toThrow('official_payment_field_not_ready');
    await vi.advanceTimersByTimeAsync(1);
    expect(finish).toBeTypeOf('function');
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    finish!();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.fields.number.writes).toBe(0);
  });

  it('选国家后仅在唯一匹配账单frame填写，忽略未消失的空国家旧frame', async () => {
    const f = fixture();
    f.fields.country.value = 'GB';
    const staleStreet = new Input('address-line1');
    f.frames.push(
      frame('stale', 'https://js.stripe.com/v3/address-old', [
        new Select('country', [{ value: 'US', textContent: 'United States' }]),
        staleStreet
      ])
    );
    await fillDirectPaymentForm(f.session, details, Date.now() + 1000);
    expect(f.fields.country.value).toBe('US');
    expect(staleStreet.writes).toBe(0);
  });

  it('资料校验失败不读取页面，错误消息不包含输入值', async () => {
    const f = fixture();
    const invalid = { ...details, number: '4242424242424243' };
    await expect(fillDirectPaymentForm(f.session, invalid, Date.now() + 1000)).rejects.toThrow(
      'invalid_payment_field'
    );
    expect(f.session.frames).not.toHaveBeenCalled();
  });

  it('关闭自愿保存，按官网明确要求声明代理身份；不点击购买按钮', async () => {
    const f = fixture();
    const save = new Input('');
    save.name = 'savePayment';
    save.type = 'checkbox';
    save.checked = true;
    const agent = new Input('');
    agent.type = 'checkbox';
    agent.labels = [{ textContent: 'I am an AI agent acting on behalf of someone else' }];
    f.billingNodes.push(save, agent);
    await fillDirectPaymentForm(f.session, details, Date.now() + 1000);
    expect(save.checked).toBe(false);
    expect(agent.checked).toBe(true);
    expect(save.events).toEqual(['click']);
    expect(agent.events).toEqual(['click']);
  });

  it('账单控件出现在所选账单frame之外的官网页面时拒绝通过', async () => {
    const f = fixture();
    await fillDirectPaymentForm(f.session, details, Date.now() + 1000);
    f.frames.push(
      frame('changed-root', 'https://chatgpt.com/checkout/openai_llc/oaics_synthetic', [
        new Input('address-level2', details.city)
      ])
    );
    await expect(verifyDirectPaymentForm(f.session, details, Date.now() + 1000)).rejects.toThrow(
      'billing_fields_changed'
    );
  });
});
