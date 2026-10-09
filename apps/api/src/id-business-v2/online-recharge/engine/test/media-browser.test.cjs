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
test('isolated Chromium masks actual input/session/PAN/CVC/email/iframe pixels and encodes safe video', async () => {
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
    const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    await context.route('**/*', (route) => {
      blocked++;
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    await page.setContent(`<style>body{font:18px sans-serif;background:white}.secret{display:block;width:600px;height:42px;margin:14px;box-sizing:border-box}input,textarea,iframe{border:1px solid #ccc}</style>
      <div id="normal" class="secret">合成隔离页面：所有内容仅为测试资料</div>
      <input id="card" class="secret" value="4242424242424242">
      <textarea id="session" class="secret">synthetic_session_token_for_mask_test_only</textarea>
      <input id="cvc" class="secret" value="123">
      <div id="pan" class="secret">4242 4242 4242 4242</div>
      <div id="cvcText" class="secret">安全码：123</div>
      <div id="email" class="secret">synthetic@example.invalid</div>
      <div id="token" class="secret">synthetic_opaque_token_abcdefghijklmnop</div>
      <iframe id="frame" class="secret" srcdoc="&lt;input value='123'&gt;"></iframe>`);
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
      'normal'
    ])
      boxes[id] = await page.locator(`#${id}`).boundingBox();
    await media.start();
    const first = await media.screenshot(page, 'masked-real-page');
    const pixels = readPixels(await fs.readFile(first));
    for (const id of ['card', 'session', 'cvc', 'pan', 'cvcText', 'email', 'token', 'frame']) {
      const box = boxes[id];
      assert.deepEqual(
        pixels(box.x + box.width / 2, box.y + box.height / 2),
        [20, 34, 56],
        `${id} must be fully masked`
      );
    }
    const normal = boxes.normal;
    assert.notDeepEqual(
      pixels(normal.x + normal.width / 2, normal.y + normal.height / 2),
      [20, 34, 56]
    );
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
          maskedFields: Object.keys(boxes).filter((id) => id !== 'normal'),
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
