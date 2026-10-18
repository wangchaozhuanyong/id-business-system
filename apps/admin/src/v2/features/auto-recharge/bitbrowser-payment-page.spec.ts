import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectDirectPaymentPage } from './bitbrowser-payment-page';

class Node {
  clicks = 0;
  disabled = false;
  hidden = false;
  attrs: Record<string, string> = {};
  children: Node[] = [];
  proCard = false;
  titlebar = false;
  label?: Node;
  constructor(
    public textContent = '',
    public role = 'button'
  ) {}
  getClientRects() {
    return this.hidden ? [] : [{}];
  }
  matches() {
    return this.disabled || this.attrs['aria-disabled'] === 'true';
  }
  getAttribute(key: string) {
    return this.attrs[key] ?? null;
  }
  closest(selector: string) {
    if (selector === 'header[data-app-shell-titlebar="true"]') return this.titlebar ? this : null;
    return selector === 'label' ? (this.label ?? null) : this.proCard ? this : null;
  }
  querySelectorAll() {
    return this.children;
  }
  click() {
    this.clicks++;
  }
}
class Radio extends Node {
  checked = false;
  constructor(text = '') {
    super(text, 'radio');
  }
}
class Anchor extends Node {}
function setup(
  nodes: Node[],
  url = 'https://chatgpt.com/checkout/openai_llc/oaics_synthetic',
  text = ''
) {
  vi.stubGlobal('location', new URL(url));
  vi.stubGlobal('HTMLInputElement', Radio);
  vi.stubGlobal('HTMLAnchorElement', Anchor);
  vi.stubGlobal('getComputedStyle', () => ({ visibility: 'visible' }));
  vi.stubGlobal('document', {
    body: { innerText: text },
    getElementById: (id: string) => nodes.find((node) => node.attrs.id === id),
    querySelectorAll(selector: string) {
      if (selector === 'button,a,[role="button"]')
        return nodes.filter((node) => node.role === 'button');
      if (selector === '[role="radiogroup"],[role="group"]')
        return nodes.filter((node) => ['radiogroup', 'group'].includes(node.role));
      if (selector === '[role="radio"],[role="tab"]')
        return nodes.filter((node) => ['radio', 'tab'].includes(node.role));
      return [];
    }
  });
}
function proGroup() {
  const group = new Node('', 'radiogroup');
  group.attrs['aria-label'] = 'Pro 套餐档位';
  const standard = new Radio('Standard');
  standard.checked = true;
  standard.attrs['aria-checked'] = 'true';
  const more = new Radio('More usage');
  more.attrs['aria-checked'] = 'false';
  const max = new Radio('Max usage');
  max.attrs['aria-checked'] = 'false';
  group.children = [standard, more, max];
  return { group, standard, more, max };
}
afterEach(() => vi.unstubAllGlobals());

