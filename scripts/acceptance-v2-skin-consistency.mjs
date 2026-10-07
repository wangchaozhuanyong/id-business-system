#!/usr/bin/env node
/* global document, getComputedStyle */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const configuredUrl = process.env.V2_SKIN_ADMIN_URL;
const baseUrl = new URL(configuredUrl || 'http://127.0.0.1:5388');
assert.ok(['localhost', '127.0.0.1', '::1'].includes(baseUrl.hostname), '只允许本机皮肤验收');
const output = path.resolve(root, process.argv[2] ?? '.runtime/skin-consistency-20261001/after');
assert.ok(!path.relative(root, output).startsWith('..'), '验收产物必须位于当前项目');
mkdirSync(output, { recursive: true });
const checks = [];
const runtimeErrors = [];
const overlayFrames = new Map();
const widths = [1440, 1024, 901, 900, 768, 390];
let browser;
let server;

try {
  if (!configuredUrl) {
    server = spawn(
      process.execPath,
      [
        path.join(root, 'node_modules/vite/bin/vite.js'),
        '--host',
        baseUrl.hostname,
        '--port',
        baseUrl.port,
        '--strictPort'
      ],
      {
        cwd: path.join(root, 'apps/admin'),
        env: {
          ...process.env,
          VITE_API_BASE_URL: '/api',
          VITE_V2_REALTIME_CHANGES_ENABLED: 'false'
        },
        stdio: 'ignore'
      }
    );
  }
  const deadline = Date.now() + 30_000;
  while (!(await fetch(new URL('/theme-components-fixture.html', baseUrl)).catch(() => null))?.ok) {
    assert.ok(Date.now() < deadline && server?.exitCode == null, '本机验收服务未启动');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ headless: true });
  for (const mode of ['layout', 'standalone']) {
    for (const theme of ['light', 'dark']) {
      for (const width of widths) {
        const page = await browser.newPage({ viewport: { width, height: 1000 } });
        let shellStylesRequested = false;
        page.on('pageerror', (error) => runtimeErrors.push(error.message));
        await page.route('**/*', async (route) => {
          const url = new URL(route.request().url());
          if (url.pathname.endsWith('/styles/v2.css')) shellStylesRequested = true;
          if (url.origin !== baseUrl.origin || url.pathname.startsWith('/api/')) {
            runtimeErrors.push('皮肤验收出现非本机静态资源请求');
            await route.abort();
          } else await route.continue();
        });
        await page.goto(
          new URL(
            `/theme-components-fixture.html?theme=${theme}&${mode === 'standalone' ? 'standalone' : ''}`,
            baseUrl
          ).href,
          {
            waitUntil: 'networkidle'
          }
        );
        const sample = page.locator('[data-skin-page] [data-skin-sample]');
        await sample.waitFor();
        assert.equal(shellStylesRequested, mode === 'layout', `${mode} 必须验证真实的样式隔离`);
        await disableTransitions(page);
        const pageSkin = await verifySample(page, sample, theme, width, 'page');
        for (const kind of ['dialog', 'drawer']) {
          await page.locator(`[data-theme-${kind}-trigger]`).click();
          const overlaySample = page.locator(`[data-skin-${kind}]`);
          await overlaySample.waitFor();
          // Measure the mounted Teleport DOM using the same controls as the page.
          await page.locator(`[data-skin-${kind}] [data-skin-input] input`).focus();
          await page.locator(`[data-skin-${kind}] [data-skin-input] input`).blur();
          const skin = await verifySample(page, overlaySample, theme, width, kind);
          assert.deepEqual(skin, pageSkin, `${theme}/${width}/${kind} 与页面皮肤不同`);
          const overlay = page.locator(kind === 'dialog' ? '.el-dialog' : '.el-drawer');
          const close = overlay.locator(
            kind === 'dialog' ? '.el-dialog__headerbtn' : '.el-drawer__close-btn'
          );
          const closeBox = await close.boundingBox();
          assert.ok(
            closeBox &&
              closeBox.width >= (width <= 900 ? 44 : 36) &&
              closeBox.height >= (width <= 900 ? 44 : 36),
            '弹层关闭按钮触摸目标不足'
          );
          await page.keyboard.press('Tab');
          await close.focus();
          const focusOutline = await close.evaluate(
            (element) => getComputedStyle(element).outlineWidth
          );
          assert.ok(parseFloat(focusOutline) >= 2, '弹层关闭按钮缺少键盘焦点边界');
          const frame = await overlay.evaluate((element, overlayKind) => {
            const selectors =
              overlayKind === 'drawer'
                ? ['.el-drawer__header', '.el-drawer__body', '.el-drawer__footer']
                : ['.el-dialog__header', '.el-dialog__body', '.el-dialog__footer'];
            return [element, ...selectors.map((selector) => element.querySelector(selector))].map(
              (node) => {
                const css = getComputedStyle(node);
                return Object.fromEntries(
                  [
                    'padding',
                    'minHeight',
                    'position',
                    'backgroundColor',
                    'borderLeftWidth',
                    'fontSize',
                    'lineHeight'
                  ].map((property) => [property, css[property]])
                );
              }
            );
          }, kind);
          const key = `${theme}/${width}/${kind}`;
          if (mode === 'layout') overlayFrames.set(key, frame);
          else assert.deepEqual(frame, overlayFrames.get(key), `${key} 独立入口与后台弹层规则不同`);
          checks.push({
            theme,
            width,
            scope: `${mode}-${kind}-frame`,
            frame,
            closeBox,
            focusOutline
          });
          if ([1440, 390].includes(width)) {
            await page.locator(kind === 'dialog' ? '.el-dialog' : '.el-drawer').screenshot({
              path: path.join(
                output,
                `${mode === 'standalone' ? 'standalone-' : ''}${theme}-${width}-${kind}.png`
              ),
              animations: 'disabled'
            });
          }
          await page.locator(`[data-theme-${kind}-close]`).click();
          await overlaySample.waitFor({ state: 'hidden' });
        }
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > document.documentElement.clientWidth
          ),
          false,
          `${theme}/${width} 页面横向溢出`
        );
        await verifyMailboxStates(page, theme, width);
        await verifyOrderSemantics(page, theme, width);
        await page.close();
      }
    }
  }
  assert.deepEqual(runtimeErrors, []);
  writeFileSync(
    path.join(output, 'checks.json'),
    JSON.stringify(
      {
        ok: true,
        themes: ['light', 'dark'],
        widths,
        entryModes: ['layout', 'standalone'],
        checks,
        runtimeErrors
      },
      null,
      2
    )
  );
  console.log(
    JSON.stringify({
      ok: true,
      scenarios: checks.length,
      themes: 2,
      viewportWidths: widths.length,
      entryModes: 2,
      realOverlayTypes: ['dialog', 'drawer'],
      output
    })
  );
} finally {
  await browser?.close();
  server?.kill('SIGTERM');
}

