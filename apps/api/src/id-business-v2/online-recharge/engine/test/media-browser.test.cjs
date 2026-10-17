'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const zlib = require('node:zlib');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { chromium } = require('../upstream/node_modules/playwright');
const media = require('../safe-media.cjs');
function readPixels(png) {
  let at = 8,
    width,
    height,
    channels;
  const chunks = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at),
      type = png.toString('ascii', at + 4, at + 8),
      data = png.subarray(at + 8, at + 8 + length);
    at += 12 + length;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8);
      channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      assert.ok(channels);
    }
    if (type === 'IDAT') chunks.push(data);
  }
  const raw = zlib.inflateSync(Buffer.concat(chunks)),
    stride = width * channels,
    decoded = Buffer.alloc(height * stride);
  let cursor = 0;
  const paeth = (a, b, c) => {
    const p = a + b - c,
      pa = Math.abs(p - a),
      pb = Math.abs(p - b),
      pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[cursor++];
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? decoded[y * stride + x - channels] : 0,
        up = y ? decoded[(y - 1) * stride + x] : 0,
        corner = y && x >= channels ? decoded[(y - 1) * stride + x - channels] : 0;
      const predictors = [0, left, up, Math.floor((left + up) / 2), paeth(left, up, corner)];
      assert.ok(filter < 5);
      decoded[y * stride + x] = (raw[cursor++] + predictors[filter]) & 255;
    }
  }
  return (x, y) => [
    ...decoded.subarray(
      Math.floor(y) * stride + Math.floor(x) * channels,
      Math.floor(y) * stride + Math.floor(x) * channels + 3
    )
  ];
}
test('isolated Chromium preserves business fields while masking credentials across frames and video', async () => {
  const output = path.join(__dirname, '..', 'runtime', 'verification', 'masked-media');
  await fs.mkdir(output, { recursive: true });
  const originalEnvironment = {
    ONLINE_RECHARGE_MEDIA_DIR: process.env.ONLINE_RECHARGE_MEDIA_DIR,
    ONLINE_RECHARGE_FFMPEG_PATH: process.env.ONLINE_RECHARGE_FFMPEG_PATH
  };
  process.env.ONLINE_RECHARGE_MEDIA_DIR = output;
  process.env.ONLINE_RECHARGE_FFMPEG_PATH = process.env.ONLINE_RECHARGE_FFMPEG_PATH || 'ffmpeg';
  let browser,
    blocked = 0;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-background-networking',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'
      ]
    });
    const context = await browser.newContext({ viewport: { width: 1000, height: 1200 } });
    await context.route('**/*', (route) => {
      blocked++;
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    await page.setContent(`<style>body{font:18px sans-serif;background:white}.secret{display:block;width:600px;height:42px;margin:14px;box-sizing:border-box}input,textarea,iframe{border:1px solid #ccc}</style>
      <div id="normal" class="secret">合成隔离页面：所有内容仅为测试资料</div>
      <input id="card" autocomplete="cc-number" class="secret" value="4242424242424242">
      <textarea id="session" class="secret">synthetic_session_token_for_mask_test_only</textarea>
      <input id="cvc" class="secret" value="123">
      <div id="pan" class="secret">4242 4242 4242 4242</div>
      <div id="cvcText" class="secret">安全码：123</div>
      <div id="email" class="secret">synthetic@example.invalid</div>
      <div id="token" class="secret">access_token=synthetic_opaque_token_abcdefghijklmnop</div>
      <input id="holder" class="secret" value="Synthetic Customer">
      <textarea id="address" class="secret">123 Main Street, Manila 1000</textarea>
      <div id="error" class="secret">账单地址填写超时，请核对街道和城市。这里保留超过七十二个字符的完整业务说明，便于管理员识别真实错误，而不是把整个段落遮住。详细错误仍应能完整阅读，金额 PHP 9990.00。</div>
      <iframe id="frame" class="secret" style="height:110px" srcdoc="&lt;input id='nestedCvc' autocomplete='cc-csc' value='123'&gt;&lt;input id='nestedCity' value='Manila'&gt;"></iframe>`);
    await page.frameLocator('#frame').locator('#nestedCvc').waitFor();
    assert.equal(page.video(), null);
    const boxes = {};
    for (const id of [
      'card',
      'session',
      'cvc',
      'pan',
      'cvcText',
      'email',
      'token',
      'frame',
      'holder',
      'address',
      'error',
      'normal'
    ])
      boxes[id] = await page.locator(`#${id}`).boundingBox();
    await media.start();
    const first = await media.screenshot(page, 'masked-real-page');
    const pixels = readPixels(await fs.readFile(first));
    const masked = ['card', 'session', 'cvc', 'pan', 'cvcText', 'token'];
    const visible = ['email', 'holder', 'address', 'error', 'normal'];
    for (const id of masked) {
      const box = boxes[id];
      assert.deepEqual(
        pixels(box.x + box.width / 2, box.y + box.height / 2),
        [20, 34, 56],
        `${id} must be fully masked`
      );
    }
    for (const id of visible) {
      const box = boxes[id];
      assert.notDeepEqual(
        pixels(box.x + box.width / 2, box.y + box.height / 2),
        [20, 34, 56],
        `${id} business information must remain visible`
      );
    }
    for (const [id, hidden] of [
      ['nestedCvc', true],
      ['nestedCity', false]
    ]) {
      const box = await page.frameLocator('#frame').locator(`#${id}`).boundingBox();
      const sample = pixels(box.x + box.width / 2, box.y + box.height / 2);
      if (hidden) assert.deepEqual(sample, [20, 34, 56]);
      else assert.notDeepEqual(sample, [20, 34, 56]);
    }
    await page.locator('#cvc').fill('456');
    await media.screenshot(page, 'masked-real-page-next');
    const files = await media.finish();
    const video = files.find((f) => f.endsWith('.webm'));
    assert.ok(video, 'masked frames must encode a real WebM');
    const { stdout } = await promisify(execFile)(
      process.env.ONLINE_RECHARGE_FFPROBE_PATH || 'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_name,width,height',
        '-show_entries',
        'format=duration',
        '-of',
        'json',
        video
      ]
    );
    const info = JSON.parse(stdout);
    assert.equal(info.streams[0].codec_name, 'vp9');
    assert.equal(info.streams[0].width, 1000);
    assert.ok(Number(info.format.duration) > 0);
    await fs.writeFile(
      path.join(output, 'verification.json'),
      JSON.stringify(
        {
          maskedFields: [...masked, 'nestedCvc'],
          visibleFields: [...visible, 'nestedCity'],
          video: path.basename(video),
          screenshot: path.basename(first),
          codec: info.streams[0].codec_name,
          rawVideo: false,
          externalRequests: 0,
          duration: info.format.duration
        },
        null,
        2
      )
    );
    assert.equal(blocked, 0);
    await context.close();
  } finally {
    try {
      await browser?.close();
    } finally {
      for (const [key, value] of Object.entries(originalEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
});

test('isolated Chromium masks credentials labelled inside nested open shadow roots', async () => {
  const output = path.join(__dirname, '..', 'runtime', 'verification', 'masked-shadow-media');
  await fs.mkdir(output, { recursive: true });
  const originalMediaDir = process.env.ONLINE_RECHARGE_MEDIA_DIR;
  process.env.ONLINE_RECHARGE_MEDIA_DIR = output;
  let browser,
    externalRequests = 0;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-background-networking',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'
      ]
    });
    const context = await browser.newContext({ viewport: { width: 400, height: 500 } });
    await context.route('**/*', (route) => {
      externalRequests++;
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    await page.setContent(`<span hidden id="label-a">Billing name</span>
      <span hidden id="label-b">City</span><span hidden id="label-c">Card number</span>
      <div id="billing-widget"></div>`);
    await page.evaluate(() => {
      const outer = document.getElementById('billing-widget').attachShadow({ mode: 'open' });
      outer.innerHTML = '<div id="field-group"></div>';
      const fields = outer.getElementById('field-group').attachShadow({ mode: 'open' });
      fields.innerHTML = `<style>
          input,textarea{display:block;width:300px;height:36px;margin:12px;background:white;color:black}
        </style>
        <span hidden id="label-a">Card number</span><input id="field-a" aria-labelledby="label-a">
        <span hidden id="label-b">Security code</span><input id="field-b" aria-labelledby="label-b">
        <span hidden id="label-c">Billing name</span><input id="field-c" aria-labelledby="label-c" value="Synthetic Customer">
        <span hidden id="label-d">Email</span><input id="field-d" aria-labelledby="label-d" value="synthetic@example.invalid">
        <span hidden id="label-e">Street address</span><textarea id="field-e" aria-labelledby="label-e">123 Main Street</textarea>`;
    });
    await media.start();
    for (const phase of ['empty', 'filled']) {
      if (phase === 'filled') {
        await page.locator('#field-a').fill('4242424242424242');
        await page.locator('#field-b').fill('123');
      }
      const screenshot = await media.screenshot(page, `shadow-${phase}`);
      assert.ok(screenshot, 'shadow credentials require a real masked screenshot');
      const pixels = readPixels(await fs.readFile(screenshot));
      for (const [id, hidden] of [
        ['field-a', true],
        ['field-b', true],
        ['field-c', false],
        ['field-d', false],
        ['field-e', false]
      ]) {
        const box = await page.locator(`#${id}`).boundingBox();
        const sample = pixels(box.x + box.width / 2, box.y + box.height / 2);
        if (hidden) assert.deepEqual(sample, [20, 34, 56], `${id} must be masked when ${phase}`);
        else assert.notDeepEqual(sample, [20, 34, 56], `${id} must retain business visibility`);
      }
      assert.equal(await page.locator('[data-online-recharge-secret-mask]').count(), 0);
    }
    await media.finish();
    assert.equal(await page.locator('[data-online-recharge-secret-mask]').count(), 0);
    assert.equal(externalRequests, 0);
    await context.close();
  } finally {
    try {
      await media.finish();
      await browser?.close();
    } finally {
      if (originalMediaDir === undefined) delete process.env.ONLINE_RECHARGE_MEDIA_DIR;
      else process.env.ONLINE_RECHARGE_MEDIA_DIR = originalMediaDir;
    }
  }
});

