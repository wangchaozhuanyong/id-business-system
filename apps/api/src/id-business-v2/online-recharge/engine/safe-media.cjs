'use strict';
// Capture the actual page with mandatory masks; raw video is never enabled.
const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
let recorder = null;
function root() {
  return require('./paths.cjs').mediaRoot();
}
async function start() {
  await fs.mkdir(root(), { recursive: true, mode: 0o700 });
  recorder = { page: null, frames: [], chain: Promise.resolve(), timer: null };
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
  if (!recorder || !page || recorder.frames.length >= 600) return null;
  const current = recorder;
  const capture = async () => {
    // Only generic patterns enter the page; internal keys are never injected into an untrusted document.
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('body *')) {
        const text = el.children.length === 0 ? el.textContent || '' : '';
        if (
          text.length > 72 ||
          /(?:\d[ -]?){12,19}|\b\d{3,4}\b|[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]+\.|(?:access.?token|refresh.?token|session.?token|password|cookie|cvc|cvv)\s*[:=]|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(
            text
          )
        )
          el.setAttribute('data-online-recharge-secret-mask', '1');
      }
    });
    const file = path.join(
      root(),
      `${String(prefix)
        .replace(/[^a-zA-Z0-9_-]/g, '')
        .slice(0, 40)}_${Date.now()}_${current.frames.length}.png`
    );
    try {
      const buffer = await page.screenshot({
        fullPage: false,
        animations: 'disabled',
        timeout: 8000,
        mask: [
          page.locator(
            'input,textarea,[contenteditable],iframe,pre,code,canvas,video,img,[data-sensitive],[data-online-recharge-secret-mask]'
          )
        ],
        maskColor: '#142238'
      });
      await fs.writeFile(file, buffer, { mode: 0o600 });
      current.frames.push(file);
      return file;
    } finally {
      await page
        .evaluate(() => {
          document
            .querySelectorAll('[data-online-recharge-secret-mask]')
            .forEach((el) => el.removeAttribute('data-online-recharge-secret-mask'));
        })
        .catch(() => {});
    }
  };
  current.chain = current.chain.catch(() => {}).then(capture);
  return current.chain;
}
async function finish() {
  if (!recorder) return [];
  const current = recorder;
  recorder = null;
  clearInterval(current.timer);
  await current.chain.catch(() => {});
  if (!current.frames.length) return [];
  const listing = path.join(root(), `frames_${Date.now()}.txt`);
  const output = path.join(root(), `redacted_${Date.now()}.webm`);
  await fs.writeFile(
    listing,
    current.frames.map((f) => `file '${f.replace(/'/g, "'\\''")}'\nduration 2.5`).join('\n'),
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
  return encoded ? [...current.frames, output] : current.frames;
}
module.exports = { start, attach, stage, screenshot, finish, root };
