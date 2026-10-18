import type { V2RechargeDetails } from './contracts';
import type { DirectPaymentFrame, DirectPaymentSession } from './bitbrowser-payment-session';
import { rechargeDetailsReady } from './recharge-form';

type Field = keyof V2RechargeDetails;
type Operation = {
  field?: Field;
  value?: string;
  mode: 'inspect' | 'fill' | 'preferences';
  index?: number;
  deadline?: number;
  expectedCount?: number;
};
interface NodeState {
  index: number;
  count: number;
  editable: boolean;
  populated: boolean;
  matches: boolean;
  select: boolean;
  optionMatches: number;
  stateCode?: string;
}
interface BillingSnapshot {
  state: string;
}
interface DocumentResult {
  ok: boolean;
  nodes: NodeState[];
}
interface LocatedField {
  frame: DirectPaymentFrame;
  node: NodeState;
}
const cards: Field[] = ['number', 'expiry', 'cvc'];
const billing: Field[] = [
  'country',
  'name',
  'email',
  'line1',
  'line2',
  'city',
  'state',
  'postal_code'
];

/** Runs in one verified frame. Only a selected state code may leave the frame. */
export function directPaymentFieldOperation(operation: Operation): DocumentResult {
  if (
    typeof operation.deadline !== 'number' ||
    Date.now() >= operation.deadline ||
    location.protocol !== 'https:' ||
    !['chatgpt.com', 'js.stripe.com'].includes(location.hostname) ||
    (location.port && location.port !== '443')
  )
    return { ok: false, nodes: [] };
  const visible = (node: Element) =>
    node.getClientRects().length > 0 &&
    getComputedStyle(node).display !== 'none' &&
    getComputedStyle(node).visibility !== 'hidden';
  if (operation.mode === 'preferences') {
    const saves = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="checkbox"][name="savePayment"]')
    ).filter(visible);
    if (saves.length > 1) return { ok: false, nodes: [] };
    if (saves[0]?.checked) {
      if (saves[0].disabled) return { ok: false, nodes: [] };
      saves[0].click();
      if (saves[0].checked) return { ok: false, nodes: [] };
    }
    const agents = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    ).filter(
      (node) =>
        visible(node) &&
        Array.from(node.labels ?? []).some(
          (label) =>
            label.textContent?.trim() === 'I am an AI agent acting on behalf of someone else'
        )
    );
    if (agents.length > 1) return { ok: false, nodes: [] };
    if (agents[0] && !agents[0].checked) {
      if (agents[0].disabled) return { ok: false, nodes: [] };
      agents[0].click();
      if (!agents[0].checked) return { ok: false, nodes: [] };
    }
    return { ok: true, nodes: [] };
  }
  const selectors = {
    number: 'input[autocomplete="cc-number"]',
    expiry: 'input[autocomplete="cc-exp"]',
    cvc: 'input[autocomplete="cc-csc"]',
    name: 'input[autocomplete~="name"],input[autocomplete="cc-name"]',
    email: 'input[autocomplete~="email"]',
    country: 'select[autocomplete~="country"],select[autocomplete~="country-name"]',
    line1: 'input[autocomplete~="address-line1"],input[autocomplete~="street-address"]',
    line2: 'input[autocomplete~="address-line2"]',
    city: 'input[autocomplete~="address-level2"]',
    state: 'input[autocomplete~="address-level1"],select[autocomplete~="address-level1"]',
    postal_code: 'input[autocomplete~="postal-code"]'
  };
  const field = operation.field;
  if (!field || !Object.hasOwn(selectors, field)) return { ok: false, nodes: [] };
  const expected = operation.value ?? '';
  const normalized = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();
  const countryLabels =
    expected.toUpperCase() === 'US' ? ['united states', 'united states of america', '美国'] : [];
  const valueMatches = (value: string) =>
    cardsField()
      ? value.replace(/\D/g, '') === expected.replace(/\D/g, '')
      : normalized(value) === normalized(expected) ||
        (field === 'country' && countryLabels.includes(normalized(value)));
  function cardsField() {
    return field === 'number' || field === 'expiry' || field === 'cvc';
  }
  let nodes = Array.from(
    document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(selectors[field])
  ).filter(visible);
  // Street autocomplete can change its autocomplete attribute after blur; inspect only an exact existing value.
  if (!nodes.length && field === 'line1' && operation.mode === 'inspect') {
    nodes = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[autocomplete="disabled"]')
    ).filter((node) => visible(node) && valueMatches(node.value));
  }
  const states = nodes.map((node, index) => {
    const select = node instanceof HTMLSelectElement;
    const options = select
      ? Array.from(node.options).filter(
          (option) => valueMatches(option.value) || valueMatches(option.textContent ?? '')
        )
      : [];
    return {
      index,
      count: nodes.length,
      select,
      populated: !!node.value.trim(),
      editable: !node.disabled && !(node instanceof HTMLInputElement && node.readOnly),
      matches:
        valueMatches(node.value) ||
        (select &&
          Array.from(node.selectedOptions).some((option) =>
            valueMatches(option.textContent ?? '')
          )),
      optionMatches: options.length,
      ...(field === 'state' &&
      select &&
      node.selectedOptions.length === 1 &&
      /^[A-Za-z]{2,3}$/.test(node.value) &&
      (valueMatches(node.value) || valueMatches(node.selectedOptions[0]!.textContent ?? ''))
        ? { stateCode: node.value }
        : {})
    };
  });
  if (operation.mode === 'inspect') return { ok: true, nodes: states };
  const index = operation.index ?? 0;
  const node = nodes[index];
  if (!node || nodes.length !== operation.expectedCount || !states[index].editable)
    return { ok: false, nodes: [] };
  node.focus();
  if (node instanceof HTMLSelectElement) {
    const options = Array.from(node.options).filter(
      (option) => valueMatches(option.value) || valueMatches(option.textContent ?? '')
    );
    if (options.length !== 1) return { ok: false, nodes: [] };
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    if (!setter) return { ok: false, nodes: [] };
    setter.call(node, options[0].value);
  } else {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) return { ok: false, nodes: [] };
    setter.call(node, expected);
  }
  node.dispatchEvent(new Event('input', { bubbles: true }));
  node.dispatchEvent(new Event('change', { bubbles: true }));
  node.blur();
  return { ok: true, nodes: [] };
}

