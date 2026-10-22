'use strict';
// Preserve business fields while masking payment/authentication credentials in every frame.
const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const CAPTURE_TIMEOUT_MS = 8000;
const FINISH_CAPTURE_TIMEOUT_MS = 10000;
const capturingPages = new WeakSet();
let recorder = null;
function root() {
  return require('./paths.cjs').mediaRoot();
}
// Only files with a completion receipt may be recovered after a child exits.
// The receipt is written after the mandatory masked capture/encoding completes.
async function recordCompletedFile(file, buffer) {
  try {
    const { createHash } = require('node:crypto');
    await fs.writeFile(
      `${file}.ready.json`,
      JSON.stringify({
        version: 1,
        name: path.basename(file),
        redacted: true,
        bytes: buffer.length,
        sha256: createHash('sha256').update(buffer).digest('hex')
      }),
      { mode: 0o600 }
    );
  } catch {
    /* Normal evidence delivery still works if an optional receipt fails. */
  }
}
async function start() {
  await fs.mkdir(root(), { recursive: true, mode: 0o700 });
  recorder = {
    page: null,
    frames: [],
    chain: Promise.resolve(),
    timer: null,
    stopped: false,
    busy: false
  };
}
function attach(page) {
  if (!recorder) return;
  recorder.page = page;
  recorder.timer = setInterval(() => {
    screenshot(page, 'frame').catch(() => {});
  }, 2500);
  recorder.timer.unref();
}
async function stage() {}
async function screenshot(page, prefix = 'stage') {
  if (
    !recorder ||
    !page ||
    recorder.stopped ||
    recorder.busy ||
    capturingPages.has(page) ||
    recorder.frames.length >= 600
  )
    return null;
  const current = recorder;
  current.busy = true;
  capturingPages.add(page);
  const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
  let expired = false;
  const stopped = () => current.stopped || expired || Date.now() >= deadline;
  const capture = async () => {
    let frames = [],
      result;
    try {
      if (stopped()) return null;
      const fontsReady = await page.evaluate(async () => {
        if (!document.fonts?.ready) return false;
        let timer;
        try {
          return await Promise.race([
            document.fonts.ready.then(() => true),
            new Promise((resolve) => {
              timer = setTimeout(() => resolve(false), 0);
            })
          ]);
        } finally {
          clearTimeout(timer);
        }
      });
      if (fontsReady !== true || stopped()) return null;
      frames = typeof page.frames === 'function' ? page.frames() : [page];
      const file = path.join(
        root(),
        `${String(prefix)
          .replace(/[^a-zA-Z0-9_-]/g, '')
          .slice(0, 40)}_${Date.now()}_${current.frames.length}.png`
      );
      // A failed frame inspection aborts this capture; credentials never enter page scripts.
      for (const frame of frames) {
        if (stopped()) return null;
        await frame.evaluate(() => {
          const credential =
            /(?:password|passwd|access.?token|refresh.?token|session.?token|(?:^|[\s_-])(?:token|session|pan)(?:$|[\s_-])|cookie|authorization|api.?key|secret|cvc|cvv|cc-csc|cc-number|one-time-code|security.?code|card.?number|密码|安全码|卡号|令牌)/i;
          const secretValue =
            /\b(?:\d[ -]?){13,19}\b|eyJ[A-Za-z0-9_-]+\.|\b(?:sk|pk)_(?:live|test)_/;
          const roots = [document];
          for (const tree of roots) {
            for (const el of tree.querySelectorAll(tree === document ? 'body *' : '*')) {
              if (el.shadowRoot) roots.push(el.shadowRoot);
              const input = el.matches('input,textarea,[contenteditable]');
              const labelRoot = el.getRootNode();
              const labelledBy = (el.getAttribute('aria-labelledby') || '')
                .split(/\s+/)
                .filter(Boolean)
                .map((id) => labelRoot.getElementById?.(id)?.textContent || '');
              const description = [
                ...[
                  'id',
                  'name',
                  'type',
                  'autocomplete',
                  'aria-label',
                  'placeholder',
                  'data-testid'
                ].map((key) => el.getAttribute(key) || ''),
                ...Array.from(el.labels || []).map((label) => label.textContent || ''),
                ...labelledBy
              ].join(' ');
              const text = input
                ? el.value || el.textContent || ''
                : el.children.length === 0
                  ? el.textContent || ''
                  : '';
              if (
                credential.test(description) ||
                secretValue.test(text) ||
                (!input && credential.test(text) && /[:：=]/.test(text))
              )
                el.setAttribute('data-online-recharge-secret-mask', '1');
            }
          }
        });
      }
      if (stopped()) return null;
      const buffer = await page.screenshot({
        fullPage: false,
        // Fast-forwarding or cancelling animations can fire checkout callbacks.
        // Recording must observe the live page without changing its lifecycle.
        animations: 'allow',
        timeout: Math.max(1, deadline - Date.now()),
        mask: frames.map((frame) =>
          frame.locator(
            'input[type="password"],input[autocomplete="cc-number"],input[autocomplete="cc-csc"],canvas,video,[data-sensitive],[data-online-recharge-secret-mask]'
          )
        ),
        maskColor: '#142238'
      });
      if (expired || Date.now() >= deadline) return null;
      await fs.writeFile(file, buffer, { mode: 0o600 });
      await recordCompletedFile(file, buffer);
      current.frames.push(file);
      result = file;
    } catch {
      result = null;
    } finally {
      // Keep the actual capture busy until every mask cleanup has settled, even
      // after the optional caller deadline. A later capture must not overlap it.
      const cleanup = await Promise.allSettled(
        frames.map((frame) =>
          Promise.resolve().then(() =>
            frame.evaluate(() => {
              const roots = [document];
              for (const tree of roots) {
                for (const el of tree.querySelectorAll('*')) {
                  if (el.shadowRoot) roots.push(el.shadowRoot);
                  el.removeAttribute('data-online-recharge-secret-mask');
                }
              }
            })
          )
        )
      );
      if (cleanup.some((item) => item.status === 'rejected')) result = null;
    }
    return result;
  };
  current.chain = Promise.resolve()
    .then(capture)
    .catch(() => null)
    .finally(() => {
      current.busy = false;
      capturingPages.delete(page);
    });
  let timer;
  try {
    return await Promise.race([
      current.chain,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          expired = true;
          resolve(null);
        }, CAPTURE_TIMEOUT_MS);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function finish() {
  if (!recorder) return [];
  const current = recorder;
  recorder = null;
  current.stopped = true;
  clearInterval(current.timer);
  let captureTimer;
  const settled = await Promise.race([
    current.chain.then(
      () => true,
      () => true
    ),
    new Promise((resolve) => {
      captureTimer = setTimeout(() => resolve(false), FINISH_CAPTURE_TIMEOUT_MS);
    })
  ]);
  clearTimeout(captureTimer);
  // Late captures may finish while the caller closes the context. Only hand off
  // completed masked files, and never wait for encoding after capture timeout.
  const frames = [...current.frames];
  if (!settled || !frames.length) return frames;
  const listing = path.join(root(), `frames_${Date.now()}.txt`);
  const output = path.join(root(), `redacted_${Date.now()}.webm`);
  await fs.writeFile(
    listing,
    frames.map((f) => `file '${f.replace(/'/g, "'\\''")}'\nduration 2.5`).join('\n'),
    { mode: 0o600 }
  );
  const encoded = await new Promise((resolve) => {
    const child = spawn(
      process.env.ONLINE_RECHARGE_FFMPEG_PATH || 'ffmpeg',
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listing,
        '-c:v',
        'libvpx-vp9',
        '-pix_fmt',
        'yuv420p',
        '-y',
        output
      ],
      { stdio: 'ignore' }
    );
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(false);
    }, 60000);
    child.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
  await fs.unlink(listing).catch(() => {});
  if (encoded) {
    try {
      await recordCompletedFile(output, await fs.readFile(output));
    } catch {
      /* Keep completed PNG evidence. */
    }
  }
  return encoded ? [...frames, output] : frames;
}
module.exports = { start, attach, stage, screenshot, finish, root };
