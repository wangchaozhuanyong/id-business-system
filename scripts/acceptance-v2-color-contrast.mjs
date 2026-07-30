#!/usr/bin/env node
/* global document, getComputedStyle */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const rootDir = process.cwd();
const adminDir = path.join(rootDir, 'apps', 'admin');
const viteCliPath = path.join(rootDir, 'node_modules', 'vite', 'bin', 'vite.js');
const configuredAdminUrl = process.env.V2_COLOR_CONTRAST_ADMIN_URL;
const adminUrl = new URL(configuredAdminUrl ?? 'http://127.0.0.1:5386');
const screenshotDirectory = process.env.V2_COLOR_CONTRAST_SCREENSHOT_DIR
  ? path.resolve(process.env.V2_COLOR_CONTRAST_SCREENSHOT_DIR)
  : null;
const themes = ['light', 'dark'];
const viewportWidths = [1440, 390];
const variants = ['default', 'primary', 'soft', 'danger', 'success', 'ghost'];

assert.ok(
  ['localhost', '127.0.0.1', '::1'].includes(adminUrl.hostname),
  '颜色对比度验收只允许连接本机管理端'
);

if (screenshotDirectory) mkdirSync(screenshotDirectory, { recursive: true });

let adminServer = null;
let browser = null;

try {
  if (!configuredAdminUrl) adminServer = startAdminServer(adminUrl);
  await waitForServer(adminUrl, adminServer);

  browser = await chromium.launch({ headless: true });
  for (const theme of themes) {
    for (const width of viewportWidths) {
      await verifyScenario(browser, theme, width);
    }
  }

  console.log(
    JSON.stringify({
      ok: true,
      themes,
      viewportWidths,
      variants,
      minimumTextContrast: 4.5,
      minimumFocusContrast: 3
    })
  );
} finally {
  await browser?.close().catch(() => undefined);
  await stopAdminServer(adminServer);
}

function startAdminServer(url) {
  const output = [];
  const child = spawn(
    process.execPath,
    [viteCliPath, '--host', url.hostname, '--port', url.port, '--strictPort'],
    {
      cwd: adminDir,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        VITE_API_BASE_URL: '/api',
        VITE_SUPABASE_URL: '',
        VITE_SUPABASE_ANON_KEY: '',
        VITE_SUPABASE_PUBLISHABLE_KEY: '',
        VITE_V2_REALTIME_CHANGES_ENABLED: 'false'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      output.push(String(chunk));
      if (output.length > 80) output.shift();
    });
  }
  child.recentOutput = output;
  return child;
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 30_000;
  const fixtureUrl = new URL('/button-contrast-fixture.html', url);
  while (Date.now() < deadline) {
    if (child?.exitCode != null) {
      throw new Error(
        `管理端测试服务器提前退出（${child.exitCode}）：\n${child.recentOutput.join('')}`
      );
    }
    const response = await fetch(fixtureUrl, {
      signal: AbortSignal.timeout(1_000)
    }).catch(() => null);
    if (response?.ok) return;
    await delay(200);
  }
  throw new Error(`管理端测试服务器未在 30 秒内启动：${fixtureUrl}`);
}

async function stopAdminServer(child) {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('close', resolve)),
    delay(3_000).then(() => {
      if (child.exitCode == null) child.kill('SIGKILL');
    })
  ]);
}

