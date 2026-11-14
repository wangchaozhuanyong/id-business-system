import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin, settle, toggleDesignTheme } from './helpers/offline-design.mjs';

async function observeAudio(browser, settings) {
  const context = await browser.newContext(settings);
  await interceptDesign(context, { localFixtures: {}, skipRechargeAssets: true });
  await context.addInitScript(() => {
    const NativeAudioContext = window.AudioContext;
    window.audioFeedback = { contexts: 0, tones: [] };
    window.AudioContext = class extends NativeAudioContext {
      constructor(...args) {
        super(...args);
        window.audioFeedback.contexts++;
        this.analysisNode = this.createAnalyser();
        this.analysisNode.fftSize = 8192;
        this.analysisNode.connect(this.destination);
      }
      createGain() {
        const gain = super.createGain();
        const connect = gain.connect.bind(gain);
        gain.connect = (destination, ...ports) => connect(destination === this.destination ? this.analysisNode : destination, ...ports);
        return gain;
      }
      createOscillator() {
        const oscillator = super.createOscillator();
        const start = oscillator.start.bind(oscillator);
        oscillator.start = (...args) => {
          start(...args);
          const tone = { at: performance.now(), state: this.state, peak: null };
          window.audioFeedback.tones.push(tone);
          oscillator.addEventListener('ended', () => {
            const samples = new Float32Array(this.analysisNode.fftSize);
            this.analysisNode.getFloatTimeDomainData(samples);
            tone.peak = samples.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0);
          }, { once: true });
        };
        return oscillator;
      }
    };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  await page.goto(origin + '/#/overview');
  await page.locator('#sidebar .nav-heading').first().waitFor({ state: 'attached' });
  return { context, page };
}

const countTones = page => page.evaluate(() => window.audioFeedback.tones.length);
const waitForTone = (page, count) => page.waitForFunction(count => window.audioFeedback.tones.length >= count, count);
const waitForCooldown = page => page.waitForFunction(() => {
  const last = window.audioFeedback.tones.at(-1);
  return !last || performance.now() - last.at >= 260;
});
const motion = item => item.evaluate(node => getComputedStyle(node).transform);

async function soundSettings(page) {
  const summary = page.getByLabel('界面音效设置', { exact: true });
  if (!(await summary.isVisible())) await page.locator('#mobile-tools-toggle').click();
  await summary.click();
  const panel = page.locator('#sound-settings');
  await panel.waitFor();
  return panel;
}

test('interaction sounds use real browser audio after opt-in', { timeout: 50_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());

  await t.test('desktop navigation and buttons play a single tone per hover, outcomes retain priority', async () => {
    const { page, context } = await observeAudio(browser, { viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' });
    try {
      const first = page.locator('#sidebar .nav-heading').first();
      const second = page.locator('#sidebar [data-group="账号管理"]');
      const adjacent = await second.boundingBox();
      const rest = await first.boundingBox();
      await first.hover();
      await page.waitForFunction(() => {
        const item = document.querySelector('#sidebar .nav-heading');
        return item.matches(':hover') && new DOMMatrixReadOnly(getComputedStyle(item).transform).a > 1.02;
      });
      const expanded = await first.boundingBox();
      assert(expanded.width > rest.width && expanded.width < rest.width * 1.04);
      assert.deepEqual(await second.boundingBox(), adjacent, '悬停不移动相邻导航项');
      assert.deepEqual(await page.evaluate(() => window.audioFeedback), { contexts: 0, tones: [] });

      const panel = await soundSettings(page);
      await panel.getByLabel('开启轻音效').check();
      await page.locator('#interaction-preferences[data-enabled="true"]').waitFor({ state: 'attached' });
      assert.match(await panel.locator('#sound-state').textContent(), /鼠标移入导航或按钮/);
      await page.keyboard.press('Escape');
      await panel.waitFor({ state: 'hidden' });

      await first.hover();
      await page.waitForFunction(() => window.audioFeedback.tones[0]?.peak > 0.005);
      await first.locator('.icon').first().hover();
      await first.locator('.nav-text').hover();
      await page.evaluate(() => window.IDDesignAPI.render());
      await settle(page);
      assert.equal(await countTones(page), 1, '移过同一控件的内容、原地重绘均不重复播放');
      await second.click();
      const child = page.locator('#sidebar .nav-children a').first();
      await child.waitFor();
      await waitForCooldown(page);
      const beforeChild = await countTones(page);
      await child.hover();
      await waitForTone(page, beforeChild + 1);
      await page.waitForFunction(() => {
        const item = document.querySelector('#sidebar .nav-child:hover');
        return item && getComputedStyle(item).transform !== 'none';
      });

      await waitForCooldown(page);
      const beforeButton = await countTones(page);
      await page.locator('.topbar-tools button').first().hover();
      await page.waitForFunction(index => window.audioFeedback.tones[index]?.peak > 0.005, beforeButton);
      const beforeResult = await countTones(page);
      await page.evaluate(() => {
        for (let index = 0; index < 12; index++) window.IDInteractionSound.play('success');
      });
      assert.equal(await countTones(page), beforeResult + 1, '悬停不会压过业务提示，重复结果受限流约束');
      await waitForCooldown(page);
      await page.evaluate(() => window.IDInteractionSound.play('error'));
      await waitForTone(page, beforeResult + 2);

      await toggleDesignTheme(page);
      await page.locator('#nav-toggle').click();
      await page.locator('body.is-collapsed').waitFor();
      await waitForCooldown(page);
      const beforeCollapsed = await countTones(page);
      await first.hover();
      await waitForTone(page, beforeCollapsed + 1);
      await page.waitForFunction(() => {
        const item = document.querySelector('#sidebar .nav-heading');
        return item.matches(':hover') && new DOMMatrixReadOnly(getComputedStyle(item).transform).a > 1.02;
      });

      await page.emulateMedia({ reducedMotion: 'reduce' });
      await second.hover();
      assert.equal(await motion(second), 'none', '减少动态效果时不放大导航');
      const reopened = await soundSettings(page);
      await reopened.locator('#sound-volume').press('Home');
      assert.match(await reopened.locator('#sound-state').textContent(), /音量为 0/);
      await page.keyboard.press('Escape');
      const beforeMute = await countTones(page);
      await first.hover();
      await settle(page);
      await page.evaluate(() => window.IDInteractionSound.play('success'));
      assert.equal(await countTones(page), beforeMute);

      await soundSettings(page);
      await panel.locator('#sound-volume').press('End');
      await waitForCooldown(page);
      await panel.getByLabel('开启轻音效').uncheck();
      await page.keyboard.press('Escape');
      const beforeOff = await countTones(page);
      await page.evaluate(() => window.IDInteractionSound.play('error'));
      assert.equal(await countTones(page), beforeOff);
      await page.reload();
      assert.equal(await page.locator('#interaction-preferences').getAttribute('data-enabled'), 'false');
      assert.equal(await countTones(page), 0);
    } finally { await context.close(); }
  });

  await t.test('touch navigation stays silent without hover enlargement', async () => {
    const { page, context } = await observeAudio(browser, {
      viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'no-preference'
    });
    try {
      const panel = await soundSettings(page);
      await panel.getByLabel('开启轻音效').tap();
      await page.locator('#interaction-preferences[data-enabled="true"]').waitFor({ state: 'attached' });
      await page.keyboard.press('Escape');
      const tools = page.locator('#mobile-tools-panel');
      if (await tools.evaluate(node => node.matches(':popover-open'))) await page.locator('#mobile-tools-toggle').tap();
      await page.locator('#nav-toggle').tap();
      const group = page.locator('#sidebar [data-group="账号管理"]');
      await group.tap();
      await page.locator('#sidebar .nav-child').first().waitFor();
      assert.equal(await countTones(page), 0);
      assert.equal(await motion(group), 'none');
      assert(await group.evaluate(node => node.getBoundingClientRect().height >= 44));
    } finally { await context.close(); }
  });
});
