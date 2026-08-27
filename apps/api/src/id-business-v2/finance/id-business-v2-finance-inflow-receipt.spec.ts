import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  decryptFinanceInflowReceipt,
  prepareFinanceInflowReceipt
} from './id-business-v2-finance-inflow-receipt';

describe('finance inflow receipt', () => {
  const encryption = {
    encrypt: vi.fn((value: string) => `encrypted:${value}`),
    decrypt: vi.fn((value: string) => value.replace('encrypted:', ''))
  };

  it('accepts a signed PDF and verifies the decrypted hash and size', () => {
    const buffer = Buffer.from('%PDF-1.7\nreceipt');
    const prepared = prepareFinanceInflowReceipt(
      {
        originalname: '../收款凭证.pdf',
        mimetype: 'application/pdf',
        size: buffer.length,
        buffer
      },
      encryption as never
    );

    expect(prepared).toEqual(
      expect.objectContaining({
        originalName: '收款凭证.pdf',
        mimeType: 'application/pdf',
        sizeBytes: BigInt(buffer.length),
        contentSha256: createHash('sha256').update(buffer).digest('hex')
      })
    );
    expect(
      decryptFinanceInflowReceipt(
        {
          contentEncrypted: prepared!.contentEncrypted,
          contentSha256: prepared!.contentSha256,
          sizeBytes: prepared!.sizeBytes
        },
        encryption as never
      )
    ).toEqual(buffer);
  });

  it('rejects a spoofed file whose MIME type does not match its signature', () => {
    const buffer = Buffer.from('not-a-pdf');
    expect(() =>
      prepareFinanceInflowReceipt(
        {
          originalname: 'fake.pdf',
          mimetype: 'application/pdf',
          size: buffer.length,
          buffer
        },
        encryption as never
      )
    ).toThrow(BadRequestException);
  });

  it('rejects decrypted content whose hash no longer matches', () => {
    const content = Buffer.from('%PDF-1.7\nreceipt');
    expect(() =>
      decryptFinanceInflowReceipt(
        {
          contentEncrypted: `encrypted:${content.toString('base64')}`,
          contentSha256: '0'.repeat(64),
          sizeBytes: BigInt(content.length)
        },
        encryption as never
      )
    ).toThrow(ConflictException);
  });
});