async function verifyScenario(browserInstance, theme, width) {
  const context = await browserInstance.newContext({
    viewport: { width, height: width <= 390 ? 844 : 1000 }
  });
  const page = await context.newPage();
  const runtimeErrors = [];

  page.on('pageerror', (error) => runtimeErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(message.text());
  });

  try {
    const fixtureUrl = new URL('/button-contrast-fixture.html', adminUrl);
    fixtureUrl.searchParams.set('theme', theme);
    await page.goto(fixtureUrl.href, {
      waitUntil: 'networkidle'
    });
    await page.locator('[data-button-contrast-fixture]').waitFor({ state: 'visible' });

    const stateMeasurements = await measureButtons(page, '[data-button-variant]');
    assert.equal(
      stateMeasurements.length,
      variants.length * 3,
      `${theme} ${width}px 未渲染完整按钮状态矩阵`
    );
    for (const measurement of stateMeasurements) {
      assertTextContrast(measurement, `${theme} ${width}px`);
      assert.equal(
        measurement.clipped,
        false,
        `${theme} ${width}px ${measurement.variant}/${measurement.state} 文字发生裁切`
      );
      if (measurement.state === 'disabled') {
        assert.equal(
          measurement.disabled,
          true,
          `${theme} ${width}px ${measurement.variant} 未进入原生禁用状态`
        );
      }
      if (measurement.state === 'loading') {
        assert.equal(
          measurement.loading,
          true,
          `${theme} ${width}px ${measurement.variant} 未进入加载状态`
        );
        assert.equal(
          measurement.loadingMaskAlpha,
          0,
          `${theme} ${width}px ${measurement.variant} 加载遮罩改变了实际颜色`
        );
      }
    }

    for (const variant of variants) {
      const button = page.locator(`[data-button-variant="${variant}"][data-button-state="normal"]`);

      await button.hover();
      assertTextContrast(await measureButton(button), `${theme} ${width}px ${variant}/hover`);

      const box = await button.boundingBox();
      assert.ok(box, `${theme} ${width}px ${variant} 无法测量按下状态`);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      try {
        assertTextContrast(await measureButton(button), `${theme} ${width}px ${variant}/active`);
      } finally {
        await page.mouse.up();
      }

      await page.keyboard.press('Tab');
      await button.focus();
      const focusMeasurement = await button.evaluate((element) => {
        const style = getComputedStyle(element);
        const card = element.closest('.v2-button-contrast__card');
        return {
          outlineColor: style.outlineColor,
          outlineStyle: style.outlineStyle,
          outlineWidth: Number.parseFloat(style.outlineWidth),
          adjacentBackground: card ? getComputedStyle(card).backgroundColor : 'rgb(255, 255, 255)'
        };
      });
      assert.equal(
        focusMeasurement.outlineStyle,
        'solid',
        `${theme} ${width}px ${variant} 缺少实线焦点边界`
      );
      assert.ok(
        focusMeasurement.outlineWidth >= 2,
        `${theme} ${width}px ${variant} 焦点边界宽度不足 2px`
      );
      assert.ok(
        contrastRatio(
          parseCssColor(focusMeasurement.outlineColor),
          parseCssColor(focusMeasurement.adjacentBackground)
        ) >= 3,
        `${theme} ${width}px ${variant} 焦点边界对比度低于 3:1`
      );
    }

    const orderMeasurements = await measureButtons(page, '[data-order-entry-state]');
    assert.deepEqual(
      orderMeasurements.map(({ state }) => state),
      ['disabled', 'ready', 'loading'],
      `${theme} ${width}px 订单录入主操作状态不完整`
    );
    for (const measurement of orderMeasurements) {
      assertTextContrast(measurement, `${theme} ${width}px 订单录入/${measurement.state}`);
      assert.equal(
        measurement.clipped,
        false,
        `${theme} ${width}px 订单录入/${measurement.state} 文字发生裁切`
      );
    }

    const overflow = await page.evaluate(() =>
      Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)
    );
    assert.equal(overflow, 0, `${theme} ${width}px 页面出现横向溢出`);
    assert.deepEqual(
      runtimeErrors,
      [],
      `${theme} ${width}px 浏览器错误：${runtimeErrors.join('\n')}`
    );

    if (screenshotDirectory) {
      await page.screenshot({
        fullPage: true,
        path: path.join(screenshotDirectory, `${theme}-${width}.png`)
      });
    }
  } finally {
    await context.close();
  }
}

function assertTextContrast(measurement, context) {
  const ratio = contrastRatio(
    parseCssColor(measurement.foreground),
    parseCssColor(measurement.background)
  );
  assert.ok(
    ratio >= 4.5,
    `${context} ${measurement.variant}/${measurement.state}: ${measurement.foreground} / ${measurement.background} = ${ratio.toFixed(2)}:1，低于 4.5:1`
  );
}