describe('直连官网套餐与付款按钮边界', () => {
  it('最终核价只读取当前 Pro 档位，变化后不能自动选回或继续付款', () => {
    const f = proGroup();
    setup([f.group]);
    expect(inspectDirectPaymentPage('pro-5x', 'verify_tier', 'oaics_synthetic').kind).toBe(
      'tier_ready'
    );
    expect(inspectDirectPaymentPage('pro-20x', 'verify_tier', 'oaics_synthetic').kind).toBe(
      'tier_unverified'
    );
    expect(f.more.clicks).toBe(0);
    expect(inspectDirectPaymentPage('pro-5x', 'verify_tier', 'oaics_other').kind).toBe(
      'checkout_mismatch'
    );
  });
  it('结账导航期间文档未建立时只等待，不读取空 body 或点击', () => {
    setup([]);
    vi.stubGlobal('document', { body: null });
    expect(inspectDirectPaymentPage('pro-5x', 'tier', 'oaics_synthetic')).toEqual({
      kind: 'loading'
    });
  });
  it('Pro 档位不能在主页或其他原单上操作', () => {
    const f = proGroup();
    setup([f.group], 'https://chatgpt.com/');
    expect(inspectDirectPaymentPage('pro-20x', 'tier', 'oaics_synthetic').kind).toBe(
      'checkout_mismatch'
    );
    setup([f.group]);
    expect(inspectDirectPaymentPage('pro-20x', 'tier', 'oaics_other').kind).toBe(
      'checkout_mismatch'
    );
    expect(f.more.clicks).toBe(0);
  });
  it.each(['无法加载付款表单。请重试。', 'Unable to load the payment form. Please try again.'])(
    '识别官网付款表单加载失败且不重按套餐入口：%s',
    (text) => {
      const plus = new Node('升级至 Plus');
      setup([plus], 'https://chatgpt.com/#pricing', text);
      expect(inspectDirectPaymentPage('plus', 'inspect').kind).toBe('payment_form_load_failed');
      expect(inspectDirectPaymentPage('plus', 'create').kind).toBe('payment_form_load_failed');
      expect(plus.clicks).toBe(0);
    }
  );
  it('识别本轮官网支付方式验证失败的可见提示，且不会重按订阅', () => {
    const pay = new Node('订阅');
    setup(
      [pay],
      'https://chatgpt.com/checkout/openai_llc/oaics_synthetic',
      '配置套餐\n我们未能验证您的支付方式。请选择另一支付方式并重试。\n快捷支付'
    );
    expect(inspectDirectPaymentPage('go', 'inspect').kind).toBe(
      'payment_method_verification_failed'
    );
    expect(inspectDirectPaymentPage('go', 'confirm', 'oaics_synthetic').kind).toBe(
      'payment_method_verification_failed'
    );
    expect(pay.clicks).toBe(0);
    setup([pay], 'https://chatgpt.com/', '我们未能验证您的支付方式。请选择另一支付方式并重试。');
    expect(inspectDirectPaymentPage('go', 'inspect').kind).toBe('page');
  });
  it('只按目标套餐精确唯一匹配，准备阶段不点击购买', () => {
    const plus = new Node('Get Plus');
    const go = new Node('Get Go');
    const pay = new Node('Pay now');
    setup([go, plus, pay], 'https://chatgpt.com/pricing');
    expect(inspectDirectPaymentPage('plus', 'prepare')).toEqual({ kind: 'plan_ready' });
    expect([go, plus, pay].every((node) => node.clicks === 0)).toBe(true);
    expect(inspectDirectPaymentPage('plus', 'create')).toEqual({ kind: 'submitted' });
    expect(plus.clicks).toBe(1);
    expect(pay.clicks).toBe(0);
    expect(go.clicks).toBe(0);
  });
  it('同名套餐多个控件或控件禁用时均不点击', () => {
    const first = new Node('Get Plus');
    const duplicate = new Node('Get Plus');
    setup([first, duplicate]);
    expect(inspectDirectPaymentPage('plus', 'create').kind).toBe('plan_unavailable');
    expect(first.clicks + duplicate.clicks).toBe(0);
    first.disabled = true;
    duplicate.hidden = true;
    expect(inspectDirectPaymentPage('plus', 'create').kind).toBe('plan_unavailable');
  });
  it.each(['Pay now', 'Subscribe', 'Subscribe now', '订阅', '立即付款', 'Confirm payment'])(
    '付款按钮%s不能被用作套餐入口',
    (text) => {
      const node = new Node(text);
      setup([node], 'https://chatgpt.com/pricing');
      expect(inspectDirectPaymentPage('plus', 'create').kind).toBe('plan_unavailable');
      expect(node.clicks).toBe(0);
    }
  );
  it('切换个人菜单或打开升级菜单与建单分离', () => {
    const personal = new Node('Personal', 'tab');
    personal.attrs['aria-selected'] = 'false';
    setup([personal], 'https://chatgpt.com/');
    expect(inspectDirectPaymentPage('plus', 'prepare').kind).toBe('menu_opened');
    expect(personal.clicks).toBe(1);
    const upgrade = new Node('Upgrade');
    setup([upgrade], 'https://chatgpt.com/');
    expect(inspectDirectPaymentPage('plus', 'prepare').kind).toBe('menu_opened');
    expect(upgrade.clicks).toBe(1);
  });
  it('首页侧栏和标题栏同时提供升级入口时，只打开唯一标题栏菜单', () => {
    const sidebar = new Node('升级订阅');
    const header = new Node('升级订阅');
    header.titlebar = true;
    const pay = new Node('立即订阅');
    setup([sidebar, header, pay], 'https://chatgpt.com/');
    expect(inspectDirectPaymentPage('go', 'prepare')).toEqual({ kind: 'menu_opened' });
    expect(header.clicks).toBe(1);
    expect(sidebar.clicks + pay.clicks).toBe(0);
    expect(inspectDirectPaymentPage('go', 'create').kind).toBe('plan_unavailable');
    expect(header.clicks).toBe(1);
  });
  it('多个标题栏入口或只有多个普通升级入口时不任意点击', () => {
    const first = new Node('升级订阅');
    const second = new Node('升级订阅');
    setup([first, second], 'https://chatgpt.com/');
    expect(inspectDirectPaymentPage('go', 'prepare').kind).toBe('plan_unavailable');
    first.titlebar = true;
    second.titlebar = true;
    expect(inspectDirectPaymentPage('go', 'prepare').kind).toBe('plan_unavailable');
    expect(first.clicks + second.clicks).toBe(0);
  });
  it('Pro唯一档位可选择，且不点击付款或套餐建单按钮', () => {
    const f = proGroup();
    const create = new Node('Get Pro');
    const pay = new Node('Subscribe');
    setup([f.group, create, pay]);
    expect(inspectDirectPaymentPage('pro-500', 'tier').kind).toBe('tier_changed');
    expect(f.max.clicks).toBe(1);
    expect(create.clicks + pay.clicks).toBe(0);
  });
  it('Pro 计价期间档位禁用只等待，不误报控件歧义或点击按钮', () => {
    const f = proGroup();
    f.standard.disabled = true;
    f.more.disabled = true;
    f.max.disabled = true;
    const pay = new Node('升级至 Pro');
    setup([f.group, pay]);
    expect(inspectDirectPaymentPage('pro-20x', 'tier').kind).toBe('tier_loading');
    f.standard.disabled = false;
    expect(inspectDirectPaymentPage('pro-20x', 'tier').kind).toBe('tier_loading');
    expect(pay.clicks + f.more.clicks).toBe(0);
  });
  it('隐藏的原生 radio 兼容节点不阻塞可见档位', () => {
    const f = proGroup();
    const hidden = new Radio();
    hidden.hidden = true;
    f.group.children.push(hidden);
    setup([f.group]);
    expect(inspectDirectPaymentPage('pro-5x', 'tier').kind).toBe('tier_ready');
  });
  it('实测 Pro 档位通过 aria-labelledby 命名，隐藏兼容 input 不重复计入选中状态', () => {
    const f = proGroup();
    delete f.group.attrs['aria-label'];
    f.group.attrs['aria-labelledby'] = 'pro-title';
    const title = new Node('Pro 套餐', 'heading');
    title.attrs.id = 'pro-title';
    const hidden = new Radio('Standard');
    hidden.checked = true;
    hidden.attrs['aria-hidden'] = 'true';
    f.group.children.push(hidden);
    setup([title, f.group]);
    expect(inspectDirectPaymentPage('pro-5x', 'tier').kind).toBe('tier_ready');
    expect(inspectDirectPaymentPage('pro-20x', 'tier').kind).toBe('tier_changed');
    expect(f.more.clicks).toBe(1);
    expect(hidden.clicks).toBe(0);
  });
  it('Pro两个区域不能以默认档位继续建单', () => {
    const first = proGroup();
    const second = proGroup();
    const create = new Node('Get Pro');
    setup([first.group, second.group, create]);
    expect(inspectDirectPaymentPage('pro-500', 'create').kind).not.toBe('submitted');
    expect(create.clicks).toBe(0);
  });
  it('目标档位多个匹配项时停止', () => {
    const f = proGroup();
    f.group.children.push(new Radio('Max usage'));
    setup([f.group]);
    expect(inspectDirectPaymentPage('pro-500', 'tier').kind).not.toBe('tier_ready');
    expect(f.max.clicks).toBe(0);
  });
  it('原生选中状态与ARIA矛盾、或多个已选档位不能通过', () => {
    const conflict = proGroup();
    conflict.standard.checked = false;
    conflict.standard.attrs['aria-checked'] = 'false';
    conflict.max.checked = true;
    conflict.max.attrs['aria-checked'] = 'false';
    setup([conflict.group]);
    expect(inspectDirectPaymentPage('pro-500', 'tier').kind).not.toBe('tier_ready');
    expect(conflict.max.clicks).toBe(0);
    const multiple = proGroup();
    multiple.max.checked = true;
    multiple.max.attrs['aria-checked'] = 'true';
    setup([multiple.group]);
    expect(inspectDirectPaymentPage('pro-500', 'tier').kind).not.toBe('tier_ready');
    expect(multiple.max.clicks).toBe(0);
  });
  it('目标套餐已经唯一选中时不重复点击', () => {
    const f = proGroup();
    f.standard.checked = false;
    f.standard.attrs['aria-checked'] = 'false';
    f.max.checked = true;
    f.max.attrs['aria-checked'] = 'true';
    setup([f.group]);
    expect(inspectDirectPaymentPage('pro-500', 'tier').kind).toBe('tier_ready');
    expect(f.max.clicks).toBe(0);
  });
  it.each([
    ['pro-5x', 0, 'tier_ready'],
    ['pro-20x', 1, 'tier_changed'],
    ['pro-500', 2, 'tier_changed']
  ] as const)('%s 匹配实测官网中文档位文案', (plan, index, kind) => {
    const f = proGroup();
    f.group.attrs['aria-label'] = 'Pro 套餐';
    f.standard.textContent = 'PHP 6,490 标准';
    f.more.textContent = 'PHP 9,990 更多使用额度';
    f.max.textContent = 'PHP 32,490 最高使用额度';
    const pay = new Node('升级至 Pro');
    setup([f.group, pay]);
    expect(inspectDirectPaymentPage(plan, 'tier').kind).toBe(kind);
    expect(f.group.children[index]!.clicks).toBe(index === 0 ? 0 : 1);
    expect(pay.clicks).toBe(0);
  });
  it('只能在绑定的原结算页点击唯一确认按钮，不能点击链接', () => {
    const pay = new Node('Subscribe');
    const anchor = new Anchor('Subscribe');
    setup([pay, anchor]);
    expect(inspectDirectPaymentPage('plus', 'confirm', 'oaics_synthetic').kind).toBe('submitted');
    expect(pay.clicks).toBe(1);
    expect(anchor.clicks).toBe(0);
  });
  it.each(['pro-5x', 'pro-20x', 'pro-500'] as const)(
    '%s 官网最终升级按钮仅在绑定结账单的确认阶段使用',
    (plan) => {
      const pay = new Node('升级至 Pro');
      setup([pay]);
      expect(inspectDirectPaymentPage(plan, 'prepare').kind).toBe('plan_unavailable');
      expect(inspectDirectPaymentPage(plan, 'create').kind).toBe('plan_unavailable');
      expect(inspectDirectPaymentPage(plan, 'confirm', 'oaics_other').kind).toBe(
        'checkout_mismatch'
      );
      expect(pay.clicks).toBe(0);
      expect(inspectDirectPaymentPage(plan, 'confirm', 'oaics_synthetic').kind).toBe('submitted');
      expect(pay.clicks).toBe(1);
    }
  );
  it('Pro 升级按钮不能被其他套餐借用，重复确认控件或链接仍不放行', () => {
    const pay = new Node('Upgrade to Pro');
    setup([pay]);
    for (const plan of ['go', 'plus'] as const)
      expect(inspectDirectPaymentPage(plan, 'confirm', 'oaics_synthetic').kind).toBe('ambiguous');
    const duplicate = new Node('Subscribe');
    setup([pay, duplicate]);
    expect(inspectDirectPaymentPage('pro-20x', 'confirm', 'oaics_synthetic').kind).toBe(
      'ambiguous'
    );
    const link = new Anchor('Upgrade to Pro');
    setup([link]);
    expect(inspectDirectPaymentPage('pro-20x', 'confirm', 'oaics_synthetic').kind).toBe(
      'ambiguous'
    );
    expect(pay.clicks + duplicate.clicks + link.clicks).toBe(0);
  });
  it('Pro 英文升级按钮支持绑定的 cs 结账单，但套餐页不能执行付款确认', () => {
    const pay = new Node('Upgrade to Pro');
    setup([pay], 'https://chatgpt.com/checkout/openai_llc/cs_live_synthetic');
    expect(inspectDirectPaymentPage('pro-20x', 'confirm', 'cs_live_synthetic').kind).toBe(
      'submitted'
    );
    expect(pay.clicks).toBe(1);
    setup([pay], 'https://chatgpt.com/#pricing');
    expect(inspectDirectPaymentPage('pro-20x', 'confirm', 'cs_live_synthetic').kind).toBe(
      'checkout_mismatch'
    );
    expect(pay.clicks).toBe(1);
  });
  it.each([
    'https://chatgpt.com/',
    'https://chatgpt.com/pricing',
    'https://chatgpt.com/checkout/openai_llc/oaics_other'
  ])('确认前导航至%s不能点击付款', (url) => {
    const pay = new Node('Subscribe');
    setup([pay], url);
    expect(inspectDirectPaymentPage('plus', 'confirm', 'oaics_synthetic').kind).not.toBe(
      'submitted'
    );
    expect(pay.clicks).toBe(0);
  });
  it('多个付款控件不能猜选，缺少原单绑定也不能确认', () => {
    const pay = new Node('Subscribe');
    const other = new Node('Pay now');
    setup([pay, other]);
    expect(inspectDirectPaymentPage('plus', 'confirm', 'oaics_synthetic').kind).not.toBe(
      'submitted'
    );
    setup([pay]);
    expect(inspectDirectPaymentPage('plus', 'confirm').kind).not.toBe('submitted');
    expect(pay.clicks + other.clicks).toBe(0);
  });
  it.each([
    'http://chatgpt.com/',
    'https://untrusted.example.invalid/',
    'https://chatgpt.com:444/'
  ])('非官网来源%s不能做任何操作', (url) => {
    const plus = new Node('Get Plus');
    const pay = new Node('Subscribe');
    setup([plus, pay], url);
    expect(inspectDirectPaymentPage('plus', 'create').kind).toBe('untrusted');
    expect(inspectDirectPaymentPage('plus', 'confirm', 'oaics_synthetic').kind).toBe('untrusted');
    expect(plus.clicks + pay.clicks).toBe(0);
  });
  it('官网付款错误页只报告受控错误状态，不尝试点击', () => {
    const pay = new Node('Subscribe');
    setup([pay], undefined, '处理你的付款时发生错误\n返回 ChatGPT');
    expect(inspectDirectPaymentPage('plus', 'inspect')).toMatchObject({
      kind: 'official_error',
      checkoutId: 'oaics_synthetic'
    });
    expect(inspectDirectPaymentPage('plus', 'confirm', 'oaics_synthetic').kind).toBe(
      'official_error'
    );
    expect(pay.clicks).toBe(0);
  });
});