function trusted(frame: DirectPaymentFrame) {
  try {
    const url = new URL(frame.url);
    return (
      url.protocol === 'https:' &&
      ['chatgpt.com', 'js.stripe.com'].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === '443')
    );
  } catch {
    return false;
  }
}
function remaining(session: DirectPaymentSession, deadline: number) {
  if (session.signal.aborted) throw new Error('bitbrowser_direct_cancelled');
  const value = deadline - Date.now();
  if (value <= 0) throw new Error('official_payment_field_not_ready');
  return Math.min(15_000, value);
}
async function bounded<T>(
  session: DirectPaymentSession,
  deadline: number,
  action: () => Promise<T>
): Promise<T> {
  const milliseconds = remaining(session, deadline);
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      session.signal.removeEventListener('abort', cancel);
    };
    const cancel = () => {
      cleanup();
      reject(new Error('bitbrowser_direct_cancelled'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('official_payment_field_not_ready'));
    }, milliseconds);
    session.signal.addEventListener('abort', cancel, { once: true });
    if (session.signal.aborted) return cancel();
    Promise.resolve()
      .then(() => {
        remaining(session, deadline);
        return action();
      })
      .then(
        (value) => {
          cleanup();
          try {
            remaining(session, deadline);
            resolve(value);
          } catch (cause) {
            reject(cause);
          }
        },
        (cause) => {
          cleanup();
          reject(cause);
        }
      );
  });
}
async function pause(session: DirectPaymentSession, deadline: number) {
  const wait = Math.min(100, remaining(session, deadline));
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      session.signal.removeEventListener('abort', cancel);
      resolve();
    };
    const timer = setTimeout(finish, wait);
    const cancel = () => {
      clearTimeout(timer);
      session.signal.removeEventListener('abort', cancel);
      reject(new Error('bitbrowser_direct_cancelled'));
    };
    session.signal.addEventListener('abort', cancel, { once: true });
    if (session.signal.aborted) cancel();
  });
}
async function operation(
  frame: DirectPaymentFrame,
  input: Operation,
  session: DirectPaymentSession,
  deadline: number
) {
  const result = await bounded(session, deadline, () =>
    frame.evaluate<DocumentResult>(
      `(${directPaymentFieldOperation.toString()})(${JSON.stringify({ ...input, deadline })})`,
      remaining(session, deadline)
    )
  );
  remaining(session, deadline);
  if (!result?.ok || !Array.isArray(result.nodes)) throw new Error('payment_form_changed');
  return result.nodes;
}
async function locate(
  session: DirectPaymentSession,
  field: Field,
  value: string,
  deadline: number,
  scope?: string
) {
  remaining(session, deadline);
  const frames = (await bounded(session, deadline, () => session.frames())).filter(
    (frame) => trusted(frame) && (!scope || frame.id === scope)
  );
  const found: LocatedField[] = [];
  for (const frame of frames) {
    const nodes = await operation(frame, { mode: 'inspect', field, value }, session, deadline);
    found.push(...nodes.map((node) => ({ frame, node })));
  }
  return found;
}
async function one(
  session: DirectPaymentSession,
  field: Field,
  value: string,
  deadline: number,
  required: boolean,
  scope?: string
) {
  while (true) {
    const found = await locate(session, field, value, deadline, scope);
    if (found.length === 1) return found[0];
    if (found.length > 1 && field === 'country') {
      const current = found.filter((item) => item.node.populated);
      if (current.length === 1) return current[0];
    }
    if (found.length > 1 && field === 'state') {
      const matches = found.filter((item) => item.node.select && item.node.optionMatches === 1);
      if (matches.length === 1) return matches[0];
    }
    if (found.length > 1 && cards.includes(field))
      throw new Error('ambiguous_official_payment_field');
    if (!found.length && !required) return undefined;
    await pause(session, deadline);
  }
}
async function billingScope(
  session: DirectPaymentSession,
  details: V2RechargeDetails,
  deadline: number
) {
  while (true) {
    const countries = await locate(session, 'country', details.country, deadline);
    const matching = countries.filter((item) => item.node.matches);
    if (matching.length === 1) return matching[0].frame.id;
    await pause(session, deadline);
  }
}
function required(field: Field, details: V2RechargeDetails) {
  return (
    ['country', 'name', 'line1', 'city', 'postal_code'].includes(field) ||
    ((field === 'state' || field === 'line2') && !!details[field].trim())
  );
}
function validate(details: V2RechargeDetails) {
  if (
    [...cards, ...billing].some((field) => typeof details[field] !== 'string') ||
    !rechargeDetailsReady(details)
  )
    throw new Error('invalid_payment_field');
}

