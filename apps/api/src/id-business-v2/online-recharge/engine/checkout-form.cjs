'use strict';

// The same semantic locator is used to write and verify each field. Never infer
// card/billing identity from iframe order or from a previous successful fill.
const rules = {
  number: [/\bcc-number\b/, /card.?number|numberinput/],
  expiry: [/\bcc-exp\b(?!-)/, /expir(?:y|ation|ationdate)|expdate/],
  month: [/\bcc-exp-month\b/, /exp.*month/],
  year: [/\bcc-exp-year\b/, /exp.*year/],
  cvc: [/\bcc-csc\b/, /\bcvc\b|\bcvv\b|security.?code|securitycode/],
  name: [
    /\bbilling name\b|^name$|\bcc-name\b/,
    /billing.?name|fullname|full name|nameinput|姓名|全名/
  ],
  country: [/\bcountry(?:-name)?\b/, /countryinput|country or region|国家/],
  line1: [/\baddress-line1\b/, /address.?line.?1|addressline1input|\bstreet\b|街道|地址行.?1/],
  city: [/\baddress-level2\b/, /\blocality\b|\bcity\b|localityinput|cityinput|城市/],
  postal: [/\bpostal-code\b/, /postal.?code|\bzip\b|postalcodeinput|邮编|邮政编码/],
  state: [
    /\baddress-level1\b/,
    /administrative.?area|\bstate\b|\bprovince\b|stateinput|provinceinput|省|州/
  ]
};
const labels = {
  number: '卡号',
  expiry: '有效期',
  month: '有效月份',
  year: '有效年份',
  cvc: '安全码',
  name: '账单姓名',
  country: '国家',
  line1: '街道',
  city: '城市',
  postal: '邮编',
  state: '州/省'
};
const billingIds = {
  name: ['billingAddress-nameInput'],
  country: ['billingAddress-countryInput'],
  line1: ['billingAddress-addressLine1Input', 'billingAddressLine1'],
  city: ['billingAddress-localityInput'],
  postal: ['billingAddress-postalCodeInput'],
  state: ['billingAddress-administrativeAreaInput']
};
const normalize = (v) =>
  String(v ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
const countryCode = (v) =>
  ({
    'united states': 'us',
    'united states of america': 'us',
    美国: 'us',
    philippines: 'ph',
    菲律宾: 'ph',
    chile: 'cl',
    智利: 'cl'
  })[normalize(v)] || normalize(v);
const stateName = (v) =>
  ({ or: 'oregon', de: 'delaware', mt: 'montana', nh: 'new hampshire', ak: 'alaska' })[
    normalize(v)
  ] || normalize(v);
function timeout(deadline) {
  const left = deadline - Date.now();
  if (left <= 0) throw new Error('填表超过本次总时限');
  return Math.min(left, 1200);
}
async function within(operation, deadline) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('填表超过本次总时限')),
          Math.max(1, deadline - Date.now())
        );
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function score(meta, key) {
  const ac = normalize(meta.ac),
    identity = normalize(`${meta.id} ${meta.name}`),
    description = normalize(`${meta.label} ${meta.placeholder}`);
  const hay = `${ac} ${identity} ${description}`;
  if (billingIds[key]) {
    if (
      /linklegalname|payment-link|\bshipping\b/.test(hay) ||
      ['contact', 'shipping'].includes(meta.scope)
    )
      return 0;
    if (billingIds[key].includes(meta.id)) return 400;
  }
  if (/email|phone|password|address-line2|addressline2|optional.*address/.test(hay)) return 0;
  if (key === 'expiry' && /exp-month|exp-year|month|year/.test(ac || identity)) return 0;
  if (
    ['name', 'country', 'line1', 'city', 'postal', 'state'].includes(key) &&
    /cc-number|cc-exp|cc-csc|cardnumber|securitycode/.test(hay)
  )
    return 0;
  const patterns = rules[key];
  const semantic = patterns.some((p) => p.test(ac))
    ? 100
    : patterns.some((p) => p.test(identity))
      ? 80
      : patterns.some((p) => p.test(description))
        ? 60
        : 0;
  if (!semantic) return 0;
  return (
    semantic +
    (billingIds[key] && meta.scope === 'billing' ? 200 : 0) +
    (['country', 'state'].includes(key) && (meta.tag === 'select' || meta.role === 'combobox')
      ? 10
      : 0)
  );
}
async function controls(page, deadline) {
  timeout(deadline);
  const result = [];
  for (const frame of page.frames()) {
    timeout(deadline);
    try {
      const all = frame.locator('input,select,textarea,[role="combobox"]');
      const metas = await within(
        all.evaluateAll((nodes) =>
          nodes
            .map((n, index) => {
              const style = n.ownerDocument.defaultView.getComputedStyle(n),
                box = n.getBoundingClientRect();
              if (
                !box.width ||
                !box.height ||
                style.display === 'none' ||
                style.visibility === 'hidden' ||
                n.disabled ||
                (n.readOnly && n.getAttribute('role') !== 'combobox') ||
                n.type === 'hidden' ||
                n.closest('[aria-hidden="true"],[inert]')
              )
                return null;
              let scope = '',
                owner = '';
              for (
                let parent = n.parentElement;
                parent && parent !== n.ownerDocument.body;
                parent = parent.parentElement
              ) {
                const heading = parent.querySelector(
                  ':scope > legend,:scope > h2,:scope > h3,:scope > [role="heading"]'
                );
                const label = parent.getAttribute('aria-label') || heading?.textContent || '';
                const identity = `${parent.id} ${parent.getAttribute('data-testid') || ''} ${label}`;
                const kind = /billing.?address/i.test(identity)
                  ? 'billing'
                  : /shipping|delivery.?address/i.test(identity)
                    ? 'shipping'
                    : /(?:^|[\s_-])contact(?:$|[\s_-])|payment-link/i.test(identity)
                      ? 'contact'
                      : '';
                if (!kind) continue;
                scope = kind;
                owner = parent.id
                  ? `[id=${JSON.stringify(parent.id)}]`
                  : parent.getAttribute('aria-label')
                    ? `[aria-label=${JSON.stringify(label)}]`
                    : heading
                      ? `${parent.tagName.toLowerCase()}:has(> ${heading.tagName.toLowerCase()}:text-is(${JSON.stringify(label)}))`
                      : '';
                break;
              }
              return {
                index,
                id: n.id || '',
                name: n.getAttribute('name') || '',
                ac: n.getAttribute('autocomplete') || '',
                placeholder: n.getAttribute('placeholder') || '',
                label: (
                  n.getAttribute('aria-label') ||
                  (n.getAttribute('aria-labelledby') || '')
                    .split(/\s+/)
                    .map((id) => n.ownerDocument.getElementById(id)?.textContent || '')
                    .join(' ')
                    .trim() ||
                  Array.from(n.labels || [])
                    .map((l) => l.textContent)
                    .join(' ') ||
                  ''
                ).slice(0, 160),
                tag: n.tagName.toLowerCase(),
                role: n.getAttribute('role'),
                scope,
                owner,
                readOnly: Boolean(n.readOnly),
                required: n.required || n.getAttribute('aria-required') === 'true'
              };
            })
            .filter(Boolean)
        ),
        deadline
      );
      for (const meta of metas) {
        const root = meta.owner ? frame.locator(meta.owner) : frame;
        const attribute = meta.id
          ? ['id', meta.id]
          : meta.ac
            ? ['autocomplete', meta.ac]
            : meta.name
              ? ['name', meta.name]
              : null;
        const el = attribute
          ? root.locator(
              `${meta.tag}[${attribute[0]}=${JSON.stringify(attribute[1])}]:visible:not(:disabled,[inert],[inert] *,[aria-hidden="true"],[aria-hidden="true"] *,[readonly]:not([role="combobox"]))`
            )
          : meta.label
            ? root.getByLabel(meta.label, { exact: true })
            : meta.placeholder
              ? root.getByPlaceholder(meta.placeholder, { exact: true })
              : null;
        if (el) result.push({ frame, el, meta });
      }
    } catch {
      /* A detached frame is rediscovered on the next bounded pass. */
    }
  }
  return result;
}
async function locate(page, key, deadline) {
  const candidates = (await controls(page, deadline))
    .map((item) => ({ ...item, score: score(item.meta, key) }))
    .filter((item) => item.score > 0);
  const highest = Math.max(0, ...candidates.map((item) => item.score));
  const matches = candidates.filter((item) => item.score === highest);
  if (matches.length > 1)
    throw Object.assign(new Error(`${labels[key]}有多个可见候选，未继续填写`), {
      failedFields: [key]
    });
  return matches[0] || null;
}
async function value(item, deadline) {
  timeout(deadline);
  return within(
    item.el.evaluate((n) => ({
      value: n.value ?? n.getAttribute('aria-valuetext') ?? n.textContent ?? '',
      label: n.tagName === 'SELECT' ? n.selectedOptions[0]?.textContent || '' : '',
      valid: n.getAttribute('aria-invalid') !== 'true' && (!n.validity || n.validity.valid)
    })),
    deadline
  );
}
function matches(key, actual, expected) {
  if (key === 'month')
    return String(actual).replace(/^0+/, '') === String(expected).replace(/^0+/, '');
  if (key === 'year') return String(actual).slice(-2) === String(expected).slice(-2);
  if (key === 'number' || key === 'cvc' || key === 'expiry')
    return String(actual).replace(/\D/g, '') === String(expected).replace(/\D/g, '');
  if (key === 'country') return countryCode(actual) === countryCode(expected);
  if (key === 'state') return stateName(actual) === stateName(expected);
  return normalize(actual) === normalize(expected);
}
async function write(page, key, expected, deadline) {
  const item = await locate(page, key, deadline);
  if (!item) return false;
  const current = await value(item, deadline);
  if (
    current.valid &&
    (matches(key, current.value, expected) ||
      (current.label && matches(key, current.label, expected)))
  )
    return true;
  if (item.meta.tag === 'select') {
    const options = await item.el
      .locator('option')
      .evaluateAll((nodes) => nodes.map((n) => ({ value: n.value, label: n.textContent || '' })));
    const option = options.find(
      (o) => matches(key, o.value, expected) || matches(key, o.label, expected)
    );
    if (!option) throw new Error(`${labels[key]}没有与资料一致的选项`);
    await item.el.selectOption(option.value, { timeout: timeout(deadline) });
  } else if (
    item.meta.role === 'combobox' &&
    (!['input', 'textarea'].includes(item.meta.tag) || ['country', 'state'].includes(key))
  ) {
    if (item.meta.readOnly && item.meta.tag === 'input') {
      await item.el.press('ArrowDown', { timeout: timeout(deadline) });
    } else {
      await item.el.click({ timeout: timeout(deadline) });
      if (item.meta.tag === 'input')
        await item.el.fill(String(expected), { timeout: timeout(deadline) });
    }
    const choices = item.frame.locator('[role="option"]:visible');
    await choices.first().waitFor({ state: 'visible', timeout: timeout(deadline) });
    const texts = await choices.allTextContents();
    const matched = texts.map((v, i) => (matches(key, v, expected) ? i : -1)).filter((i) => i >= 0);
    if (matched.length !== 1) throw new Error(`${labels[key]}选项无法唯一匹配`);
    await choices.nth(matched[0]).click({ timeout: timeout(deadline) });
  } else {
    const maxLength = key === 'year' ? await item.el.getAttribute('maxlength') : null;
    const text =
      key === 'year'
        ? maxLength === '2'
          ? String(expected).slice(-2)
          : String(expected).length === 2
            ? '20' + expected
            : String(expected)
        : String(expected);
    await item.el.fill(text, { timeout: timeout(deadline) });
    await item.el.press('Tab', { timeout: timeout(deadline) });
  }
  return true;
}
async function verify(page, expected, deadline) {
  const missing = [];
  for (const [key, wanted] of Object.entries(expected)) {
    const item = await locate(page, key, deadline);
    if (!item) {
      missing.push(key);
      continue;
    }
    const actual = await value(item, deadline);
    if (
      !actual.valid ||
      !(matches(key, actual.value, wanted) || (actual.label && matches(key, actual.label, wanted)))
    )
      missing.push(key);
  }
  return missing;
}
async function fill(page, expected, deadline) {
  let missing = Object.keys(expected);
  while (Date.now() < deadline) {
    for (const key of missing) {
      try {
        await write(page, key, expected[key], deadline);
      } catch (e) {
        if (/多个|选项/.test(e.message)) throw e;
      }
    }
    missing = await verify(page, expected, deadline);
    if (!missing.length)
      return {
        ok: true,
        filled: Object.fromEntries(Object.keys(expected).map((key) => [key, true]))
      };
    await page.waitForTimeout(Math.min(200, Math.max(1, deadline - Date.now())));
  }
  return {
    ok: false,
    missing,
    error: `填表超时，未完成：${missing.map((key) => labels[key]).join('、')}`
  };
}
async function diagnostic(page) {
  try {
    return (await controls(page, Date.now() + 2000)).map(({ meta }) => ({
      ...meta,
      fields: Object.keys(rules).filter((key) => score(meta, key) > 0)
    }));
  } catch {
    return [];
  }
}
async function guarded(page, action, deadline) {
  try {
    return await within(action(), deadline);
  } catch (e) {
    return {
      ok: false,
      error: /多个|选项|总时限|资料/.test(e.message) ? e.message : '控件重载或校验失败，未完成填表',
      missing: e.failedFields || [],
      controls: await diagnostic(page)
    };
  }
}
async function fillCard(page, card, { deadline = Date.now() + 120000 } = {}) {
  return guarded(
    page,
    async () => {
      if (!card.number || !card.expiry || !card.cvc) throw new Error('卡片资料缺失');
      const expected = { number: String(card.number).replace(/\D/g, ''), cvc: String(card.cvc) };
      const split = String(card.expiry).match(/^(\d{2})\/?(\d{2}|\d{4})$/);
      if (!split) throw new Error('有效期资料无效');
      // Some elements reveal the expiry only after the number has been entered.
      while (Date.now() < deadline) {
        if (await write(page, 'number', expected.number, deadline)) break;
        await page.waitForTimeout(200);
      }
      // Wait for either a combined expiry control or both explicitly labelled parts.
      while (Date.now() < deadline) {
        if (await locate(page, 'expiry', deadline)) {
          expected.expiry = `${split[1]}/${split[2].slice(-2)}`;
          break;
        }
        if ((await locate(page, 'month', deadline)) && (await locate(page, 'year', deadline))) {
          expected.month = split[1];
          expected.year = split[2];
          break;
        }
        await page.waitForTimeout(200);
      }
      if (!expected.expiry && !expected.month) throw new Error('有效期资料控件未在总时限内出现');
      return fill(page, expected, deadline);
    },
    deadline
  );
}
async function fillBilling(page, address, name, { deadline = Date.now() + 120000 } = {}) {
  return guarded(
    page,
    async () => {
      const expected = {
        country: address?.country || address?.region,
        line1: address?.line1,
        city: address?.city,
        postal: address?.postal_code,
        name
      };
      const absent = Object.entries(expected)
        .filter(([, v]) => !String(v ?? '').trim())
        .map(([key]) => labels[key]);
      if (absent.length) throw new Error(`账单资料缺失：${absent.join('、')}`);
      if (address.state) expected.state = address.state;
      if (['us', 'ca', 'au'].includes(countryCode(expected.country)) && !expected.state)
        throw new Error('账单资料缺失：州/省');
      // Country changes can replace all address controls. Re-discover after every write.
      const result = await fill(page, expected, deadline);
      if (!result.ok) result.controls = await diagnostic(page);
      return result;
    },
    deadline
  );
}
async function verifyCard(page, card, { deadline = Date.now() + 120000 } = {}) {
  const expected = { number: String(card.number).replace(/\D/g, ''), cvc: String(card.cvc) };
  const parts = String(card.expiry).match(/^(\d{2})\/?(\d{2}|\d{4})$/);
  if (!parts) return ['expiry'];
  if (await locate(page, 'expiry', deadline)) expected.expiry = `${parts[1]}/${parts[2].slice(-2)}`;
  else {
    expected.month = parts[1];
    expected.year = parts[2];
  }
  return verify(page, expected, deadline);
}
async function stableDue(page, read, deadline) {
  let previous = null,
    stable = 0;
  while (Date.now() < deadline) {
    const due = await within(read(), deadline);
    const key = due ? `${due.currency}:${due.amount}` : null;
    stable = key && key === previous ? stable + 1 : 0;
    if (stable >= 3) return due;
    previous = key;
    await page.waitForTimeout(Math.min(500, Math.max(1, deadline - Date.now())));
  }
  return null;
}
module.exports = { fillCard, fillBilling, diagnostic, verify, verifyCard, matches, stableDue };
