'use strict';
/* global document */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { runInNewContext } = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../safe-media.cjs'), 'utf8');
const output = path.join(__dirname, '..', 'runtime', 'verification', 'safe-media-finish');
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

function fixture({
  onFontsReady = async () => true,
  onEvaluate = async () => {},
  onWrite = async () => {},
  onScreenshot = async () => Buffer.from('synthetic masked image')
} = {}) {
  const effects = {
    fontProbes: 0,
    evaluations: 0,
    screenshots: [],
    writes: [],
    removed: [],
    encodes: [],
    intervals: [],
    timers: []
  };
  const module = { exports: {} };
  runInNewContext(source, {
    module,
    require(name) {
      if (name === 'node:path') return path;
      if (name === './paths.cjs') return { mediaRoot: () => output };
      if (name === 'node:fs/promises')
        return {
          mkdir: async () => {},
          writeFile: async (file, data, options) => {
            effects.writes.push({ file, data, options });
            await onWrite(file);
          },
          unlink: async (file) => {
            effects.removed.push(file);
          }
        };
      if (name === 'node:child_process')
        return {
          spawn(command, args, options) {
            effects.encodes.push({ command, args, options });
            const child = new EventEmitter();
            child.kill = () => {};
            queueMicrotask(() => child.emit('close', 0));
            return child;
          }
        };
      throw new Error(`Unexpected module: ${name}`);
    },
    process: { env: {} },
    setInterval(callback, milliseconds) {
      const timer = { callback, milliseconds, cleared: false, unref() {} };
      effects.intervals.push(timer);
      return timer;
    },
    clearInterval(timer) {
      if (timer) timer.cleared = true;
    },
    setTimeout(callback, milliseconds) {
      const timer = { callback, milliseconds, cleared: false };
      effects.timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    }
  });
  const page = {
    evaluate: async (callback) => {
      if (String(callback).includes('document.fonts'))
        return onFontsReady(callback, ++effects.fontProbes);
      return onEvaluate(++effects.evaluations, callback);
    },
    locator: (selector) => ({ selector }),
    screenshot: async (options) => {
      effects.screenshots.push(options);
      return onScreenshot(options);
    }
  };
  const timeoutCapture = () => {
    const timer = effects.timers.find((item) => item.milliseconds === 10000 && !item.cleared);
    assert.ok(timer, 'capture drain must have a finite 10 second deadline');
    timer.callback();
  };
  const timeoutOptionalCapture = () => {
    const timer = effects.timers.find((item) => item.milliseconds === 8000 && !item.cleared);
    assert.ok(timer, 'optional capture must have one shared 8 second deadline');
    timer.callback();
  };
  return { media: module.exports, page, effects, timeoutCapture, timeoutOptionalCapture };
}

test('finish returns completed frames by deadline and prevents queued or late pre-mask captures', async () => {
  const entered = deferred();
  const release = deferred();
  const f = fixture({
    onEvaluate: async (count) => {
      if (count === 3) {
        entered.resolve();
        await release.promise;
      }
    }
  });
  await f.media.start();
  f.media.attach(f.page);
  const first = await f.media.screenshot(f.page, 'complete');
  const pending = f.media.screenshot(f.page, 'blocked');
  await entered.promise;
  const queued = f.media.screenshot(f.page, 'queued');
  const finishing = f.media.finish();
  f.timeoutCapture();
  const files = await finishing;
  assert.deepEqual([...files], [first]);
  assert.equal(f.effects.intervals[0].cleared, true);
  assert.equal(f.effects.encodes.length, 0);
  assert.equal(f.effects.removed.length, 0);
  release.resolve();
  assert.equal(await pending, null);
  assert.equal(await queued, null);
  assert.equal(await f.media.screenshot(f.page, 'after-finish'), null);
  assert.equal(f.effects.screenshots.length, 1);
  assert.equal(f.effects.fontProbes, 2);
});

test('finish retains a completed masked frame when removal of page masks hangs', async () => {
  const entered = deferred();
  const release = deferred();
  const f = fixture({
    onEvaluate: async (count) => {
      if (count === 2) {
        entered.resolve();
        await release.promise;
      }
    }
  });
  await f.media.start();
  const pending = f.media.screenshot(f.page, 'masked');
  await entered.promise;
  const queued = f.media.screenshot(f.page, 'queued');
  const finishing = f.media.finish();
  f.timeoutCapture();
  const files = await finishing;
  assert.equal(files.length, 1);
  assert.equal(files[0], f.effects.writes[0].file);
  assert.equal(f.effects.encodes.length, 0);
  assert.equal(f.effects.removed.length, 0);
  release.resolve();
  assert.equal(await pending, files[0]);
  assert.equal(await queued, null);
  assert.equal(f.effects.screenshots.length, 1);
});

