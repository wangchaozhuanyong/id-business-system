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
const statusTypes = ['primary', 'success', 'warning', 'danger', 'info'];

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
  await warmFixture(browser, '/button-contrast-fixture.html', '[data-button-contrast-fixture]');
  await warmFixture(browser, '/theme-components-fixture.html', '[data-theme-components-fixture]');
  await warmFixture(browser, '/dashboard-design-fixture.html', '[data-theme-dashboard-overview]');
  await warmFixture(browser, '/branding-design-fixture.html', '[data-theme-branding-preview]');
  for (const theme of themes) {
    for (const width of viewportWidths) {
      await verifyScenario(browser, theme, width);
      await verifyThemeComponentsScenario(browser, theme, width);
      await verifyFeatureThemeScenario(browser, theme, width);
    }
  }

  console.log(
    JSON.stringify({
      ok: true,
      themes,
      viewportWidths,
      variants,
      statusTypes,
      componentSurfaces: 15,
      minimumTextContrast: 4.5,
      minimumFocusContrast: 3
    })
  );
} finally {
  await browser?.close().catch(() => undefined);
  await stopAdminServer(adminServer);
}

async function warmFixture(browserInstance, pathname, readySelector) {
  const context = await browserInstance.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const fixtureUrl = new URL(pathname, adminUrl).href;

  try {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await page.goto(fixtureUrl, { waitUntil: 'networkidle' });
      const ready = await page
        .locator(readySelector)
        .waitFor({ state: 'visible', timeout: 5_000 })
        .then(() => true)
        .catch(() => false);
      if (ready) return;
    }
    throw new Error(`主题验收预热失败：${fixtureUrl}`);
  } finally {
    await context.close();
  }
}