async function verifySample(page, sample, theme, width, scope) {
  await sample.locator('.el-form-item__error').waitFor({ state: 'visible' });
  const skin = await sample.evaluate((rootElement) => {
    const style = (selector, pseudo) => {
      const element = rootElement.querySelector(selector);
      if (!element) throw new Error(`缺少皮肤验收节点 ${selector}`);
      const css = getComputedStyle(element, pseudo);
      return Object.fromEntries(
        [
          'height',
          'minHeight',
          'borderRadius',
          'fontSize',
          'fontWeight',
          'lineHeight',
          'color',
          'backgroundColor',
          'boxShadow',
          'content'
        ].map((property) => [property, css[property]])
      );
    };
    const input = rootElement.querySelector('[data-skin-input] .el-input__wrapper');
    const label = input.closest('.el-form-item').querySelector('.el-form-item__label');
    const range = document.createRange();
    range.selectNodeContents(label);
    const text = range.getBoundingClientRect();
    const control = input.getBoundingClientRect();
    const css = getComputedStyle(rootElement);
    return {
      input: style('[data-skin-input] .el-input__wrapper'),
      select: style('[data-skin-select] .el-select__wrapper'),
      inputText: style('[data-skin-input] input'),
      selectText: style('[data-skin-select] .el-select__placeholder'),
      label: style('.el-form-item__label'),
      disabled: style('[data-skin-disabled] .el-input__wrapper'),
      disabledText: style('[data-skin-disabled] input'),
      invalid: style('[data-skin-invalid] .el-input__wrapper'),
      header: style('th.el-table__cell'),
      cell: style('td.el-table__cell'),
      tag: style('.el-tag'),
      dot: style('.el-tag', '::before'),
      pagination: style('.el-pager li'),
      labelDeviation: Math.abs(text.top + text.height / 2 - control.top - control.height / 2),
      overviewToken: css.getPropertyValue('--v2-overview-text').trim(),
      monoToken: css.getPropertyValue('--v3-font-mono').trim()
    };
  });
  assert.equal(
    skin.input.height,
    width <= 900 ? '44px' : '36px',
    `${theme}/${width}/${scope} 控件高度`
  );
  assert.equal(skin.input.borderRadius, '8px');
  assert.equal(skin.select.height, skin.input.height);
  assert.equal(skin.inputText.fontSize, '13px');
  assert.equal(skin.selectText.fontSize, '13px');
  assert.equal(skin.header.height, '42px');
  assert.equal(skin.cell.height, '50px');
  assert.equal(skin.tag.fontWeight, '600');
  assert.equal(skin.dot.content, '""');
  assert.ok(skin.overviewToken && skin.monoToken, '页面外公共主题令牌缺失');
  assert.ok(skin.labelDeviation <= 2, `${scope} 标签偏差 ${skin.labelDeviation}px`);
  const normalInput = sample.locator('[data-skin-input] input');
  await normalInput.focus();
  skin.focusShadow = await sample
    .locator('[data-skin-input] .el-input__wrapper')
    .evaluate((element) => getComputedStyle(element).boxShadow);
  assert.ok(skin.focusShadow.includes('0px 0px 0px 2px'), '输入焦点指示缺失');
  await normalInput.blur();
  await sample.locator('[data-skin-invalid] input').focus();
  const errorShadow = await sample
    .locator('[data-skin-invalid] .el-input__wrapper')
    .evaluate((element) => getComputedStyle(element).boxShadow);
  assert.equal(errorShadow, skin.invalid.boxShadow, '聚焦不能覆盖校验错误边框');
  await sample.locator('[data-skin-invalid] input').blur();
  await sample.locator('.el-form-item__error').waitFor({ state: 'visible' });
  const stateColors = await page.evaluate(() => {
    const probe = document.createElement('span');
    document.body.append(probe);
    const resolve = (token) => {
      probe.style.color = `var(${token})`;
      return getComputedStyle(probe).color;
    };
    const colors = {
      disabledBg: resolve('--v3-disabled-surface'),
      disabledText: resolve('--v3-disabled-text'),
      danger: resolve('--v3-danger')
    };
    probe.remove();
    return colors;
  });
  assert.equal(skin.disabled.backgroundColor, stateColors.disabledBg);
  assert.equal(skin.disabledText.color, stateColors.disabledText);
  assert.ok(skin.invalid.boxShadow.includes(stateColors.danger), '错误边框未使用语义主题色');
  checks.push({ theme, width, scope, ...skin });
  delete skin.labelDeviation; // Compare styling, while testing text geometry separately in every scope.
  // Wrappers paint borders and backgrounds; text is painted by input/placeholder nodes.
  // Their unused inherited text color can differ with surrounding page/dialog prose.
  for (const key of ['input', 'select', 'disabled', 'invalid']) delete skin[key].color;
  return skin;
}

