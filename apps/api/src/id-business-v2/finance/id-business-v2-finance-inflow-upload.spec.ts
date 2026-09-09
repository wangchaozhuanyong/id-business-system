import {
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
  type INestApplication,
  type NestInterceptor,
  type Type
} from '@nestjs/common';
import { INTERCEPTORS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IdBusinessV2FinanceController } from './id-business-v2-finance.controller';
import {
  FINANCE_INFLOW_RECEIPT_MAX_BYTES,
  type FinanceInflowReceiptUpload
} from './id-business-v2-finance-inflow-receipt';

// Exercise the production upload interceptor without database writes or production credentials.
const receiptInterceptors = Reflect.getMetadata(
  INTERCEPTORS_METADATA,
  IdBusinessV2FinanceController.prototype.createInflow
) as Type<NestInterceptor>[];

@Controller('receipt')
class ReceiptFixtureController {
  @Post()
  @UseInterceptors(...receiptInterceptors)
  receive(@UploadedFile() file?: FinanceInflowReceiptUpload) {
    return { name: file?.originalname, bytes: file?.buffer.length, type: file?.mimetype };
  }
}

describe('finance receipt multipart compatibility', () => {
  let app: INestApplication;
  let url: string;
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ReceiptFixtureController]
    }).compile();
    app = module.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    url = (await app.getUrl()) + '/receipt';
  });
  afterAll(async () => {
    await app?.close();
  });
  const upload = (bytes = 32, count = 1) => {
    const body = new FormData();
    for (let index = 0; index < count; index += 1)
      body.append(
        'receipt',
        new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }),
        'receipt.pdf'
      );
    return fetch(url, { method: 'POST', body });
  };
  it('preserves normal in-memory receipt uploads', async () => {
    const response = await upload();
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      name: 'receipt.pdf',
      bytes: 32,
      type: 'application/pdf'
    });
  });
  it('rejects files over 5 MB and remains available for a subsequent upload', async () => {
    expect((await upload(FINANCE_INFLOW_RECEIPT_MAX_BYTES + 1)).status).toBe(413);
    expect((await upload()).status).toBe(201);
  });
  it('rejects multiple receipts and remains available for a subsequent upload', async () => {
    expect((await upload(32, 2)).status).toBe(400);
    expect((await upload()).status).toBe(201);
  });
});