function startAdminServer(url) {
  const output = [];
  const child = spawn(
    process.execPath,
    [viteCliPath, '--host', url.hostname, '--port', url.port, '--strictPort', '--force'],
    {
      cwd: adminDir,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        VITE_API_BASE_URL: '/api',
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

async function verifyThemeComponentsScenario(browserInstance, theme, width) {
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
    const fixtureUrl = new URL('/theme-components-fixture.html', adminUrl);
    fixtureUrl.searchParams.set('theme', theme);
    await page.goto(fixtureUrl.href, { waitUntil: 'networkidle' });
    await page.locator('[data-theme-components-fixture]').waitFor({ state: 'visible' });

    const themeState = await page.evaluate(() => ({
      classList: [...document.documentElement.classList],
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      theme: document.documentElement.dataset.v2Theme
    }));
    assert.equal(themeState.theme, theme, `${theme} ${width}px 产品主题标记未同步`);
    assert.equal(
      themeState.classList.includes('dark'),
      theme === 'dark',
      `${theme} ${width}px Element Plus 深色主题类未同步`
    );
    assert.equal(themeState.colorScheme, theme, `${theme} ${width}px 原生 color-scheme 未同步`);

    const surfaceSelectors = [
      ['页面概览', '[data-theme-overview]'],
      ['输入框', '.el-input__wrapper'],
      ['选择器', '.el-select__wrapper'],
      ['文本域', '.el-textarea__inner'],
      ['数字输入', '.el-input-number .el-input__wrapper'],
      ['日期输入', '.el-date-editor .el-input__wrapper'],
      ['表格', '.el-table'],
      ['表头', '.el-table th.el-table__cell'],
      ['表格单元格', '.el-table td.el-table__cell'],
      ['分页按钮', '.el-pagination .btn-prev']
    ];
    for (const [label, selector] of surfaceSelectors) {
      assertThemeSurface(await measureThemeNode(page.locator(selector).first()), theme, {
        label,
        width
      });
    }

    const textSelectors = [
      ['概览标题', '[data-theme-overview-title]'],
      ['概览说明', '[data-theme-overview-copy]'],
      ['概览强调文字', '[data-theme-overview-accent]'],
      ['概览指标标题', '[data-theme-overview-metric-label]'],
      ['概览指标数值', '[data-theme-overview-metric-value]'],
      ['输入框文字', '.el-input__inner'],
      ['选择器文字', '.el-select__selected-item'],
      ['文本域文字', '.el-textarea__inner'],
      ['数字输入文字', '.el-input-number .el-input__inner'],
      ['日期输入文字', '.el-date-editor .el-input__inner'],
      ['表头文字', '.el-table th.el-table__cell .cell'],
      ['表格文字', '.el-table td.el-table__cell .cell'],
      ['分页文字', '.el-pagination .btn-prev'],
      ['标签页文字', '.el-tabs__item.is-active']
    ];
    for (const [label, selector] of textSelectors) {
      assertThemeTextContrast(await measureThemeNode(page.locator(selector).first()), {
        label,
        theme,
        width
      });
    }

    const statusBackgrounds = [];
    for (const statusType of statusTypes) {
      const measurement = await measureThemeNode(
        page.locator(`.v2-table-column--status .el-tag--${statusType}`).first()
      );
      assertThemeTextContrast(measurement, {
        label: `${statusType} 状态标签文字`,
        theme,
        width
      });
      statusBackgrounds.push(measurement.background);
    }
    assert.equal(
      new Set(statusBackgrounds).size,
      statusTypes.length,
      `${theme} ${width}px 状态标签背景色未完整区分：${statusBackgrounds.join(', ')}`
    );

    await page.locator('[data-theme-dropdown-trigger]').click();
    const dropdown = page.locator('.el-dropdown__popper').filter({ visible: true });
    await dropdown.waitFor({ state: 'visible' });
    assertThemeSurface(await measureThemeNode(dropdown), theme, {
      label: '下拉浮层',
      width
    });
    assertThemeTextContrast(
      await measureThemeNode(dropdown.locator('.el-dropdown-menu__item').first()),
      { label: '下拉浮层文字', theme, width }
    );
    await page.keyboard.press('Escape');

    await page.locator('[data-theme-dialog-trigger]').click();
    const dialog = page.locator('.el-dialog');
    await dialog.waitFor({ state: 'visible' });
    assertThemeSurface(await measureThemeNode(dialog), theme, { label: '弹窗', width });
    assertThemeTextContrast(await measureThemeNode(dialog.locator('[data-theme-dialog-copy]')), {
      label: '弹窗文字',
      theme,
      width
    });
    await dialog.locator('[data-theme-dialog-close]').click();
    await dialog.waitFor({ state: 'hidden' });

    await page.locator('[data-theme-drawer-trigger]').click();
    const drawer = page.locator('.el-drawer');
    await drawer.waitFor({ state: 'visible' });
    assertThemeSurface(await measureThemeNode(drawer), theme, { label: '抽屉', width });
    assertThemeTextContrast(await measureThemeNode(drawer.locator('[data-theme-drawer-copy]')), {
      label: '抽屉文字',
      theme,
      width
    });
    await drawer.locator('[data-theme-drawer-close]').click();
    await drawer.waitFor({ state: 'hidden' });

    const overflow = await page.evaluate(() =>
      Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)
    );
    assert.equal(overflow, 0, `${theme} ${width}px 主题组件页出现横向溢出`);
    assert.deepEqual(
      runtimeErrors,
      [],
      `${theme} ${width}px 主题组件页浏览器错误：${runtimeErrors.join('\n')}`
    );

    if (screenshotDirectory) {
      await page.screenshot({
        fullPage: true,
        path: path.join(screenshotDirectory, `components-${theme}-${width}.png`)
      });
    }
  } finally {
    await context.close();
  }
}

async function verifyFeatureThemeScenario(browserInstance, theme, width) {
  const scenarios = [
    {
      label: '仪表盘经营概览',
      pathname: '/dashboard-design-fixture.html',
      readySelector: '[data-theme-dashboard-overview]',
      surfaceSelector: '[data-theme-dashboard-overview]',
      textSelector: '[data-theme-dashboard-overview] h2'
    },
    {
      label: '品牌登录页预览',
      pathname: '/branding-design-fixture.html',
      readySelector: '[data-theme-branding-preview]',
      surfaceSelector: '[data-theme-branding-preview]',
      textSelector: '[data-theme-branding-preview] h3'
    }
  ];

  for (const scenario of scenarios) {
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
      const fixtureUrl = new URL(scenario.pathname, adminUrl);
      fixtureUrl.searchParams.set('theme', theme);
      await page.goto(fixtureUrl.href, { waitUntil: 'networkidle' });
      await page.locator(scenario.readySelector).waitFor({ state: 'visible' });

      const themeState = await page.evaluate(() => ({
        classList: [...document.documentElement.classList],
        colorScheme: getComputedStyle(document.documentElement).colorScheme,
        theme: document.documentElement.dataset.v2Theme
      }));
      assert.equal(themeState.theme, theme, `${theme} ${width}px ${scenario.label}主题未同步`);
      assert.equal(
        themeState.classList.includes('dark'),
        theme === 'dark',
        `${theme} ${width}px ${scenario.label}的 Element Plus 主题未同步`
      );
      assert.equal(
        themeState.colorScheme,
        theme,
        `${theme} ${width}px ${scenario.label}原生主题未同步`
      );

      assertThemeSurface(
        await measureThemeNode(page.locator(scenario.surfaceSelector).first()),
        theme,
        { label: scenario.label, width }
      );
      assertThemeTextContrast(await measureThemeNode(page.locator(scenario.textSelector).first()), {
        label: `${scenario.label}标题`,
        theme,
        width
      });

      const overflow = await page.evaluate(() =>
        Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)
      );
      assert.equal(overflow, 0, `${theme} ${width}px ${scenario.label}出现横向溢出`);
      assert.deepEqual(
        runtimeErrors,
        [],
        `${theme} ${width}px ${scenario.label}浏览器错误：${runtimeErrors.join('\n')}`
      );

      if (screenshotDirectory) {
        await page.screenshot({
          fullPage: true,
          path: path.join(
            screenshotDirectory,
            `${scenario.pathname.includes('dashboard') ? 'dashboard' : 'branding'}-${theme}-${width}.png`
          )
        });
      }
    } finally {
      await context.close();
    }
  }
}