test('a timed-out handoff is a snapshot even if an in-flight masked write later completes', async () => {
  const entered = deferred();
  const release = deferred();
  const f = fixture({
    onWrite: async (file) => {
      if (file.endsWith('.png')) {
        entered.resolve();
        await release.promise;
      }
    }
  });
  await f.media.start();
  const pending = f.media.screenshot(f.page, 'late');
  await entered.promise;
  const finishing = f.media.finish();
  f.timeoutCapture();
  const files = await finishing;
  assert.deepEqual([...files], []);
  release.resolve();
  assert.ok((await pending).endsWith('.png'));
  assert.deepEqual([...files], []);
  assert.equal(f.effects.encodes.length, 0);
  assert.equal(f.effects.removed.length, 0);
});

test('normal finish preserves mandatory screenshot masks and encodes only completed masked frames', async () => {
  const f = fixture();
  await f.media.start();
  const frame = await f.media.screenshot(f.page, 'normal');
  const files = await f.media.finish();
  assert.equal(f.effects.screenshots.length, 1);
  assert.equal(f.effects.fontProbes, 1);
  const options = f.effects.screenshots[0];
  assert.ok(options.timeout > 0 && options.timeout <= 8000);
  assert.equal(options.maskColor, '#142238');
  assert.equal(options.mask.length, 1);
  assert.match(options.mask[0].selector, /cc-number/);
  assert.match(options.mask[0].selector, /cc-csc/);
  assert.doesNotMatch(options.mask[0].selector, /input,textarea|iframe/);
  assert.equal(f.effects.encodes.length, 1);
  const listing = f.effects.writes.find((item) => item.file.endsWith('.txt'));
  assert.ok(listing.data.includes(frame));
  assert.equal(listing.options.mode, 0o600);
  assert.equal(f.effects.writes.find((item) => item.file === frame).options.mode, 0o600);
  assert.equal(f.effects.encodes[0].command, 'ffmpeg');
  assert.ok(f.effects.encodes[0].args.includes('libvpx-vp9'));
  assert.equal(files[0], frame);
  assert.match(files[1], /redacted_\d+\.webm$/);
  assert.ok(f.effects.timers.find((item) => item.milliseconds === 10000).cleared);
  assert.ok(f.effects.timers.find((item) => item.milliseconds === 8000).cleared);
  assert.equal(f.effects.removed.length, 1);
  assert.equal(f.effects.removed[0], listing.file);
  assert.doesNotMatch(source, /recordVideo/);
});

for (const phase of [
  'font-probe',
  'frames',
  'pre-mask',
  'locator',
  'screenshot',
  'write',
  'cleanup'
]) {
  test(`${phase} failure skips optional capture without propagating or taking an unmasked fallback`, async () => {
    const fail = () => {
      throw new Error('Synthetic optional capture failure');
    };
    const f = fixture({
      onFontsReady: async () => {
        if (phase === 'font-probe') fail();
        return true;
      },
      onEvaluate: async (count) => {
        if ((phase === 'pre-mask' && count === 1) || (phase === 'cleanup' && count === 2)) fail();
      },
      onScreenshot: async () => {
        if (phase === 'screenshot') fail();
        return Buffer.from('synthetic masked image');
      },
      onWrite: async (file) => {
        if (phase === 'write' && file.endsWith('.png')) fail();
      }
    });
    if (phase === 'frames') f.page.frames = fail;
    if (phase === 'locator') f.page.locator = fail;
    await f.media.start();
    assert.equal(await f.media.screenshot(f.page, 'optional-failure'), null);
    assert.equal(
      f.effects.screenshots.length,
      ['font-probe', 'frames', 'pre-mask', 'locator'].includes(phase) ? 0 : 1
    );
    const files = await f.media.finish();
    if (phase === 'cleanup') {
      assert.equal(files[0], f.effects.writes[0].file);
      assert.equal(files.length, 2);
    } else assert.deepEqual([...files], []);
  });
}

for (const phase of ['font-probe', 'pre-mask', 'screenshot', 'write', 'cleanup']) {
  test(`${phase} hang returns null by the capture deadline while interval and explicit captures never queue`, async () => {
    const entered = deferred();
    const release = deferred();
    let blocked = false;
    const hold = async () => {
      if (blocked) return;
      blocked = true;
      entered.resolve();
      await release.promise;
    };
    const f = fixture({
      onFontsReady: async () => {
        if (phase === 'font-probe') await hold();
        return true;
      },
      onEvaluate: async (count) => {
        if ((phase === 'pre-mask' && count === 1) || (phase === 'cleanup' && count === 2))
          await hold();
      },
      onScreenshot: async () => {
        if (phase === 'screenshot') await hold();
        return Buffer.from('synthetic masked image');
      },
      onWrite: async (file) => {
        if (phase === 'write' && file.endsWith('.png')) await hold();
      }
    });
    await f.media.start();
    f.media.attach(f.page);
    const pending = f.media.screenshot(f.page, 'hung');
    await entered.promise;
    f.timeoutOptionalCapture();
    assert.equal(await pending, null);
    const snapshot = {
      fontProbes: f.effects.fontProbes,
      evaluations: f.effects.evaluations,
      screenshots: f.effects.screenshots.length,
      writes: f.effects.writes.length
    };
    for (let index = 0; index < 20; index++) {
      assert.equal(await f.media.screenshot(f.page, 'skip-busy'), null);
      f.effects.intervals[0].callback();
    }
    assert.deepEqual(
      {
        fontProbes: f.effects.fontProbes,
        evaluations: f.effects.evaluations,
        screenshots: f.effects.screenshots.length,
        writes: f.effects.writes.length
      },
      snapshot
    );
    assert.equal(f.effects.timers.filter((item) => item.milliseconds === 8000).length, 1);
    release.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    const afterSettle = f.effects.screenshots.length;
    const fresh = await f.media.screenshot(f.page, 'fresh-after-settle');
    assert.ok(fresh?.endsWith('.png'));
    assert.equal(f.effects.screenshots.length, afterSettle + 1);
    assert.equal(f.effects.timers.filter((item) => item.milliseconds === 8000).length, 2);
    await f.media.finish();
  });
}

