import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectDirectPaymentPage } from './bitbrowser-payment-page';

class Node {
  clicks = 0;
  disabled = false;
  hidden = false;
  attrs: Record<string, string> = {};
  children: Node[] = [];
  proCard = false;
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
  it('Pro唯一档位可选择，且不点击付款或套餐建单按钮', () => {
    const f = proGroup();
    const create = new Node('Get Pro');
    const pay = new Node('Subscribe');
    setup([f.group, create, pay]);
    expect(inspectDirectPaymentPage('pro-500', 'tier').kind).toBe('tier_changed');
    expect(f.max.clicks).toBe(1);
    expect(create.clicks + pay.clicks).toBe(0);
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
  it('只能在绑定的原结算页点击唯一确认按钮，不能点击链接', () => {
    const pay = new Node('Subscribe');
    const anchor = new Anchor('Subscribe');
    setup([pay, anchor]);
    expect(inspectDirectPaymentPage('plus', 'confirm', 'oaics_synthetic').kind).toBe('submitted');
    expect(pay.clicks).toBe(1);
    expect(anchor.clicks).toBe(0);
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
