// Measure actual resting control boundaries, including the hosted recharge surface.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { interceptDesign, origin, root, settle, toggleDesignTheme } from './helpers/offline-design.mjs';
import { fixture, actor } from './helpers/site-visual-v2-fixtures.mjs';

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const requests = await interceptDesign(context, { localFixtures: fixture, actor });
const page = await context.newPage();
const scenes = [];
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
  )].filter(node => node.checkVisibility() && !node.disabled).map(node => {
    const style = getComputedStyle(node);
    return { id: node.id, tag: node.tagName, bottomWidth: parseFloat(style.borderBottomWidth),
      border: style.borderBottomColor, background: background(node),
      ratio: contrast(style.borderBottomColor, background(node)) };
  });
}
try {
  for (const route of routes) {
    await page.goto(origin + '/#/' + route);
    await page.locator(`#main[data-layout-route="${route}"]`).waitFor();
    for (const theme of ['light', 'dark']) {
      if (await page.evaluate(() => document.documentElement.dataset.theme) !== theme) await toggleDesignTheme(page);
      await settle(page);
      scenes.push({ route, theme, controls: await page.evaluate(measure, '#main') });
      for (const frame of page.frames().slice(1)) {
        const owner = await frame.frameElement();
        if (!(await owner.isVisible()) || !frame.url().startsWith(origin)) continue;
        await frame.waitForLoadState();
        scenes.push({ route, theme, frame: new URL(frame.url()).pathname, controls: await frame.evaluate(measure, 'body') });
      }
    }
  }
} finally { await browser.close(); }
const failures = scenes.flatMap(scene => scene.controls.filter(control => control.ratio < 3 || control.bottomWidth < 1)
  .map(control => ({ route: scene.route, theme: scene.theme, frame: scene.frame, ...control })));
await writeFile(root + '/docs/design/site-visual-v2-20261113/control-borders.json', JSON.stringify({ scenes, failures }, null, 2));
assert.deepEqual(requests.external, []);
assert.deepEqual(requests.unavailable, []);
assert.deepEqual(failures, []);
console.log(JSON.stringify({ controls: scenes.reduce((sum, scene) => sum + scene.controls.length, 0), failures: 0 }));
