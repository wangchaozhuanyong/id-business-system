'use strict';
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

function fixture({ onEvaluate = async () => {}, onWrite = async () => {} } = {}) {
  const effects = {
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
    evaluate: async (callback) => onEvaluate(++effects.evaluations, callback),
    locator: (selector) => ({ selector }),
    screenshot: async (options) => {
      effects.screenshots.push(options);
      return Buffer.from('synthetic masked image');
    }
  };
  const timeoutCapture = () => {
    const timer = effects.timers.find((item) => item.milliseconds === 10000 && !item.cleared);
    assert.ok(timer, 'capture drain must have a finite 10 second deadline');
    timer.callback();
  };
  return { media: module.exports, page, effects, timeoutCapture };
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
  const options = f.effects.screenshots[0];
  assert.equal(options.timeout, 8000);
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
  assert.equal(f.effects.removed.length, 1);
  assert.equal(f.effects.removed[0], listing.file);
  assert.doesNotMatch(source, /recordVideo/);
});