export async function fillDirectPaymentForm(
  session: DirectPaymentSession,
  details: V2RechargeDetails,
  deadline: number
): Promise<BillingSnapshot> {
  validate(details);
  // Observe every card field before the first write, including independent OOPIF sessions.
  while (true) {
    let ready = true;
    for (const field of cards) {
      const found = await locate(session, field, details[field], deadline);
      if (found.length > 1) throw new Error('ambiguous_official_payment_field');
      if (found.length !== 1 || !found[0].node.editable) ready = false;
    }
    if (ready) break;
    await pause(session, deadline);
  }
  for (const field of cards) {
    const target = await one(session, field, details[field], deadline, true);
    await operation(
      target!.frame,
      {
        mode: 'fill',
        field,
        value: details[field],
        index: target!.node.index,
        expectedCount: target!.node.count
      },
      session,
      deadline
    );
  }
  const country = await one(session, 'country', details.country, deadline, true);
  await operation(
    country!.frame,
    {
      mode: 'fill',
      field: 'country',
      value: details.country,
      index: country!.node.index,
      expectedCount: country!.node.count
    },
    session,
    deadline
  );
  for (const field of billing.filter((field) => field !== 'country')) {
    const scope = await billingScope(session, details, deadline);
    const target = await one(
      session,
      field,
      details[field],
      deadline,
      required(field, details),
      scope
    );
    if (target)
      await operation(
        target.frame,
        {
          mode: 'fill',
          field,
          value: details[field],
          index: target.node.index,
          expectedCount: target.node.count
        },
        session,
        deadline
      );
  }
  for (const frame of (await bounded(session, deadline, () => session.frames())).filter(trusted))
    await operation(frame, { mode: 'preferences' }, session, deadline);
  return verifyDirectPaymentForm(session, details, deadline);
}

export async function verifyDirectPaymentForm(
  session: DirectPaymentSession,
  details: V2RechargeDetails,
  deadline: number
): Promise<BillingSnapshot> {
  validate(details);
  for (const field of cards) {
    const target = await one(session, field, details[field], deadline, true);
    if (!target?.node.matches) throw new Error('payment_form_changed');
  }
  const scope = await billingScope(session, details, deadline);
  let state = details.state;
  for (const field of billing) {
    const target = await one(
      session,
      field,
      details[field],
      deadline,
      required(field, details),
      scope
    );
    if (target && !target.node.matches) throw new Error('billing_fields_changed');
    if (field === 'state' && target?.node.stateCode !== undefined) {
      if (!target.node.select || !/^[A-Za-z]{2,3}$/.test(target.node.stateCode))
        throw new Error('billing_fields_changed');
      state = target.node.stateCode;
    }
    const outside = (await locate(session, field, details[field], deadline)).filter(
      (item) => item.frame.id !== scope && new URL(item.frame.url).hostname === 'chatgpt.com'
    );
    if (outside.length) throw new Error('billing_fields_changed');
  }
  return { state };
}
