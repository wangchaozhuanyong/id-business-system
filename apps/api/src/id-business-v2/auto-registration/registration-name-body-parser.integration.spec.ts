import { Body, Controller, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureRegistrationNameImportBodyParser } from './registration-name-body-parser';

@Controller()
class ImportBodyTestController {
  @Post(['id-business-v2/auto-registration/names/import', 'body-limit-test'])
  import(@Body() body: { names: string[] }) {
    return { count: body.names.length, first: body.names[0], last: body.names.at(-1) };
  }
}

describe('注册名字导入 HTTP 请求大小', () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  const names = Array.from(
    { length: 2000 },
    (_, index) => String(index).padStart(4, '0') + '名'.repeat(116)
  );
  const body = JSON.stringify({ names });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ImportBodyTestController]
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureRegistrationNameImportBodyParser(app);
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('2000 个各 120 字符的中文名字能够完整通过 HTTP 解析', async () => {
    expect(Buffer.byteLength(body)).toBeGreaterThan(100 * 1024);
    const response = await fetch(`${baseUrl}/api/id-business-v2/auto-registration/names/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      count: 2000,
      first: names[0],
      last: names.at(-1)
    });
  });

  it('其他接口仍保留默认大小限制，正常 JSON 请求可用', async () => {
    const response = await fetch(`${baseUrl}/api/body-limit-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });
    expect(response.status).toBe(413);
    const small = await fetch(`${baseUrl}/api/body-limit-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: ['测试名字'] })
    });
    expect(small.status).toBe(201);
    await expect(small.json()).resolves.toEqual({ count: 1, first: '测试名字', last: '测试名字' });
  });

  it('导入接口超过 1MB 的请求仍被拒绝', async () => {
    const response = await fetch(`${baseUrl}/api/id-business-v2/auto-registration/names/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: ['名'.repeat(400000)] })
    });
    expect(response.status).toBe(413);
  });
});
