import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { normalizeMediaInput } from '../server/tools/media-resolver.mjs';
import { initializeLocalAdmin } from '../server/local-auth.mjs';
import { startPreview } from '../server/preview.mjs';

test('media inputs keep the original platform and engine allowlist', () => {
  assert.deepEqual(normalizeMediaInput('看这个 https://v.douyin.com/fiction/！'), {
    platform: 'douyin', engine: 'f2', url: 'https://v.douyin.com/fiction/'
  });
  assert.equal(normalizeMediaInput('https://youtu.be/example').engine, 'yt-dlp');
  assert.throws(() => normalizeMediaInput('https://douyin.com.example.test/a'), /暂不支持/);
  assert.throws(() => normalizeMediaInput('https://name:secret@douyin.com/video'), /格式无效/);
  assert.throws(() => normalizeMediaInput('http://127.0.0.1/video'), /暂不支持/);
});

test('preview media uses unified login, preserves media groups and authorizes each download', async (t) => {
  const runtime = fileURLToPath(new URL('../.runtime/', import.meta.url));
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const fixture = await mkdtemp(join(runtime, 'media-test-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const authPath = join(fixture, 'auth.json');
  const password = 'test-only-media-fixture';
  await initializeLocalAdmin(authPath, { email: 'media-test@example.test', name: '测试', password });
  const workerToken = 'a'.repeat(43);
  const calls = [];
  const { server, url } = await startPreview(0, {
    databasePath: ':memory:', authPath, mediaResolverUrl: 'http://127.0.0.1:56789',
    mediaFetch: async (target, options) => {
      assert.equal(options.redirect, 'error');
      const body = JSON.parse(options.body);
      calls.push(body);
      if (target.endsWith('/resolve')) return Response.json({
        title: '合成作品', author: '合成作者', mediaType: 'video',
        options: [
          { mediaType: 'video', extension: 'mp4', label: '高清', formatId: 'video', workerToken },
          { mediaType: 'audio', extension: 'm4a', label: '原声', formatId: 'audio', workerToken },
          { mediaType: 'image', extension: 'jpg', label: '图片', formatId: 'image:0', workerToken }
        ]
      });
      assert.match(target, /\/download$/);
      assert.equal(body.workerToken, workerToken);
      return new Response('test-media', { headers: { 'Content-Length': '10' } });
    }
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = new URL(url).origin;
  const post = (path, body, cookie, requestOrigin = origin) => fetch(url + path, {
    method: 'POST', headers: {
      'Content-Type': 'application/json', Origin: requestOrigin, ...(cookie && { Cookie: cookie })
    },
    body: JSON.stringify(body)
  });
  const login = async (email, loginPassword) => {
    const response = await post('api/local/auth/login', { email, password: loginPassword });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';', 1)[0];
  };
  const resolvePath = 'api/local/tools/media/resolve';
  const share = { url: '公开作品 https://v.douyin.com/fiction/' };
  assert.equal((await post(resolvePath, share)).status, 401);
  const cookie = await login('media-test@example.test', password);
  assert.equal((await post(resolvePath, share, cookie, 'http://example.test')).status, 403);
  assert.equal(calls.length, 0);
  const result = await post(resolvePath, share, cookie);
  assert.equal(result.status, 200);
  const resultText = await result.text();
  assert.ok(!resultText.includes(workerToken));
  const media = JSON.parse(resultText);
  assert.deepEqual(media.options.map((item) => item.mediaType), ['video', 'audio', 'image']);
  assert.deepEqual(calls[0], { engine: 'f2', platform: 'douyin', url: 'https://v.douyin.com/fiction/' });
  const download = url + 'api/local/tools/media/download?token=' + media.options[1].downloadToken;
  assert.equal((await fetch(download)).status, 401);
  const employeePassword = 'test-only-second-media-user';
  const added = await post('api/local/auth/employees', {
    email: 'another-media-test@example.test', name: '另一个测试用户', password: employeePassword, role: 'employee'
  }, cookie);
  assert.ok(added.ok);
  const another = await login('another-media-test@example.test', employeePassword);
  assert.equal((await fetch(download, { headers: { Cookie: another } })).status, 403);
  const file = await fetch(download, { headers: { Cookie: cookie } });
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-disposition'), /attachment; filename="media.m4a"/);
  assert.equal(await file.text(), 'test-media');
  assert.equal(calls.length, 2);
});