async function measureThemeNode(locator) {
  return locator.evaluate((element) => {
    const parseAlpha = (value) => {
      const match = value.match(
        /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/
      );
      if (!match) throw new Error(`无法解析 CSS 颜色：${value}`);
      return match[4] == null ? 1 : Number(match[4]);
    };
    const resolveBackground = (target) => {
      let current = target;
      while (current) {
        const color = getComputedStyle(current).backgroundColor;
        if (parseAlpha(color) >= 1) return color;
        current = current.parentElement;
      }
      return 'rgb(255, 255, 255)';
    };
    const style = getComputedStyle(element);
    return {
      background: resolveBackground(element),
      foreground: style.color
    };
  });
}

function assertThemeSurface(measurement, theme, { label, width }) {
  const luminance = relativeLuminance(parseCssColor(measurement.background));
  if (theme === 'dark') {
    assert.ok(
      luminance <= 0.08,
      `${theme} ${width}px ${label} 仍是浅色表面：${measurement.background}`
    );
    return;
  }
  assert.ok(
    luminance >= 0.72,
    `${theme} ${width}px ${label} 错误使用了深色表面：${measurement.background}`
  );
}

function assertThemeTextContrast(measurement, { label, theme, width }) {
  const ratio = contrastRatio(
    parseCssColor(measurement.foreground),
    parseCssColor(measurement.background)
  );
  assert.ok(
    ratio >= 4.5,
    `${theme} ${width}px ${label}: ${measurement.foreground} / ${measurement.background} = ${ratio.toFixed(2)}:1，低于 4.5:1`
  );
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