async function measureButtons(page, selector) {
  return page.locator(selector).evaluateAll((buttons) => {
    const measure = (button) => {
      const parseAlpha = (value) => {
        const match = value.match(
          /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/
        );
        if (!match) throw new Error(`无法解析 CSS 颜色：${value}`);
        return match[4] == null ? 1 : Number(match[4]);
      };
      const resolveBackground = (element) => {
        let current = element;
        while (current) {
          const color = getComputedStyle(current).backgroundColor;
          if (parseAlpha(color) >= 1) return color;
          current = current.parentElement;
        }
        return 'rgb(255, 255, 255)';
      };
      const contentSpan = button.querySelector(':scope > span') ?? button.querySelector('span');
      const textStyle = getComputedStyle(contentSpan ?? button);
      const rect = button.getBoundingClientRect();
      const spanRect = contentSpan?.getBoundingClientRect();
      return {
        variant:
          button.getAttribute('data-button-variant') ??
          (button.getAttribute('data-order-entry-state') ? 'primary' : 'unknown'),
        state:
          button.getAttribute('data-button-state') ??
          button.getAttribute('data-order-entry-state') ??
          'unknown',
        foreground: textStyle.color,
        background: resolveBackground(button),
        disabled: button.hasAttribute('disabled'),
        loading: button.classList.contains('is-loading'),
        loadingMaskAlpha: parseAlpha(getComputedStyle(button, '::before').backgroundColor),
        clipped: Boolean(
          spanRect &&
          (spanRect.left < rect.left - 1 ||
            spanRect.right > rect.right + 1 ||
            spanRect.top < rect.top - 1 ||
            spanRect.bottom > rect.bottom + 1)
        )
      };
    };
    return buttons.map((button) => measure(button));
  });
}

async function measureButton(locator) {
  return locator.evaluate((button) => {
    const parseAlpha = (value) => {
      const match = value.match(
        /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/
      );
      if (!match) throw new Error(`无法解析 CSS 颜色：${value}`);
      return match[4] == null ? 1 : Number(match[4]);
    };
    const resolveBackground = (element) => {
      let current = element;
      while (current) {
        const color = getComputedStyle(current).backgroundColor;
        if (parseAlpha(color) >= 1) return color;
        current = current.parentElement;
      }
      return 'rgb(255, 255, 255)';
    };
    const contentSpan = button.querySelector(':scope > span') ?? button.querySelector('span');
    const textStyle = getComputedStyle(contentSpan ?? button);
    const rect = button.getBoundingClientRect();
    const spanRect = contentSpan?.getBoundingClientRect();
    return {
      variant:
        button.getAttribute('data-button-variant') ??
        (button.getAttribute('data-order-entry-state') ? 'primary' : 'unknown'),
      state:
        button.getAttribute('data-button-state') ??
        button.getAttribute('data-order-entry-state') ??
        'unknown',
      foreground: textStyle.color,
      background: resolveBackground(button),
      disabled: button.hasAttribute('disabled'),
      loading: button.classList.contains('is-loading'),
      loadingMaskAlpha: parseAlpha(getComputedStyle(button, '::before').backgroundColor),
      clipped: Boolean(
        spanRect &&
        (spanRect.left < rect.left - 1 ||
          spanRect.right > rect.right + 1 ||
          spanRect.top < rect.top - 1 ||
          spanRect.bottom > rect.bottom + 1)
      )
    };
  });
}

function parseCssColor(value) {
  const match = value.match(
    /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/
  );
  assert.ok(match, `无法解析 CSS 颜色：${value}`);
  return {
    red: Number(match[1]),
    green: Number(match[2]),
    blue: Number(match[3]),
    alpha: match[4] == null ? 1 : Number(match[4])
  };
}

function contrastRatio(first, second) {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}

function relativeLuminance(color) {
  const channels = [color.red, color.green, color.blue].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
