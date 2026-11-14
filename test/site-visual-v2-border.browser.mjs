// Measure actual resting control boundaries, including the hosted recharge surface.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { chromium } from 'playwright';
import { interceptDesign, origin, root, settle, toggleDesignTheme } from './helpers/offline-design.mjs';
import { fixture, actor } from './helpers/site-visual-v2-fixtures.mjs';

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const requests = await interceptDesign(context, { localFixtures: fixture, actor });
const page = await context.newPage();
const scenes = [];
const states = [];
const output = process.env.ID_LAYOUT_QA_OUTPUT || root + '/.runtime/control-borders';
const outputRelative = relative(root, output);
if (outputRelative.startsWith('..') || isAbsolute(outputRelative)) throw new Error('验收输出必须位于本项目内');
await mkdir(output, { recursive: true });
const routes = ['workspace/order/gpt', 'accounts/gpt', 'orders/gpt', 'customers/new',
  'settings/costs', 'settings/monitoring', 'recharge/start', 'online-recharge/chatgpt'];
function measure(scope) {
  const channels = value => (value.match(/[\d.]+/g) || []).map(Number);
  const luminance = value => channels(value).slice(0, 3).map(v => v / 255)
    .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) /
    (Math.min(luminance(a), luminance(b)) + .05);
  const background = node => {
    for (let current = node; current; current = current.parentElement) {
      const value = getComputedStyle(current).backgroundColor, rgba = channels(value);
      if (rgba.length === 3 || rgba[3] === 1) return value;
    }
    return getComputedStyle(document.documentElement).backgroundColor;
  };
  return [...document.querySelector(scope).querySelectorAll(
    "input:not([type='checkbox']):not([type='radio']):not([type='hidden']):not([type='range']):not([type='file']),select,textarea,.commerce-search-picker > .commerce-picker-trigger"
  )].filter(node => node.checkVisibility()).map(node => {
    const style = getComputedStyle(node);
    return { id: node.id, tag: node.tagName, borders: ['Top','Right','Bottom','Left'].map(side => style[`border${side}`]), disabled: node.disabled,
      shadow: style.boxShadow, bottomWidth: parseFloat(style.borderBottomWidth),
      border: style.borderBottomColor, background: background(node),
      ratio: contrast(style.borderBottomColor, background(node)) };
  });
}
async function checkOrderStates(page, width, theme) {
  const targets = ['commerce-paidAmount', 'commerce-saleAmount', 'commerce-paidCurrency',
    'commerce-saleCurrency', 'commerce-email', 'commerce-customerId-picker', 'commerce-emailHistory-picker'];
  for (const id of targets) {
    const control = page.locator('#' + id);
    if (!(await control.isVisible()) || !(await control.isEnabled())) continue;
    const before = await control.boundingBox();
    await page.keyboard.press('Tab');
    await control.focus();
    await settle(page);
    const focus = (await page.evaluate(measure, '#commerce-order-form')).find(item => item.id === id);
    const after = await control.boundingBox();
    states.push({ width, theme, state: 'focus', ...focus });
    assert(focus.shadow !== 'none', id + ' keeps a visible focus ring');
    assert(focus.ratio >= 3, id + ' focus boundary remains visible');
    assert.equal(before.width, after.width, id + ' focus does not resize the control');
    assert.equal(before.height, after.height, id + ' focus does not resize the control');
    if (['INPUT', 'SELECT'].includes(focus.tag)) {
      // Exercise the existing error/disabled presentation without submitting any form.
      await control.evaluate(node => node.setAttribute('aria-invalid', 'true'));
      await settle(page);
      const error = (await page.evaluate(measure, '#commerce-order-form')).find(item => item.id === id);
      states.push({ width, theme, state: 'error', ...error });
      assert.notEqual(error.border, focus.border, id + ' error is distinct from focus');
      assert(error.ratio >= 3, id + ' error boundary remains visible');
      await control.evaluate(node => { node.removeAttribute('aria-invalid'); node.blur(); node.disabled = true; });
      await settle(page);
      states.push({ width, theme, state: 'disabled', ...(await page.evaluate(measure, '#commerce-order-form')).find(item => item.id === id) });
      await control.evaluate(node => { node.disabled = false; });
    } else await control.evaluate(node => node.blur());
  }
  await page.locator('#commerce-paidAmount').fill('983');
  await page.locator('#commerce-saleAmount').fill('130');
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
  await settle(page);
  const groups = await page.locator('.order-financial-groups--amounts .order-financial-group').evaluateAll(nodes =>
    nodes.map(node => {
      const title = node.querySelector('.title-with-help'), currency = node.querySelector('select');
      const a = title.getBoundingClientRect(), b = currency.getBoundingClientRect();
      return { overlap: a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top,
        currencyOverflow: currency.scrollWidth > currency.clientWidth + 1 };
    }));
  assert(groups.every(group => !group.overlap && !group.currencyOverflow), 'amount titles and currencies remain readable');
  await page.screenshot({ path: output + `/order-${width}-${theme}.png` });
  await page.locator('.order-financial-groups--amounts').screenshot({ path: output + `/amounts-${width}-${theme}.png` });
}
try {
  for (const width of [1440, 390, 320]) for (const route of routes) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(origin + '/#/' + route);
    await page.locator(`#main[data-layout-route="${route}"]`).waitFor();
    for (const theme of ['light', 'dark']) {
      if (await page.evaluate(() => document.documentElement.dataset.theme) !== theme) await toggleDesignTheme(page);
      await settle(page);
      scenes.push({ route, width, theme, controls: await page.evaluate(measure, '#main') });
      for (const frame of page.frames().slice(1)) {
        const owner = await frame.frameElement();
        if (!(await owner.isVisible()) || !frame.url().startsWith(origin)) continue;
        await frame.waitForLoadState();
        scenes.push({ route, width, theme, frame: new URL(frame.url()).pathname, controls: await frame.evaluate(measure, 'body') });
      }
      if (route === 'workspace/order/gpt') await checkOrderStates(page, width, theme);
    }
  }
} finally { await browser.close(); }
// User-approved resting controls use one light boundary on all four edges.
// Joined email controls intentionally omit the internal seam only.
const failures = [...scenes, ...states.map(({ width, theme, state, ...control }) =>
  ({ width, theme, state, route: 'workspace/order/gpt', controls: [control] }))].flatMap(scene => scene.controls.filter(control => {
  return control.borders.some((border, side) => {
    if (control.id === 'commerce-email' && side === 1) return !border.startsWith('0px ');
    return !border.startsWith('1px solid rgb(') || border !== control.borders[0];
  });
})
  .map(control => ({ route: scene.route, theme: scene.theme, frame: scene.frame, ...control })));
await writeFile(output + '/control-borders.json', JSON.stringify({ scenes, states, failures }, null, 2));
assert.deepEqual(requests.external, []);
assert.deepEqual(requests.unavailable, []);
assert.deepEqual(failures, []);
console.log(JSON.stringify({ controls: scenes.reduce((sum, scene) => sum + scene.controls.length, 0), states: states.length, failures: 0 }));