test('masked recording preserves checkout animation lifecycle and payment frames', async (t) => {
  const output = path.join(__dirname, '..', 'runtime', 'verification', 'media-animations');
  await fs.mkdir(output, { recursive: true });
  const originalEnvironment = {
    ONLINE_RECHARGE_MEDIA_DIR: process.env.ONLINE_RECHARGE_MEDIA_DIR,
    ONLINE_RECHARGE_FFMPEG_PATH: process.env.ONLINE_RECHARGE_FFMPEG_PATH
  };
  process.env.ONLINE_RECHARGE_MEDIA_DIR = output;
  process.env.ONLINE_RECHARGE_FFMPEG_PATH = process.env.ONLINE_RECHARGE_FFMPEG_PATH || 'ffmpeg';
  let browser,
    externalRequests = 0;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-background-networking',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'
      ]
    });
    for (const kind of ['transition', 'finite-animation', 'infinite-animation']) {
      await t.test(kind, { timeout: 20000 }, async () => {
        const context = await browser.newContext({ viewport: { width: 400, height: 240 } });
        await context.route('**/*', (route) => {
          externalRequests++;
          return route.abort('blockedbyclient');
        });
        try {
          const page = await context.newPage();
          await page.setContent(`<style>
            body{margin:8px;background:white}
            #motion{width:30px;height:20px;background:blue}
            #motion.transition{transition:width 300s linear}
            #motion.finite-animation{animation:checkout-motion 300s linear 1}
            #motion.infinite-animation{animation:checkout-motion 300s linear infinite}
            @keyframes checkout-motion{from{transform:translateX(0)}to{transform:translateX(100px)}}
            iframe{width:320px;height:80px}
          </style>
          <div id="motion"></div>
          <iframe id="payment-frame" srcdoc="&lt;input id='synthetic-card-number' autocomplete='cc-number' value='4242424242424242'&gt;"></iframe>`);
          await page.frameLocator('#payment-frame').locator('#synthetic-card-number').waitFor();
          await page.evaluate(async (animationKind) => {
            const motion = document.getElementById('motion');
            const paymentFrame = document.getElementById('payment-frame');
            window.syntheticLifecycleEvents = [];
            for (const event of [
              'transitionend',
              'transitioncancel',
              'animationend',
              'animationcancel'
            ]) {
              motion.addEventListener(event, () => {
                window.syntheticLifecycleEvents.push(event);
                paymentFrame.hidden = true;
              });
            }
            motion.className = animationKind;
            // Start a real transition after its initial style has been resolved.
            if (animationKind === 'transition') {
              const initialWidth = motion.getBoundingClientRect().width;
              motion.style.width = `${initialWidth + 100}px`;
            }
            await new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve))
            );
          }, kind);
          const state = () =>
            page.evaluate(() => ({
              events: [...window.syntheticLifecycleEvents],
              hidden: document.getElementById('payment-frame').hidden,
              animationStates: document.getAnimations().map((animation) => animation.playState),
              maskMarkers: document.querySelectorAll('[data-online-recharge-secret-mask]').length
            }));
          const before = await state();
          assert.deepEqual(before.events, []);
          assert.deepEqual(before.animationStates, ['running']);
          assert.equal(before.hidden, false);
          await media.start();
          const screenshot = await media.screenshot(page, `animation-${kind}`);
          const afterScreenshot = await state();
          const files = await media.finish();
          const afterFinish = await state();
          assert.ok(screenshot, 'recording must capture a real masked PNG');
          assert.ok(files.includes(screenshot));
          assert.ok(
            files.some((file) => file.endsWith('.webm')),
            'recording must finish encoding'
          );
          for (const [phase, observed] of [
            ['screenshot', afterScreenshot],
            ['finish', afterFinish]
          ]) {
            assert.deepEqual(observed.events, [], `${phase} must not advance or cancel animations`);
            assert.equal(observed.hidden, false, `${phase} must not hide the payment frame`);
            assert.deepEqual(observed.animationStates, ['running']);
            assert.equal(observed.maskMarkers, 0, `${phase} must clean temporary masking markers`);
          }
          assert.equal(
            await page.frameLocator('#payment-frame').locator('#synthetic-card-number').isVisible(),
            true
          );
        } finally {
          await media.finish();
          await context.close();
        }
      });
    }
    assert.equal(externalRequests, 0);
  } finally {
    try {
      await media.finish();
      await browser?.close();
    } finally {
      for (const [key, value] of Object.entries(originalEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
});