test('a failed cleanup waits for the other real cleanup and keeps the same page locked across finish/start', async () => {
  const entered = deferred();
  const release = deferred();
  let secondReads = 0;
  const f = fixture({
    onEvaluate: async (count) => {
      if (count === 2) throw new Error('Synthetic first-frame cleanup failed');
    }
  });
  const second = {
    locator: f.page.locator,
    evaluate: async () => {
      if (++secondReads === 2) {
        entered.resolve();
        await release.promise;
      }
    }
  };
  f.page.frames = () => [f.page, second];
  await f.media.start();
  const pending = f.media.screenshot(f.page, 'cleanup-in-flight');
  await entered.promise;
  f.timeoutOptionalCapture();
  assert.equal(await pending, null);
  assert.equal(await f.media.screenshot(f.page, 'must-not-overlap'), null);
  const finishing = f.media.finish();
  f.timeoutCapture();
  const files = await finishing;
  assert.deepEqual([...files], [f.effects.writes[0].file]);
  await f.media.start();
  assert.equal(await f.media.screenshot(f.page, 'same-page-still-locked'), null);
  assert.equal(f.effects.screenshots.length, 1);
  release.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok((await f.media.screenshot(f.page, 'released-page')).endsWith('.png'));
  assert.deepEqual([...files], [f.effects.writes[0].file]);
  await f.media.finish();
});

for (const ready of [false, true]) {
  test(`the real font probe skips pending fonts and permits interactive ready fonts: ready=${ready}`, async () => {
    const f = fixture({
      onFontsReady: (callback) =>
        runInNewContext(`(${String(callback)})()`, {
          document: {
            readyState: 'interactive',
            fonts: { ready: ready ? Promise.resolve() : new Promise(() => {}) }
          },
          setTimeout,
          clearTimeout
        })
    });
    await f.media.start();
    const image = await f.media.screenshot(f.page, 'font-boundary');
    assert.equal(image !== null, ready);
    assert.equal(f.effects.fontProbes, 1);
    assert.equal(f.effects.evaluations, ready ? 2 : 0);
    assert.equal(f.effects.screenshots.length, ready ? 1 : 0);
    await f.media.finish();
  });
}

test('real Chromium with pending module and fonts skips native screenshot before masking visible controls', async () => {
  const { chromium } = require('../upstream/node_modules/playwright');
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-background-networking',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'
    ]
  });
  const released = deferred(),
    moduleRequested = deferred(),
    fontRequested = deferred();
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== 'https://safe-media-fixture.invalid') return route.abort();
      if (url.pathname === '/checkout')
        return route.fulfill({
          contentType: 'text/html',
          body: `<style>
            @font-face{font-family:PendingCapture;src:url('/pending.woff2')}
            input{font:20px PendingCapture,sans-serif;width:300px;height:40px}
          </style><input autocomplete="cc-number" value="4242424242424242">
          <script type="module" src="/pending.js"></script>`
        });
      if (url.pathname === '/pending.js' || url.pathname === '/pending.woff2') {
        (url.pathname.endsWith('.js') ? moduleRequested : fontRequested).resolve();
        await released.promise;
      }
      return route.abort().catch(() => {});
    });
    const page = await context.newPage();
    await page.goto('https://safe-media-fixture.invalid/checkout', { waitUntil: 'commit' });
    await page.locator('input[autocomplete="cc-number"]').waitFor({ state: 'visible' });
    await Promise.all([moduleRequested.promise, fontRequested.promise]);
    const state = await page.evaluate(() => ({
      readyState: document.readyState,
      fonts: document.fonts.status
    }));
    assert.ok(['loading', 'interactive'].includes(state.readyState));
    assert.equal(state.fonts, 'loading');
    let nativeScreenshotCalls = 0;
    const nativeScreenshot = page.screenshot.bind(page);
    page.screenshot = (...args) => {
      nativeScreenshotCalls++;
      return nativeScreenshot(...args);
    };
    const f = fixture();
    await f.media.start();
    const started = Date.now();
    assert.equal(await f.media.screenshot(page, 'fonts-not-ready'), null);
    assert.ok(Date.now() - started < 4000);
    assert.equal(nativeScreenshotCalls, 0);
    assert.equal(await page.locator('[data-online-recharge-secret-mask]').count(), 0);
    assert.equal(f.effects.writes.length, 0);
    assert.deepEqual([...(await f.media.finish())], []);
  } finally {
    released.resolve();
    await browser.close();
  }
});