async function verifyMailboxStates(page, theme, width) {
  await page.goto(new URL(`/vendure-mailbox-design-fixture.html?theme=${theme}`, baseUrl).href, {
    waitUntil: 'networkidle'
  });
  await page.locator('.vendure-mailbox-toolbar').waitFor();
  await applyTheme(page, theme);
  await disableTransitions(page);
  // These isolated semantic samples exercise the actual business CSS without mailbox requests.
  const states = await page.evaluate(() => {
    const section = document.createElement('section');
    section.id = 'skin-semantic-samples';
    for (const [className, label] of [
      ['vendure-mailbox-message', '成功提示'],
      ['vendure-mailbox-error', '失败提示'],
      ['vendure-mailbox-unconfigured', '配置提示']
    ]) {
      const p = document.createElement('p');
      p.className = className;
      p.textContent = `皮肤检查：${label}`;
      section.append(p);
    }
    document.querySelector('.vendure-mailbox-page').prepend(section);
    return [...section.children].map((element) => {
      const css = getComputedStyle(element);
      return { className: element.className, color: css.color, background: css.backgroundColor };
    });
  });
  for (const state of states)
    assert.ok(
      contrast(state.color, state.background) >= 4.5,
      `${theme} ${state.className} 文本对比度`
    );
  if ([1440, 390].includes(width))
    await page
      .locator('#skin-semantic-samples')
      .screenshot({ path: path.join(output, `mailbox-states-${theme}-${width}.png`) });
  checks.push({ theme, width, scope: 'mailbox-semantic-css', states });
}

async function verifyOrderSemantics(page, theme, width) {
  await page.goto(new URL(`/order-entry-design-fixture.html?theme=${theme}`, baseUrl).href, {
    waitUntil: 'networkidle'
  });
  await page.locator('.v2-order-entry-page').waitFor();
  await applyTheme(page, theme);
  await disableTransitions(page);
  const states = await page
    .locator(
      '.v2-order-entry-selected-id header strong.is-ready, .v2-order-entry-live-summary .is-profit dd small'
    )
    .evaluateAll((elements) =>
      elements.map((element) => {
        const css = getComputedStyle(element);
        const backgrounds = [];
        for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
          backgrounds.unshift(getComputedStyle(ancestor).backgroundColor);
        }
        const background = backgrounds.reduce(
          (result, color) => {
            const channels = color.match(/[\d.]+/g).map(Number);
            const alpha = channels[3] ?? 1;
            return result.map((channel, index) => channels[index] * alpha + channel * (1 - alpha));
          },
          [255, 255, 255]
        );
        return { color: css.color, background: `rgb(${background.join(', ')})` };
      })
    );
  assert.equal(states.length, 2, '订单夹具缺少选中 ID 和利润状态');
  for (const state of states)
    assert.ok(contrast(state.color, state.background) >= 4.5, `${theme} 订单成功状态对比度`);
  checks.push({ theme, width, scope: 'order-semantic-colors', states });
}

async function disableTransitions(page) {
  await page.addStyleTag({
    content: '*, *::before, *::after { transition: none !important; animation: none !important; }'
  });
}

async function applyTheme(page, theme) {
  await page.evaluate(async (value) => {
    const { applyV2Theme } = await import('/src/v2/theme.ts');
    applyV2Theme(value);
  }, theme);
}

function contrast(foreground, background) {
  const luminance = (color) => {
    const channels = color
      .match(/[\d.]+/g)
      .slice(0, 3)
      .map((value) => {
        const channel = Number(value) / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
